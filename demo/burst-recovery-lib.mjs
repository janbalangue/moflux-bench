import { buildTrace, traceHash } from "../load/trace-lib.mjs";
import { VLLM_METAL_LONG_CONTEXT_WORKLOAD } from "./vllm-contention-lib.mjs";
import { summarizeAdmissionProvenance } from "./admission-provenance-lib.mjs";
import { summarizeOriginalBorrowers, summarizeBurstEnginePressure } from "./burst-recovery-diagnostics-lib.mjs";

export const BURST_PROTOCOL = "burst-recovery-v3";
export const BURST_PROTOCOLS = Object.freeze(["burst-recovery-v1", "burst-recovery-v2", BURST_PROTOCOL]);
export const BURST_VARIANTS = Object.freeze({ short: 64, long: 192 });
export const BURST_WORKLOAD = Object.freeze({
  ...VLLM_METAL_LONG_CONTEXT_WORKLOAD,
  durationMs: 155_000,
  interactiveResumeDurationMs: 90_000, interactiveResumeRps: 1,
  batchDurationMs: 125_000, batchRps: 0.5,
});
export function burstWorkload(protocol = BURST_PROTOCOL) {
  if (!BURST_PROTOCOLS.includes(protocol)) throw new Error("unsupported burst recovery protocol");
  return protocol === BURST_PROTOCOL ? BURST_WORKLOAD : {
    ...BURST_WORKLOAD, durationMs: 105_000, interactiveResumeDurationMs: 40_000, batchDurationMs: 75_000,
  };
}
const finite = (n) => typeof n === "number" && Number.isFinite(n);
const SLO_TTFT_MS = 5_000;
const SLO_LATENCY_MS = 30_000;
const median = (values) => {
  const a = values.filter(finite).sort((x, y) => x - y);
  return a.length ? (a[Math.floor((a.length - 1) / 2)] + a[Math.floor(a.length / 2)]) / 2 : null;
};
const idFor = (id) => `moflux-bench-${id}-a1`;
const setupIds = [1, 2, 3].map((i) => idFor(`batch-setup-${i}`));
const burstIds = [1, 2].map((i) => idFor(`interactive-burst-${i}`));

export function burstTrace(seed, variant, protocol = BURST_PROTOCOL) {
  if (!BURST_PROTOCOLS.includes(protocol)) throw new Error("unsupported burst recovery protocol");
  if (!Object.hasOwn(BURST_VARIANTS, variant)) throw new Error("burst variant must be short or long");
  const base = buildTrace({ ...burstWorkload(protocol), seed });
  const entry = (id, cls, arrivalMs, extra = {}) => ({ id, class: cls, arrivalMs,
    retryJitter: [1], targetSlots: [0], providerSeeds: [seed], ...extra });
  const entries = base.entries.filter((e) => e.class === "interactive" && e.arrivalMs < 25_000);
  // V1 let the batch floor expire before setup and left prefill too near return.
  // V2 primes demand just before the owned request, then staggers prefill earlier.
  const legacy = protocol === "burst-recovery-v1";
  entries.push(entry("batch-prime-1", "batch", legacy ? 25_000 : 41_000,
    legacy ? {} : { inputChars: 400, maxTokens: 1 }));
  for (let i = 1; i <= 3; i++) entries.push(entry(`batch-setup-${i}`, "batch", legacy ? 47_900 + i * 100 : 40_000 + i * 2_000,
    { maxTokens: i === 1 ? 64 : BURST_VARIANTS[variant] }));
  for (let i = 1; i <= 2; i++) entries.push(entry(`interactive-burst-${i}`, "interactive", 60_000));
  // A seed affects the stagger, never the simultaneous burst or treatment.
  const jitter = (i, cls) => ((seed * 31 + i * 17 + (cls === "batch" ? 73 : 0)) % 201) - 100;
  for (let i = 1; i < burstWorkload(protocol).interactiveResumeDurationMs / 1_000; i++) entries.push(entry(`interactive-steady-${i}`, "interactive",
    60_000 + i * 1_000 + jitter(i, "interactive")));
  for (let i = 1; i < burstWorkload(protocol).interactiveResumeDurationMs / 2_000; i++) entries.push(entry(`batch-steady-${i}`, "batch",
    60_000 + i * 2_000 + jitter(i, "batch")));
  entries.sort((a, b) => a.arrivalMs - b.arrivalMs || a.id.localeCompare(b.id));
  const trace = { ...base, entries, planned: {
    interactive: entries.filter((e) => e.class === "interactive").length,
    batch: entries.filter((e) => e.class === "batch").length, total: entries.length,
  } };
  return { ...trace, hash: traceHash(trace) };
}

export function normalizedBurstHash(trace) {
  return traceHash({ ...trace, entries: trace.entries.map((e) =>
    e.id.startsWith("batch-setup-") ? { ...e, maxTokens: 64 } : e) });
}

function provenanceFor(samples, arm) {
  const provenance = summarizeAdmissionProvenance(samples.map((s) => ({ observedAt: s.observedAt,
    replicas: [{ port: arm.port, [arm.pool]: { admissionProvenance: s.admissionProvenance } }],
  })), { pool: arm.pool });
  const baseline = samples[0]?.admissionProvenance?.nextSequence;
  const end = samples.at(-1)?.admissionProvenance?.nextSequence;
  const sequences = provenance.events.map((e) => e.sequence).sort((a, b) => a - b);
  const continuous = Number.isSafeInteger(baseline) && Number.isSafeInteger(end) && end >= baseline &&
    sequences.length === end - baseline && sequences.every((s, i) => s === baseline + i);
  return { ...provenance, complete: provenance.complete && continuous,
    sequenceContinuous: continuous, baselineNextSequence: baseline ?? null, finalNextSequence: end ?? null };
}

function clockDiagnostics(rows, field, timestampField) {
  const values = rows.map((s) => s[field]);
  const usable = values.filter(finite);
  const minErrorMs = usable.length ? Math.min(...usable) : null;
  const maxErrorMs = usable.length ? Math.max(...usable) : null;
  const rangeMs = usable.length ? maxErrorMs - minErrorMs : null;
  const timed = rows.filter((s) => finite(s[field]) && finite(s[timestampField]));
  const firstTime = timed.reduce((start, s) => Math.min(start, s[timestampField]), Infinity);
  const lastTime = timed.reduce((end, s) => Math.max(end, s[timestampField]), -Infinity);
  const duration = lastTime - firstTime;
  const captureDurationMs = timed.length && finite(duration) ? duration : null;
  let fittedDriftPpm = null;
  let residualRangeMs = null;
  if (timed.length >= 2 && captureDurationMs > 0) {
    // Center relative timestamps to avoid precision loss from epoch-sized values.
    // The fit is descriptive only: the existing raw 5ms range gate stays intact.
    const meanTime = timed.reduce((sum, s) => sum + (s[timestampField] - firstTime), 0) / timed.length;
    const meanError = timed.reduce((sum, s) => sum + s[field], 0) / timed.length;
    let timeVariance = 0;
    let covariance = 0;
    for (const s of timed) {
      const centeredTime = s[timestampField] - firstTime - meanTime;
      timeVariance += centeredTime * centeredTime;
      covariance += centeredTime * (s[field] - meanError);
    }
    const slope = timeVariance > 0 && finite(timeVariance) && finite(covariance) ? covariance / timeVariance : NaN;
    const driftPpm = slope * 1_000_000;
    if (finite(driftPpm)) {
      fittedDriftPpm = driftPpm;
      const residuals = timed.map((s) => s[field] - meanError - slope * (s[timestampField] - firstTime - meanTime));
      const residualRange = Math.max(...residuals) - Math.min(...residuals);
      residualRangeMs = finite(residualRange) ? residualRange : null;
    }
  }
  return { sampleCount: values.length, nonFiniteCount: values.length - usable.length,
    minErrorMs, maxErrorMs, rangeMs, maxRangeMs: 5,
    timestampField, timedSampleCount: timed.length, captureDurationMs, fittedDriftPpm, residualRangeMs,
    passed: values.length > 0 && usable.length === values.length && rangeMs <= 5 };
}

function transitionBracket(samples, predicate, fromEpoch) {
  const index = samples.findIndex((s) => s.epochMs >= fromEpoch && predicate(s));
  if (index < 0) return null;
  const current = samples[index];
  const previous = samples[index - 1];
  if (!previous || predicate(previous)) return null;
  return { lowerEpochMs: previous.sampleStartEpochMs, upperEpochMs: current.epochMs,
    grant: current.pool.grant ?? null };
}

function refillCounts(events, bracket, returnEpoch, horizon) {
  if (!bracket) return null;
  const relevant = events.filter((e) => e.atEpochMs >= returnEpoch && e.atEpochMs < horizon);
  return { definitelyBefore: relevant.filter((e) => e.atEpochMs < bracket.lowerEpochMs).length,
    withinBracket: relevant.filter((e) => e.atEpochMs >= bracket.lowerEpochMs && e.atEpochMs <= bracket.upperEpochMs).length,
    definitelyAfter: relevant.filter((e) => e.atEpochMs > bracket.upperEpochMs).length };
}

function summaryOutcomes(rows) {
  const rejected = (o) => o.httpStatus === 429 || (o.httpStatus === 504 && o.admissionReason === "timeout");
  const completed = rows.filter((o) => o.outcome === "completed");
  const misses = completed.filter((o) => !o.sloMet);
  const knownMisses = misses.filter((o) => finite(o.ttftMs) && finite(o.latencyMs));
  const summary = { offered: rows.length, completed: completed.length,
    rejected: rows.filter(rejected).length,
    censored: rows.filter((o) => o.outcome === "censored").length,
    failed: rows.filter((o) => o.outcome === "failed" && !rejected(o)).length,
    missing: rows.filter((o) => o.outcome === "missing").length,
    sloMet: rows.filter((o) => o.sloMet).length };
  return { ...summary,
    rejectionReasons: Object.fromEntries([...new Set(rows.filter(rejected).map((o) => o.admissionReason ?? "unknown"))]
      .sort().map((reason) => [reason, rows.filter((o) => rejected(o) && (o.admissionReason ?? "unknown") === reason).length])),
    sloMetShareOfCompleted: completed.length ? summary.sloMet / completed.length : null,
    // Mutually exclusive completed-request reasons. Failures, censored and
    // missing outcomes stay separate from measured latency threshold misses.
    sloMisses: { total: rows.length - summary.sloMet, rejected: summary.rejected,
      completed: { total: misses.length,
        ttftOnly: knownMisses.filter((o) => o.ttftMs > SLO_TTFT_MS && o.latencyMs <= SLO_LATENCY_MS).length,
        latencyOnly: knownMisses.filter((o) => o.ttftMs <= SLO_TTFT_MS && o.latencyMs > SLO_LATENCY_MS).length,
        both: knownMisses.filter((o) => o.ttftMs > SLO_TTFT_MS && o.latencyMs > SLO_LATENCY_MS).length,
        missingTiming: misses.length - knownMisses.length },
      failed: summary.failed, censored: summary.censored, missing: summary.missing } };
}

/** Pure, fail-closed trial analysis. Validity is independent of favorable outcomes. */
export function analyzeBurstTrial({ seed, variant, trace, loadgen, managed, backendEvents, arm, armSummary, protocol = BURST_PROTOCOL }) {
  const samples = (managed?.samples ?? []).map((s) => ({ ...s,
    epochMs: Date.parse(s.observedAt),
    sampleStartEpochMs: Date.parse(s.observedAt) - (s.offsetMs - s.sampleStartedAtMs),
  })).sort((a, b) => a.epochMs - b.epochMs);
  const attempts = ["interactive", "batch"].flatMap((cls) => loadgen?.classes?.[cls]?.attemptSamples ?? []);
  const attemptById = new Map(attempts.map((a) => [a.requestId, a]));
  const burst = burstIds.map((id) => attemptById.get(id) ?? null);
  const returnedAt = burst.every((a) => finite(a?.sentAtEpochMs)) ? Math.min(...burst.map((a) => a.sentAtEpochMs)) : null;
  const arrivalWindowMs = burstWorkload(protocol).interactiveResumeDurationMs;
  const arrivalEndMs = 60_000 + arrivalWindowMs;
  const horizon = finite(loadgen?.startedAtEpochMs) ? loadgen.startedAtEpochMs + arrivalEndMs : null;
  const provenance = provenanceFor(managed?.samples ?? [], arm);
  const byAdmission = new Map(provenance.events.map((e) => [e.admissionId, e]));
  const setup = setupIds.map((requestId) => {
    const a = attemptById.get(requestId) ?? null;
    const event = byAdmission.get(a?.admissionId);
    const pressure = backendEvents.filter((e) => e.event === "pressure" &&
      e.atEpochMs >= returnedAt && Array.isArray(e.runningRequestIds));
    const lastRunning = pressure.filter((e) => e.runningRequestIds.includes(requestId)).at(-1);
    const firstAbsent = lastRunning && pressure.find((e) => e.atEpochMs > lastRunning.atEpochMs &&
      !e.runningRequestIds.includes(requestId));
    return { requestId, attempt: a, admission: event ?? null,
      remainingStreamMs: a?.outcome === "completed" && finite(returnedAt) && finite(a.endedAtEpochMs)
        ? a.endedAtEpochMs - returnedAt : null,
      runningExitBracket: firstAbsent ? { lowerEpochMs: lastRunning.atEpochMs, upperEpochMs: firstAbsent.atEpochMs } : null };
  });
  const pressureAtReturn = backendEvents.filter((e) => e.event === "pressure" && finite(returnedAt) &&
    e.atEpochMs < returnedAt && e.atEpochMs >= returnedAt - 500).at(-1);
  const poolAtReturn = samples.filter((s) => finite(returnedAt) && s.epochMs < returnedAt &&
    s.sampleStartEpochMs >= returnedAt - 500).at(-1);
  const borrowedEvents = provenance.events.filter((e) => e.admissionClass === "batch" &&
    e.resources?.borrowedConcurrency === true).map((e) => ({ ...e, atEpochMs: Date.parse(e.admittedAt) }));
  const recognition = finite(returnedAt) ? transitionBracket(samples,
    (s) => ["demanding", "protected"].includes(s.classes?.interactive?.demandState), returnedAt) : null;
  const restoration = finite(returnedAt) ? transitionBracket(samples,
    (s) => s.classes?.interactive?.limits?.protectedConcurrent >= 3, returnedAt) : null;
  const returnSamples = samples.filter((s) => finite(returnedAt) && s.epochMs >= returnedAt && s.epochMs < horizon);
  // Require coverage through the end of the offered-demand window.
  const endpoint = finite(horizon) ? samples.find((s) => s.epochMs >= horizon) : null;
  const occupancy = endpoint ? [...returnSamples, endpoint] : returnSamples;
  const zeroIndex = finite(returnedAt) && finite(horizon) ? occupancy.findIndex((s, i) => s.classes?.batch?.borrowedConcurrent === 0 &&
    occupancy.slice(i).every((later) => later.classes?.batch?.borrowedConcurrent === 0)) : -1;
  const zero = zeroIndex >= 0 && endpoint ? occupancy[zeroIndex] : null;
  const zeroPrevious = zeroIndex > 0 ? occupancy[zeroIndex - 1] : poolAtReturn;
  const offered = trace.entries.filter((e) => e.class === "interactive" && e.arrivalMs >= 60_000 && e.arrivalMs < arrivalEndMs);
  const outcomes = offered.map((e) => {
    const a = attemptById.get(idFor(e.id));
    const ttftMs = finite(a?.firstTokenAtMs) ? a.firstTokenAtMs - a.sentAtMs : null;
    const latencyMs = finite(a?.endedAtMs) ? a.endedAtMs - a.sentAtMs : null;
    return { requestId: idFor(e.id), plannedArrivalMs: e.arrivalMs, ...(a ?? { outcome: "missing" }),
      ttftMs, latencyMs, sloMet: a?.outcome === "completed" && finite(ttftMs) && finite(latencyMs) &&
        ttftMs <= SLO_TTFT_MS && latencyMs <= SLO_LATENCY_MS,
      admission: byAdmission.get(a?.admissionId) ?? null,
      enqueued: backendEvents.find((b) => b.event === "enqueued" && b.requestId === idFor(e.id)) ?? null,
      firstScheduled: backendEvents.find((b) => b.event === "first_scheduled" && b.requestId === idFor(e.id)) ?? null };
  });
  const gates = [];
  const gate = (name, passed, observed = null) => gates.push({ name, passed: passed === true, observed });
  gate("traceMatchesProtocol", trace.hash === burstTrace(seed, variant, protocol).hash && trace.hash === traceHash(trace) &&
    loadgen?.trace?.hash === trace.hash);
  gate("allAttemptsRecorded", attempts.length === trace.entries.length && new Set(attempts.map((a) => a.requestId)).size === attempts.length &&
    trace.entries.every((e) => attemptById.has(idFor(e.id))) && attempts.every((a) => finite(a.sentAtEpochMs) && finite(a.endedAtEpochMs)));
  gate("simultaneousBurst", finite(returnedAt) && Math.max(...burst.map((a) => a.sentAtEpochMs)) - returnedAt <= 25 &&
    burst.every((a) => finite(a.sentAtMs) && Math.abs(a.sentAtMs - 60_000) <= 250),
    burst.map((a) => a?.sentAtEpochMs ?? null));
  gate("threeSetupRequestsRunning", setupIds.every((id) => pressureAtReturn?.runningRequestIds?.includes(id)), pressureAtReturn ?? null);
  gate("twoBorrowedSlotsOccupied", poolAtReturn?.classes?.batch?.inFlight === 3 &&
    poolAtReturn.classes.batch.borrowedConcurrent === 2 && poolAtReturn.classes.interactive?.inFlight === 0 &&
    poolAtReturn.classes.interactive?.limits?.protectedConcurrent === 1 && poolAtReturn.pool.maxConcurrent === 4,
    poolAtReturn ?? null);
  if (protocol !== "burst-recovery-v1") {
    const prime = attemptById.get(idFor("batch-prime-1"));
    const owned = setup[0];
    const admittedAt = Date.parse(owned?.admission?.admittedAt);
    const ready = samples.filter((s) => s.epochMs < admittedAt && s.sampleStartEpochMs >= admittedAt - 500).at(-1);
    gate("batchFloorReadyBeforeSetup", prime?.outcome === "completed" && prime.outputTokensReported === true &&
      prime.outputTokens === 1 && prime.endedAtEpochMs < owned?.attempt?.sentAtEpochMs &&
      ready?.classes?.batch?.inFlight === 0 && ready.classes.batch.limits?.protectedConcurrent === 1 &&
      owned?.admission?.limits?.admissionClasses?.batch?.protectedConcurrent === 1,
      { primeEndedAtEpochMs: prime?.endedAtEpochMs ?? null, setupAdmittedAtEpochMs: finite(admittedAt) ? admittedAt : null,
        sampledBatchFloor: ready?.classes?.batch?.limits?.protectedConcurrent ?? null });
  }
  gate("exactBorrowAttribution", setup[0]?.admission?.resources?.borrowedConcurrency === false &&
    setup.slice(1).every((s) => s.admission?.resources?.borrowedConcurrency === true));
  gate("setupCompletionAndLength", setup.every((s) => s.attempt?.outcome === "completed" &&
    s.attempt.outputTokensReported === true && s.attempt.outputTokens === (s.requestId === setupIds[0] ? 64 : BURST_VARIANTS[variant]) && s.remainingStreamMs > 0));
  gate("provenanceComplete", provenance.complete && provenance.events.every((e) => finite(Date.parse(e.admittedAt)) &&
    e.grant?.grantId && typeof e.resources?.borrowedConcurrency === "boolean"),
    { complete: provenance.complete, sequenceContinuous: provenance.sequenceContinuous, reason: provenance.reason });
  const clocks = {
    managed: clockDiagnostics(samples, "clockErrorMs", "epochMs"),
    backend: clockDiagnostics(backendEvents.filter((e) => e.event !== "installed"), "clockErrorMs", "atEpochMs"),
    loadgen: { backendClockErrorMs: finite(loadgen?.backendClockErrorMs) ? loadgen.backendClockErrorMs : null,
      maxAbsoluteErrorMs: 5, passed: finite(loadgen?.backendClockErrorMs) && Math.abs(loadgen.backendClockErrorMs) <= 5 },
  };
  const failedSources = Object.keys(clocks).filter((source) => !clocks[source].passed);
  gate("clockStable", failedSources.length === 0, { ...clocks, failedSources });
  // Check the same coverage used for sustained occupancy, including the final
  // endpoint. An existing endpoint alone cannot close an unobserved tail gap.
  const samplerIntegrity = finite(returnedAt) && finite(horizon) && horizon > returnedAt &&
    samples.length > 2 && (managed?.errors?.length ?? 1) === 0 && endpoint != null &&
    occupancy.every((s, i) => s.epochMs - (i ? occupancy[i - 1].epochMs : returnedAt) <= 750);
  const samplingGaps = occupancy.map((s, i) => {
    const lowerEpochMs = i ? occupancy[i - 1].epochMs : returnedAt;
    return { lowerEpochMs, upperEpochMs: s.epochMs, gapMs: s.epochMs - lowerEpochMs };
  });
  gate("samplerIntegrity", samplerIntegrity, {
    sampleCount: samples.length, returnWindowSampleCount: returnSamples.length,
    endpointObserved: endpoint != null, errorCount: managed?.errors?.length ?? null,
    maxAllowedGapMs: 750,
    maxGapMs: samplingGaps.length ? Math.max(...samplingGaps.map((g) => g.gapMs)) : null,
    gapsOverLimit: samplingGaps.filter((g) => g.gapMs > 750),
  });
  gate("observerInstalled", backendEvents.some((e) => e.event === "installed" && e.schemaVersion === 3 && e.schedulerSourceSha256));
  gate("runtimeAndEngine", armSummary?.runtimeIdentity?.schedulingPolicy === "priority" &&
    armSummary.vllm?.cacheConfig?.numGpuBlocks === 320 && armSummary.vllm.cacheConfig?.blockSize === 16);
  gate("generatorHeadroom", loadgen?.generatorSaturated === 0);
  gate("healthyRequestPath", ["interactive", "batch"].every((c) => {
    const s = loadgen?.classes?.[c];
    return s && ["serverError", "transportError", "requestError", "upstreamReject"].every((key) => s[key] === 0) &&
      s.localRejectGrantUnavailable != null && Object.values(s.localRejectGrantUnavailable).every((n) => n === 0);
  }));
  gate("allSuccessfulAdmissionsAttributed", attempts.filter((a) => a.httpStatus >= 200 && a.httpStatus < 300).every((a) =>
    typeof a.admissionId === "string" && byAdmission.has(a.admissionId)));
  gate("nativeUnlentFloor", samples.every((s) => s.classes?.interactive?.limits?.protectedConcurrent >= 1 &&
    s.classes?.batch?.inFlight <= 3 && s.pool?.maxConcurrent === 4));
  gate("hostAndEngineTelemetry", (armSummary?.vllm?.scrapeErrors?.length ?? 1) === 0 &&
    (armSummary.vllm.missingRequiredMetrics?.length ?? 1) === 0 && armSummary.hostProcess?.sampleCount > 0 &&
    (armSummary.hostProcess.errors?.length ?? 1) === 0 && armSummary.hostPressure?.sampleCount > 0 &&
    (armSummary.hostPressure.errors?.length ?? 1) === 0 && armSummary.hostPressure.pressureSamples?.critical === 0 &&
    finite(armSummary.hostPressure.swapoutMiBDuringArm) && armSummary.hostPressure.swapoutMiBDuringArm <= 256);
  const missingSendCount = outcomes.filter((o) => !finite(o.sentAtEpochMs)).length;
  const afterZeroObservable = samplerIntegrity && zero != null && missingSendCount === 0;
  const diagnostics = {
    schemaVersion: 1,
    interpretation: "Descriptive observations; analysis.valid and the original validity gates still apply. Accounting zero is not service recovery or physical reclamation.",
    afterSustainedZeroBorrowed: {
      status: !samplerIntegrity || missingSendCount ? "inconclusive" : zero ? "observed" : "right_censored",
      selection: "Return-cohort actual sends at or after the accounting-zero upper bound and before the arrival horizon.",
      missingSendCount,
      startEpochMs: afterZeroObservable ? zero.epochMs : null,
      endEpochMs: finite(horizon) ? horizon : null,
      arrivalWindowMs: afterZeroObservable ? Math.max(0, horizon - zero.epochMs) : null,
      outcomes: afterZeroObservable ? summaryOutcomes(outcomes.filter((o) =>
        o.sentAtEpochMs >= zero.epochMs && o.sentAtEpochMs < horizon)) : null,
    },
    originalBorrowers: summarizeOriginalBorrowers({ setup, returnedAtEpochMs: returnedAt,
      accountingZeroEpochMs: zero?.epochMs ?? null }),
    enginePressure: summarizeBurstEnginePressure({ backendEvents, armSummary, setup,
      returnedAtEpochMs: returnedAt, horizonEpochMs: horizon }),
  };
  return { protocol, seed, variant, valid: gates.every((g) => g.passed), gates,
    traceHash: trace.hash, normalizedTraceHash: normalizedBurstHash(trace), returnedAtEpochMs: returnedAt,
    horizonEpochMs: horizon, remainingLifetimeMedianMs: median(setup.filter((s) => s.admission?.resources?.borrowedConcurrency === true).map((s) => s.remainingStreamMs)),
    setup, recognitionBracket: recognition, restorationBracket: restoration,
    borrowedAdmissionsAfterReturn: finite(returnedAt) && provenance.complete ? borrowedEvents.filter((e) =>
      e.atEpochMs >= returnedAt && e.atEpochMs < horizon) : null,
    borrowedAdmissionsByRecognition: provenance.complete ? refillCounts(borrowedEvents, recognition, returnedAt, horizon) : null,
    borrowedAdmissionsByRestoration: provenance.complete ? refillCounts(borrowedEvents, restoration, returnedAt, horizon) : null,
    sustainedZeroBorrowed: { status: !finite(returnedAt) || !endpoint ? "inconclusive" : zero ? "observed" : "right_censored",
      bracket: zero ? { lowerEpochMs: zeroPrevious?.sampleStartEpochMs ?? returnedAt, upperEpochMs: zero.epochMs } : null,
      upperDelayMs: zero ? zero.epochMs - returnedAt : null },
    initialBurst: summaryOutcomes(outcomes.filter((o) => burstIds.includes(o.requestId))),
    returnCohort: { ...summaryOutcomes(outcomes), arrivalWindowMs,
        sloGoodputRps: outcomes.every((o) => o.outcome !== "missing") ? outcomes.filter((o) => o.sloMet).length / (arrivalWindowMs / 1_000) : null }, diagnostics, outcomes, provenance };
}

export function burstPairPlan(seeds) {
  return seeds.map((seed, index) => ({ seed, order: index % 2 === 0 ? ["short", "long"] : ["long", "short"] }));
}

export function summarizeBurstPairs(plan, trials, { pilot = false, protocol = BURST_PROTOCOL } = {}) {
  const pairs = plan.map(({ seed, order }) => {
    const short = trials.find((t) => t.seed === seed && t.variant === "short");
    const long = trials.find((t) => t.seed === seed && t.variant === "long");
    const matched = Boolean(short?.analysis?.protocol === protocol && long?.analysis?.protocol === protocol && short?.analysis?.valid && long?.analysis?.valid && !short.error && !long.error &&
      short.analysis.normalizedTraceHash === long.analysis.normalizedTraceHash &&
      JSON.stringify(short.runtime) === JSON.stringify(long.runtime));
    const delta = (key) => matched && finite(short.analysis[key]) && finite(long.analysis[key])
      ? long.analysis[key] - short.analysis[key] : null;
    return { seed, order, matched, short: short ?? null, long: long ?? null,
      remainingLifetimeDeltaMs: delta("remainingLifetimeMedianMs"),
      sloGoodputDeltaRps: matched ? long.analysis.returnCohort.sloGoodputRps - short.analysis.returnCohort.sloGoodputRps : null,
      recoveryDelayDeltaMs: matched && finite(short.analysis.sustainedZeroBorrowed.upperDelayMs) && finite(long.analysis.sustainedZeroBorrowed.upperDelayMs)
        ? long.analysis.sustainedZeroBorrowed.upperDelayMs - short.analysis.sustainedZeroBorrowed.upperDelayMs : null };
  });
  const remainingLifetimeDeltaMedianMs = median(pairs.map((p) => p.remainingLifetimeDeltaMs));
  const runtimeStable = trials.length > 0 && new Set(trials.map((t) => JSON.stringify(t.runtime))).size === 1 && trials.every((t) => t.runtime);
  const allPairsMatched = runtimeStable && pairs.length > 0 && pairs.every((p) => p.matched) && trials.length === plan.length * 2;
  const manipulationPassed = allPairsMatched && remainingLifetimeDeltaMedianMs >= 5_000;
  const passed = !pilot && plan.length >= 5 && manipulationPassed;
  return { protocol, pilot, pairs, manipulation: { passed: manipulationPassed,
    requiredRemainingLifetimeDeltaMs: 5_000, remainingLifetimeDeltaMedianMs },
    proof: { passed, status: pilot ? "pilot" : passed ? "valid_exploratory_pairs" : "inconclusive",
      plannedPairs: plan.length, matchedPairs: pairs.filter((p) => p.matched).length, allPairsMatched, runtimeStable },
    passed, pairedMedians: { sloGoodputDeltaRps: median(pairs.map((p) => p.sloGoodputDeltaRps)),
      recoveryDelayDeltaMs: median(pairs.map((p) => p.recoveryDelayDeltaMs)) } };
}
