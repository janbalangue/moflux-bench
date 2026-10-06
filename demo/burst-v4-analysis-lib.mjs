import { BURST_CLOCK_LIMITS, analyzeClockSeries, analyzeClockAlignment } from "./burst-clock-lib.mjs";
import { summarizeBurstHostPreflight } from "./burst-host-preflight-lib.mjs";
import { BURST_PRIME_REQUEST_ID, BURST_SETUP_REQUEST_ID, burstSetupVerdict } from "../load/burst-replay-lib.mjs";

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const CONTAINERS = Object.freeze(["tyr", "latchflo"]);
export const BURST_V4_UNCERTAINTY_MS = BURST_CLOCK_LIMITS.uncertaintyBudgetMs;
export const BURST_CLOCK_PREFLIGHT_MS = 180_000;

/** Carry the timing budget into an observed bracket; keep what was observed. */
export function widenBracket(bracket, uncertaintyMs = BURST_V4_UNCERTAINTY_MS) {
  return bracket ? { ...bracket, lowerEpochMs: bracket.lowerEpochMs - uncertaintyMs,
    upperEpochMs: bracket.upperEpochMs + uncertaintyMs, observedLowerEpochMs: bracket.lowerEpochMs,
    observedUpperEpochMs: bracket.upperEpochMs, timingUncertaintyMs: uncertaintyMs } : null;
}

/**
 * The runner, load generator and scheduler probe read one host wall clock;
 * Tyr and Latchflo read the container clock. Host sources are checked for
 * steps and non-gradual drift, containers for bracketed alignment with the
 * host. Scheduler rows are themselves the paired readings, so their gaps are
 * reported, not gated: nothing is timestamped between two rows.
 */
export function burstV4ClockGates({ managed, loadgen, backendEvents, startEpochMs, endEpochMs, clientEndEpochMs }) {
  const timing = managed?.burstTiming;
  const coverage = { startEpochMs, endEpochMs };
  const clocks = {
    managed: analyzeClockSeries(timing?.clockSamples ?? [], coverage),
    // Each series vouches for its own source's timestamps: the load generator
    // stops reading its clock once its last request has ended.
    loadgen: analyzeClockSeries(loadgen?.clockSamples ?? [], { startEpochMs, endEpochMs: clientEndEpochMs }),
    backend: analyzeClockSeries(backendEvents ?? [], { ...coverage, epochField: "atEpochMs",
      spanField: "clockReadSpanMs", maxGapMs: null, clipToCoverage: true }),
    ...Object.fromEntries(CONTAINERS.map((name) =>
      [name, analyzeClockAlignment(timing?.clockAlignment?.[name] ?? [], coverage)])),
  };
  const failedSources = Object.keys(clocks).filter((key) => !clocks[key].passed);
  if (![startEpochMs, endEpochMs, clientEndEpochMs].every(finite)) failedSources.push("capture_bounds");
  const captureErrors = Array.isArray(timing?.errors) ? timing.errors : ["missing_capture"];
  if (captureErrors.length) failedSources.push("capture_errors");
  return { passed: failedSources.length === 0, failedSources, captureErrors,
    method: "paired wall/monotonic readings with bracketed container alignment; no offset is fitted or applied",
    uncertaintyMs: BURST_V4_UNCERTAINTY_MS, limits: BURST_CLOCK_LIMITS, window: { ...coverage, clientEndEpochMs }, ...clocks };
}

/** Recompute both preflights from their raw rows; a stored verdict is not evidence. */
export function burstV4Preflight(preflight, { requiredClockDurationMs = BURST_CLOCK_PREFLIGHT_MS } = {}) {
  const clock = preflight?.clock;
  const samples = Array.isArray(clock?.clockSamples) ? clock.clockSamples : [];
  const coverage = { startEpochMs: samples[0]?.epochMs, endEpochMs: samples.at(-1)?.epochMs };
  const sources = { host: analyzeClockSeries(samples, coverage),
    ...Object.fromEntries(CONTAINERS.map((name) =>
      [name, analyzeClockAlignment(clock?.clockAlignment?.[name] ?? [], coverage)])) };
  const errors = Array.isArray(clock?.errors) ? clock.errors : ["missing_capture"];
  // The requested wait and the usable paired readings must both span the full duration.
  const durationValid = finite(clock?.durationMs) && clock.durationMs >= requiredClockDurationMs &&
    sources.host.durationMs >= requiredClockDurationMs - BURST_CLOCK_LIMITS.maxGapMs;
  const failures = Object.fromEntries(Object.entries(sources).filter(([, source]) => !source.passed)
    .map(([name, source]) => [name, source.reasons]));
  if (!durationValid) failures.duration = ["full_duration_not_covered"];
  if (errors.length) failures.capture = errors;
  const clockPassed = Object.keys(failures).length === 0;
  const { observations, ...host } = summarizeBurstHostPreflight(preflight?.host);
  return { passed: clockPassed && host.passed,
    clock: { passed: clockPassed, requiredDurationMs: requiredClockDurationMs,
      durationMs: finite(clock?.durationMs) ? clock.durationMs : null, durationValid, failures, ...sources },
    host };
}

/** Explicit setup readiness: the load generator's checkpoint plus the exact Tyr grant. */
export function burstV4Setup({ loadgen, attemptById, admission }) {
  const prime = attemptById.get(BURST_PRIME_REQUEST_ID) ?? null;
  const first = attemptById.get(BURST_SETUP_REQUEST_ID) ?? null;
  const observations = loadgen?.burstSetup?.observations;
  const verdict = burstSetupVerdict({ observations, prime, setupSentAtEpochMs: first?.sentAtEpochMs });
  const admissionGrantBatchFloor = admission?.limits?.admissionClasses?.batch?.protectedConcurrent ?? null;
  // The live report must agree: a recomputed pass cannot overrule a reported miss.
  const reasons = [...verdict.reasons, ...(admissionGrantBatchFloor === 1 ? [] : ["setup_admission_grant_floor_not_one"]),
    ...(loadgen?.burstSetup?.status === "ready" ? [] : ["checkpoint_did_not_report_ready"])];
  return { method: "checkpoint", ready: reasons.length === 0, reasons,
    reportedStatus: loadgen?.burstSetup?.status ?? "missing",
    primeDurationMs: finite(prime?.endedAtEpochMs) && finite(prime?.sentAtEpochMs) ? prime.endedAtEpochMs - prime.sentAtEpochMs : null,
    primeEndedBeforeSetupMs: verdict.primeEndedBeforeSetupMs, observationAgeMs: verdict.observationAgeMs,
    observationCount: Array.isArray(observations) ? observations.length : 0,
    observation: verdict.observation, admissionGrantBatchFloor };
}
