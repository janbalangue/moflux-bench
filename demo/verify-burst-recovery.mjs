import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { analyzeBurstTrial, BURST_PROTOCOL, BURST_WORKLOAD, burstWorkload, burstTrace, normalizedBurstHash, burstPairPlan, summarizeBurstPairs } from "./burst-recovery-lib.mjs";
import { validateTrace } from "../load/trace-lib.mjs";
import { readBurstRun } from "./burst-recovery-run-lib.mjs";
import { summarizeOriginalBorrowers, summarizeBurstEnginePressure } from "./burst-recovery-diagnostics-lib.mjs";
import { waitForBurstHostReady } from "./burst-host-preflight-lib.mjs";
import { BURST_V4_UNCERTAINTY_MS } from "./burst-v4-analysis-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (let seed = 1; seed <= 5; seed++) {
  const short = burstTrace(seed, "short"), long = burstTrace(seed, "long");
  validateTrace(short, { ...BURST_WORKLOAD, seed }); validateTrace(long, { ...BURST_WORKLOAD, seed });
  assert.equal(normalizedBurstHash(short), normalizedBurstHash(long));
  assert.notEqual(short.hash, long.hash);
  assert.equal(long.entries.find((e) => e.id === "batch-setup-1").maxTokens, 64);
  assert.deepEqual(long.entries.filter((e) => /^batch-setup-[23]$/u.test(e.id)).map((e) => e.maxTokens), [192, 192]);
  assert.equal(short.entries.filter((e) => e.arrivalMs === 60_000).length, 2);
  assert.deepEqual(short.entries.filter((e) => e.id.startsWith("batch-setup-")).map((e) => e.arrivalMs), [42000, 44000, 46000]);
  assert.ok(short.entries.filter((e) => e.id.startsWith("interactive-steady-")).length === 89);
  assert.ok(long.entries.filter((e) => e.id.startsWith("batch-steady-")).every((e) => e.maxTokens === undefined));
}
assert.throws(() => burstTrace(1, "invalid"));
assert.throws(() => burstTrace(1, "short", "unknown"));
assert.equal(burstTrace(3, "short", "burst-recovery-v1").hash,
  "602c9e64a39bc9a3a2bff92e057eb4596818f5834d785bdd5262ac5c8bb71b21");
const prime = burstTrace(3, "short").entries.find((e) => e.id === "batch-prime-1");
assert.deepEqual([prime.arrivalMs, prime.inputChars, prime.maxTokens], [41000, 400, 1]);
// V4 changes measurement and start conditions, never the workload: its trace is v3's.
assert.equal(BURST_PROTOCOL, "burst-recovery-v4");
assert.equal(burstTrace(3, "short", "burst-recovery-v3").hash,
  "2e1229243a1bab3b7c07a354eb1a398d02c0f2b59ee4cd1855ce3126568fdf86");
for (const variant of ["short", "long"]) assert.equal(burstTrace(3, variant).hash, burstTrace(3, variant, "burst-recovery-v3").hash);

// A recorded host preflight: ten quiet seconds of normal pressure, swap-outs flat.
let preflightClock = 0;
const hostPreflight = await waitForBurstHostReady({ now: () => preflightClock,
  sleep: async (ms) => { preflightClock += ms; },
  readPressure: async () => ({ memory: { pressure: "normal" }, vm: { swapouts: 10, pageSizeBytes: 16_384 } }) });
assert.equal(hostPreflight.passed, true);
// Paired host readings and container probes at the 250ms capture cadence.
const clockRows = (epoch, fromMs, toMs) => {
  const rows = [];
  for (let t = fromMs; t <= toMs; t += 250) rows.push({ epochMs: epoch + t, monotonicMs: 5_000_000 + t, readSpanMs: 0.01 });
  return rows;
};
const probeRows = (epoch, fromMs, toMs) => {
  const rows = [];
  for (let t = fromMs; t <= toMs; t += 250) rows.push({ sampleId: rows.length + 1,
    hostSentEpochMs: epoch + t, hostSentMonotonicMs: 5_000_000 + t, hostSentReadSpanMs: 0.01,
    hostReceivedEpochMs: epoch + t + 2, hostReceivedMonotonicMs: 5_000_002 + t, hostReceivedReadSpanMs: 0.01,
    remoteEpochMs: epoch + t + 2, remoteMonotonicMs: 300_000 + t, remoteReadSpanMs: 0.02 });
  return rows;
};

function fixture(variant = "short", seed = 1, protocol = BURST_PROTOCOL) {
  const trace = burstTrace(seed, variant, protocol), epoch = 1_800_000_000_000;
  const attempts = trace.entries.map((entry, i) => {
    const rejected = entry.id === "interactive-burst-2";
    const setup = entry.id.startsWith("batch-setup-");
    const end = setup ? 66_000 + (variant === "long" ? 10_000 : 0) : entry.arrivalMs + 200;
    return { requestId: `moflux-bench-${entry.id}-a1`, admissionId: rejected ? null : `admission-${i}`,
      sentAtMs: entry.arrivalMs, sentAtEpochMs: epoch + entry.arrivalMs,
      firstTokenAtMs: rejected ? null : entry.arrivalMs + 100,
      firstTokenAtEpochMs: rejected ? null : epoch + entry.arrivalMs + 100,
      endedAtMs: end, endedAtEpochMs: epoch + end, httpStatus: rejected ? 429 : 200,
      outcome: rejected ? "failed" : "completed", outputTokensReported: true,
      outputTokens: entry.maxTokens ?? (entry.class === "interactive" ? 16 : 64),
      admissionReason: rejected ? "concurrency_limit" : null };
  });
  const events = attempts.filter((a) => a.admissionId).map((a, sequence) => ({
    sequence, admissionId: a.admissionId, admittedAt: new Date(a.sentAtEpochMs).toISOString(),
    admissionClass: a.requestId.includes("batch-") ? "batch" : "interactive",
    resources: { borrowedConcurrency: /batch-setup-[23]/u.test(a.requestId) }, grant: { grantId: "grant" }, limits: { admissionClasses: { batch: { protectedConcurrent: 1 } } } }));
  const samples = [];
  for (let offsetMs = 0; offsetMs <= 60_500 + burstWorkload(protocol).interactiveResumeDurationMs; offsetMs += 250) {
    const retained = events.filter((e) => Date.parse(e.admittedAt) <= epoch + offsetMs);
    const borrowing = offsetMs < 66_000 + (variant === "long" ? 10_000 : 0);
    samples.push({ offsetMs, sampleStartedAtMs: offsetMs - 1, observedAt: new Date(epoch + offsetMs).toISOString(), clockErrorMs: 0,
      admissionProvenance: { capacity: 512, nextSequence: retained.length, dropped: 0, captureFailures: 0, retained: retained.length, events: retained },
      pool: { maxConcurrent: 4, grant: { grantId: "grant" } },
      classes: { batch: { inFlight: offsetMs >= 42_000 && borrowing ? 3 : 0, borrowedConcurrent: borrowing ? 2 : 0, limits: { protectedConcurrent: 1 } },
        interactive: { inFlight: 0, limits: { protectedConcurrent: offsetMs >= 60_750 ? 3 : 1 },
          demandState: offsetMs >= 60_250 ? "demanding" : "idle" } } });
  }
  const v4 = protocol === "burst-recovery-v4";
  const endMs = 61_000 + burstWorkload(protocol).interactiveResumeDurationMs;
  const row = (event, offset, fields = {}) => ({ event, atEpochMs: epoch + offset, monotonicMs: 7_000_000 + offset,
    clockErrorMs: 0, ...(v4 ? { clockReadSpanMs: 0.01 } : {}), ...fields });
  const pressure = [];
  for (let offset = 59_900; offset <= 60_100 + burstWorkload(protocol).interactiveResumeDurationMs; offset += 100) pressure.push(row("pressure", offset,
    { runningRequestIds: offset < 66_000 + (variant === "long" ? 10_000 : 0)
      ? [1, 2, 3].map((i) => `moflux-bench-batch-setup-${i}-a1`) : [], waitingRequestIds: [] }));
  // V4's scheduler probe also emits an idle heartbeat; rows stay in capture order.
  if (v4) for (let offset = -500; offset <= endMs; offset += 250) pressure.push(row("clock", offset + 1));
  pressure.sort((a, b) => a.atEpochMs - b.atEpochMs);
  return { seed, variant, protocol, trace, arm: { pool: "test-pool", port: 8104 },
    ...(v4 ? { preflight: { schemaVersion: 1, host: hostPreflight, clock: { requiredDurationMs: 180_000, durationMs: 180_005,
      clockSamples: clockRows(epoch, -400_000, -220_000), errors: [],
      clockAlignment: { tyr: probeRows(epoch, -400_000, -220_000), latchflo: probeRows(epoch, -400_000, -220_000) } } } } : {}),
    loadgen: { trace: { hash: trace.hash }, generatorSaturated: 0, backendClockErrorMs: 0, startedAtEpochMs: epoch,
      ...(v4 ? { clockSamples: clockRows(epoch, 0, endMs), burstSetup: { schemaVersion: 1, status: "ready", reasons: [],
        observations: [41_100, 41_500, 41_900].map((at) => ({ atMs: at, requestedAtEpochMs: epoch + at,
          sampleStartedAtEpochMs: epoch + at + 2, observedAtEpochMs: epoch + at + 8, receivedAtEpochMs: epoch + at + 10,
          batchInFlight: at < 41_200 ? 1 : 0, batchProtectedConcurrent: 1 })) } } : {}),
      classes: Object.fromEntries(["interactive", "batch"].map((c) => [c, { serverError: 0, transportError: 0, requestError: 0,
        upstreamReject: 0, localRejectGrantUnavailable: {}, attemptSamples: attempts.filter((a) => a.requestId.includes(`-${c}-`)) }])) },
    managed: { samples, errors: [], ...(v4 ? { burstTiming: { clockSamples: clockRows(epoch, -500, endMs), errors: [], setupReports: [],
      clockAlignment: { tyr: probeRows(epoch, -500, endMs), latchflo: probeRows(epoch, -500, endMs) } } } : {}) },
    backendEvents: [row("installed", -600_000, { schemaVersion: v4 ? 4 : 3, schedulerSourceSha256: "source" }), ...pressure],
    armSummary: { runtimeIdentity: { schedulingPolicy: "priority" },
      vllm: { cacheConfig: { numGpuBlocks: 320, blockSize: 16 }, missingRequiredMetrics: [], scrapeErrors: [] },
      hostProcess: { sampleCount: 1, errors: [] }, hostPressure: { sampleCount: 1, errors: [], pressureSamples: { critical: 0 }, swapoutMiBDuringArm: 0 } } };
}
const f = fixture(), result = analyzeBurstTrial(f);
assert.equal(result.valid, true, JSON.stringify(result.gates.filter((g) => !g.passed)));
assert.equal(result.protocol, BURST_PROTOCOL);
assert.equal(result.initialBurst.rejected, 1);
assert.equal(result.initialBurst.completed, 1);
assert.equal(result.returnCohort.offered, 91);
assert.equal(result.returnCohort.sloGoodputRps, 1);
assert.equal(result.remainingLifetimeMedianMs, 6000);
assert.equal(result.sustainedZeroBorrowed.upperDelayMs, 6000);
assert.equal(result.borrowedAdmissionsByRestoration.definitelyAfter, 0);
// Preserve historical v2 trace identity, denominator and observation horizon.
assert.equal(burstTrace(3, "short", "burst-recovery-v2").hash,
  "1d5c58a5f6097d0fca107dd6c74ea786b82d4d93a60d214f8d6bedaf560afa22");
const v2 = analyzeBurstTrial(fixture("short", 3, "burst-recovery-v2"));
assert.equal(v2.valid, true);
assert.equal(v2.returnCohort.offered, 41);
assert.equal(v2.returnCohort.arrivalWindowMs, 40_000);
assert.equal(v2.horizonEpochMs, 1_800_000_100_000);
assert.equal(result.returnCohort.arrivalWindowMs, 90_000);
assert.equal(result.horizonEpochMs, 1_800_000_150_000);
const lateDrain = fixture();
for (const sample of lateDrain.managed.samples) sample.classes.batch.borrowedConcurrent = sample.offsetMs < 104_000 ? 2 : 0;
assert.equal(analyzeBurstTrial(lateDrain).sustainedZeroBorrowed.upperDelayMs, 44_000);
const change = (fn) => { const x = structuredClone(f); fn(x); return analyzeBurstTrial(x); };
// Historical v3 analysis keeps its sampler readiness gate and raw 5ms clock rule.
const f3 = fixture("short", 1, "burst-recovery-v3"), result3 = analyzeBurstTrial(f3);
const change3 = (fn) => { const x = structuredClone(f3); fn(x); return analyzeBurstTrial(x); };
assert.equal(result3.valid, true, JSON.stringify(result3.gates.filter((g) => !g.passed)));
assert.equal(result3.gates.length, 18);
assert.equal(result.gates.length, 19);
assert.equal(result3.timingUncertaintyMs, undefined);
assert.equal(result3.restorationBracket.timingUncertaintyMs, undefined);
assert.deepEqual(result3.diagnostics.setupReadiness.reasons, []);
assert.equal(result3.diagnostics.setupReadiness.method, "sampler");
assert.equal(result3.diagnostics.setupReadiness.primeDurationMs, 200);
assert.equal(result.returnCohort.sloMisses.rejected, 1);
assert.equal(result.returnCohort.sloMisses.completed.total, 0);
assert.equal(result.returnCohort.sloMetShareOfCompleted, 1);
assert.deepEqual(result.returnCohort.rejectionReasons, { concurrency_limit: 1 });
const sloBreakdown = change((x) => {
  const steady = x.loadgen.classes.interactive.attemptSamples.filter((a) => a.requestId.includes("steady-"));
  steady[0].firstTokenAtMs = steady[0].sentAtMs + 5_001;
  steady[0].endedAtMs = steady[0].sentAtMs + 6_000;
  steady[1].endedAtMs = steady[1].sentAtMs + 30_001;
  steady[2].firstTokenAtMs = steady[2].sentAtMs + 5_001;
  steady[2].endedAtMs = steady[2].sentAtMs + 30_001;
  steady[3].firstTokenAtMs = null;
  steady[4].outcome = "censored";
  steady[5].outcome = "failed"; steady[5].httpStatus = 500;
  steady[6].outcome = "failed"; steady[6].httpStatus = 504; steady[6].admissionReason = "timeout";
  // Exact SLO boundaries still pass.
  steady[7].firstTokenAtMs = steady[7].sentAtMs + 5_000;
  steady[7].endedAtMs = steady[7].sentAtMs + 30_000;
  x.loadgen.classes.interactive.attemptSamples = x.loadgen.classes.interactive.attemptSamples.filter((a) => a !== steady[8]);
});
assert.deepEqual(sloBreakdown.returnCohort.sloMisses, { total: 9, rejected: 2,
  completed: { total: 4, ttftOnly: 1, latencyOnly: 1, both: 1, missingTiming: 1 },
  failed: 1, censored: 1, missing: 1 });
assert.deepEqual(sloBreakdown.returnCohort.rejectionReasons, { concurrency_limit: 1, timeout: 1 });
assert.equal(sloBreakdown.diagnostics.afterSustainedZeroBorrowed.status, "inconclusive");
assert.equal(sloBreakdown.diagnostics.afterSustainedZeroBorrowed.outcomes, null);
const afterZero = result.diagnostics.afterSustainedZeroBorrowed;
assert.equal(afterZero.status, "observed");
assert.equal(afterZero.arrivalWindowMs, 84_000);
assert.equal(afterZero.outcomes.offered, result.outcomes.filter((o) => o.sentAtEpochMs >= afterZero.startEpochMs &&
  o.sentAtEpochMs < result.horizonEpochMs).length);
const boundaryOutcomes = change((x) => {
  const steady = x.loadgen.classes.interactive.attemptSamples.filter((a) => a.requestId.includes("steady-"));
  const zeroAt = x.loadgen.startedAtEpochMs + 66_000;
  steady[0].sentAtEpochMs = zeroAt - 1;
  steady[1].sentAtEpochMs = zeroAt;
  steady[1].outcome = "failed"; steady[1].httpStatus = 429; steady[1].admissionReason = "concurrency_limit";
});
assert.equal(boundaryOutcomes.diagnostics.afterSustainedZeroBorrowed.outcomes.rejected, 1);
const gappedDiagnostics = change((x) => {
  x.managed.samples = x.managed.samples.filter((s) => s.offsetMs < 148_000 || s.offsetMs > 150_000);
});
assert.equal(gappedDiagnostics.diagnostics.afterSustainedZeroBorrowed.status, "inconclusive");
assert.equal(gappedDiagnostics.diagnostics.afterSustainedZeroBorrowed.outcomes, null);
// Current occupancy must not stand in for the identities of original borrowers.
const borrowerSetup = [
  { requestId: "owned", admission: { resources: { borrowedConcurrency: false } },
    attempt: { outcome: "completed", endedAtEpochMs: 108_000 } },
  { requestId: "borrowed-a", admission: { resources: { borrowedConcurrency: true } },
    attempt: { outcome: "completed", endedAtEpochMs: 110_000 } },
  { requestId: "borrowed-b", admission: { resources: { borrowedConcurrency: true } },
    attempt: { outcome: "completed", endedAtEpochMs: 115_000 } },
];
const original = summarizeOriginalBorrowers({ setup: borrowerSetup,
  returnedAtEpochMs: 100_000, accountingZeroEpochMs: 105_000 });
assert.equal(original.borrowedRequestCount, 2);
assert.equal(original.allStreamsCompleted, true);
assert.equal(original.lastCompletionDelayMs, 15_000);
assert.equal(original.afterAccountingZeroMs, 10_000);
const incompleteBorrowers = structuredClone(borrowerSetup);
incompleteBorrowers[2].attempt.outcome = "censored";
const incompleteOriginal = summarizeOriginalBorrowers({ setup: incompleteBorrowers,
  returnedAtEpochMs: 100_000, accountingZeroEpochMs: 105_000 });
assert.equal(incompleteOriginal.completedCount, 1);
assert.equal(incompleteOriginal.lastCompletedAtEpochMs, null);
assert.equal(incompleteOriginal.afterAccountingZeroMs, null);
delete incompleteBorrowers[2].admission.resources.borrowedConcurrency;
assert.equal(summarizeOriginalBorrowers({ setup: incompleteBorrowers }).attributionComplete, false);
assert.equal(summarizeOriginalBorrowers().allStreamsCompleted, false);
// Missing identities break transition continuity; missing KV is not zero pressure.
const pressureDiagnostics = summarizeBurstEnginePressure({ setup: borrowerSetup,
  returnedAtEpochMs: 100_000, horizonEpochMs: 101_000,
  armSummary: { vllm: { preemptions: { start: 3, end: 4, delta: 1 } } },
  backendEvents: [
    { event: "pressure", atEpochMs: 99_500, kvUsage: 0.8,
      runningRequestIds: ["borrowed-a", "borrowed-b"], waitingRequestIds: [] },
    { event: "pressure", atEpochMs: 100_200, kvUsage: 1,
      runningRequestIds: ["borrowed-b"], waitingRequestIds: ["borrowed-a"] },
    { event: "pressure", atEpochMs: 100_400, kvUsage: 0.9 },
    { event: "pressure", atEpochMs: 100_600, kvUsage: 0.7,
      runningRequestIds: ["borrowed-a", "borrowed-b"], waitingRequestIds: [] },
    { event: "pressure", atEpochMs: 100_800, kvUsage: 1.1,
      runningRequestIds: ["borrowed-a"], waitingRequestIds: ["borrowed-b"] },
    { event: "pressure", atEpochMs: 101_000, kvUsage: 1,
      runningRequestIds: ["borrowed-a", "borrowed-b"], waitingRequestIds: [] },
  ] });
assert.equal(pressureDiagnostics.capture.saturationSampleCount, 2);
assert.equal(pressureDiagnostics.returnWindow.pressureSampleCount, 4);
assert.equal(pressureDiagnostics.returnWindow.validKvSampleCount, 3);
assert.equal(pressureDiagnostics.returnWindow.missingOrInvalidKvSampleCount, 1);
assert.equal(pressureDiagnostics.returnWindow.saturationSampleCount, 1);
assert.equal(pressureDiagnostics.returnWindow.firstSaturationDelayMs, 200);
assert.equal(pressureDiagnostics.originalBorrowerTransitions.runningToWaitingCount, 2);
assert.equal(pressureDiagnostics.originalBorrowerTransitions.waitingToRunningCount, 0);
assert.equal(pressureDiagnostics.preemptionsDuringArm.delta, 1);
const absentPressure = summarizeBurstEnginePressure({ returnedAtEpochMs: 100_000, horizonEpochMs: 101_000 });
assert.equal(absentPressure.capture.maxKvUsage, null);
assert.equal(absentPressure.returnWindow.saturationSampleCount, null);
assert.equal(absentPressure.originalBorrowerTransitions.runningToWaitingCount, null);
assert.equal(absentPressure.preemptionsDuringArm.delta, null);
assert.equal(change((x) => x.loadgen.classes.batch.attemptSamples.find((a) => a.requestId.includes("prime-1")).endedAtEpochMs += 2000).valid, false);
const unreadyV3 = change3((x) => {
  for (const s of x.managed.samples) if (s.offsetMs < 42000) s.classes.batch.limits.protectedConcurrent = 0;
});
assert.equal(unreadyV3.gates.find((g) => g.name === "batchFloorReadyBeforeSetup").passed, false);
assert.deepEqual(unreadyV3.diagnostics.setupReadiness.reasons, ["batch_protected_floor_not_one"]);
// The 8.2s prime of pilot 20261004T173611Z: still streaming when setup 1 is sent.
const slowPrimeV3 = change3((x) => x.loadgen.classes.batch.attemptSamples.find((a) => a.requestId.includes("prime-1")).endedAtEpochMs += 8_000);
assert.equal(slowPrimeV3.valid, false);
assert.deepEqual(slowPrimeV3.diagnostics.setupReadiness.reasons, ["prime_completed_after_setup_send"]);
assert.equal(slowPrimeV3.diagnostics.setupReadiness.primeEndedBeforeSetupMs, -7_200);
assert.equal(change((x) => {
  for (const s of x.managed.samples) for (const e of s.admissionProvenance.events)
    if (e.admissionId === x.loadgen.classes.batch.attemptSamples.find((a) => a.requestId.includes("setup-1")).admissionId)
      e.limits.admissionClasses.batch.protectedConcurrent = 0;
}).valid, false);
assert.equal(change((x) => x.loadgen.classes.interactive.attemptSamples.pop()).valid, false);
assert.equal(change((x) => x.loadgen.classes.interactive.attemptSamples.find((a) => a.requestId.includes("burst-2")).sentAtEpochMs += 26).valid, false);
assert.equal(change((x) => x.backendEvents = x.backendEvents.filter((e) => e.atEpochMs >= 1_800_000_060_000 || e.atEpochMs < 1_800_000_059_500)).valid, false);
assert.equal(change((x) => x.managed.samples.at(-1).admissionProvenance.nextSequence++).provenance.complete, false);
assert.equal(change((x) => {
  for (const s of x.managed.samples) for (const e of s.admissionProvenance.events) {
    if (e.admissionId === x.loadgen.classes.batch.attemptSamples.find((a) => a.requestId.includes("setup-1")).admissionId) e.resources.borrowedConcurrency = true;
  }
}).valid, false);
assert.equal(change((x) => x.managed.samples.at(-1).admissionProvenance.captureFailures++).valid, false);
assert.equal(change3((x) => x.managed.samples.at(-1).clockErrorMs = 6).valid, false);
const clockGate = (analysis) => analysis.gates.find((g) => g.name === "clockStable");
const drift = clockGate(change3((x) => x.managed.samples.at(-1).clockErrorMs = 6));
assert.equal(drift.passed, false);
assert.deepEqual(drift.observed.failedSources, ["managed"]);
assert.equal(drift.observed.managed.minErrorMs, 0);
assert.equal(drift.observed.managed.maxErrorMs, 6);
assert.equal(drift.observed.managed.rangeMs, 6);
assert.equal(drift.observed.managed.maxRangeMs, 5);
// The stream gate bounds drift, not absolute offset; keep the existing rule.
assert.equal(clockGate(change3((x) => { for (const s of x.managed.samples) s.clockErrorMs = 6; })).passed, true);
assert.equal(clockGate(change3((x) => x.managed.samples.at(-1).clockErrorMs = 5)).passed, true);
// A fitted, smooth drift is descriptive and cannot rescue a failed raw-range gate.
const linearDrift = clockGate(change3((x) => {
  for (const sample of x.managed.samples) sample.clockErrorMs = sample.offsetMs * 40 / 1_000_000;
}));
assert.equal(linearDrift.passed, false);
assert.ok(Math.abs(linearDrift.observed.managed.fittedDriftPpm - 40) < 0.00001);
assert.ok(linearDrift.observed.managed.residualRangeMs < 0.00001);
assert.equal(linearDrift.observed.managed.captureDurationMs, 150_500);
assert.equal(clockGate(result3).observed.managed.fittedDriftPpm, 0);
const missingClock = clockGate(change3((x) => delete x.backendEvents.at(-1).clockErrorMs));
assert.deepEqual(missingClock.observed.failedSources, ["backend"]);
assert.equal(missingClock.observed.backend.nonFiniteCount, 1);
assert.equal(clockGate(change3((x) => x.backendEvents = [x.backendEvents[0]])).observed.backend.sampleCount, 0);
const loadClock = clockGate(change3((x) => x.loadgen.backendClockErrorMs = -6));
assert.deepEqual(loadClock.observed.failedSources, ["loadgen"]);
assert.equal(loadClock.observed.loadgen.backendClockErrorMs, -6);
assert.equal(loadClock.observed.loadgen.maxAbsoluteErrorMs, 5);
assert.equal(change((x) => x.managed.samples = x.managed.samples.filter((s) => s.offsetMs < 150000)).valid, false);
// Coverage must extend through the first sample at or beyond each protocol's
// horizon, including when no telemetry remains inside the return window.
const samplerGate = (analysis) => analysis.gates.find((g) => g.name === "samplerIntegrity");
for (const protocol of ["burst-recovery-v1", "burst-recovery-v2", "burst-recovery-v3", BURST_PROTOCOL]) {
  const horizonMs = 60_000 + burstWorkload(protocol).interactiveResumeDurationMs;
  const tailGap = fixture("short", 3, protocol);
  tailGap.managed.samples = tailGap.managed.samples.filter((s) =>
    s.offsetMs < horizonMs - 2_000 || s.offsetMs > horizonMs);
  const missingTail = analyzeBurstTrial(tailGap);
  assert.equal(samplerGate(missingTail).passed, false, `${protocol}: reject a gap to the final endpoint`);
  assert.equal(missingTail.valid, false);
  assert.equal(samplerGate(missingTail).observed.endpointObserved, true);
  assert.equal(samplerGate(missingTail).observed.gapsOverLimit.length, 1);
  assert.ok(samplerGate(missingTail).observed.maxGapMs > 750);

  const boundary = fixture("short", 3, protocol);
  boundary.managed.samples = boundary.managed.samples.filter((s) =>
    s.offsetMs <= horizonMs - 500 || s.offsetMs >= horizonMs + 250);
  assert.equal(samplerGate(analyzeBurstTrial(boundary)).passed, true, `${protocol}: allow a 750ms endpoint gap`);
  assert.equal(samplerGate(analyzeBurstTrial(boundary)).observed.maxGapMs, 750);
  const endpoint = boundary.managed.samples.find((s) => s.offsetMs >= horizonMs);
  endpoint.observedAt = new Date(Date.parse(endpoint.observedAt) + 1).toISOString();
  endpoint.offsetMs += 1;
  endpoint.sampleStartedAtMs += 1;
  assert.equal(samplerGate(analyzeBurstTrial(boundary)).passed, false, `${protocol}: reject a 751ms endpoint gap`);

  const emptyWindow = fixture("short", 3, protocol);
  emptyWindow.managed.samples = emptyWindow.managed.samples.filter((s) =>
    s.offsetMs < 60_000 || s.offsetMs > horizonMs);
  assert.equal(samplerGate(analyzeBurstTrial(emptyWindow)).passed, false, `${protocol}: reject an empty return window`);
}
assert.equal(change((x) => x.loadgen.classes.batch.attemptSamples.find((a) => a.requestId.includes("setup-1")).outputTokensReported = false).valid, false);
const censored = change((x) => { for (const s of x.managed.samples) s.classes.batch.borrowedConcurrent = 2; });
assert.equal(censored.valid, true); // No outcome-based selection.
assert.equal(censored.sustainedZeroBorrowed.status, "right_censored");
assert.equal(censored.sustainedZeroBorrowed.upperDelayMs, null);
assert.equal(censored.diagnostics.afterSustainedZeroBorrowed.status, "right_censored");
assert.equal(censored.diagnostics.afterSustainedZeroBorrowed.outcomes, null);
const refill = change((x) => {
  for (const s of x.managed.samples) for (const e of s.admissionProvenance.events) {
    if (e.admissionClass === "batch" && Date.parse(e.admittedAt) > 1_800_000_061_000) e.resources.borrowedConcurrency = true;
  }
});
assert.equal(refill.valid, true);
assert.ok(refill.borrowedAdmissionsByRestoration.definitelyAfter > 0);

// ── burst-recovery-v4: carried timing budget, explicit readiness, preflights ──
const gateOf = (analysis, name) => analysis.gates.find((g) => g.name === name);
assert.equal(result.timingUncertaintyMs, BURST_V4_UNCERTAINTY_MS);
for (const [wide, plain] of [[result.restorationBracket, result3.restorationBracket],
  [result.recognitionBracket, result3.recognitionBracket],
  [result.sustainedZeroBorrowed.bracket, result3.sustainedZeroBorrowed.bracket],
  [result.setup[1].runningExitBracket, result3.setup[1].runningExitBracket]]) {
  assert.equal(wide.timingUncertaintyMs, 10);
  assert.equal(wide.observedLowerEpochMs, plain.lowerEpochMs);
  assert.equal(wide.observedUpperEpochMs, plain.upperEpochMs);
  assert.equal(wide.lowerEpochMs, plain.lowerEpochMs - 10);
  assert.equal(wide.upperEpochMs, plain.upperEpochMs + 10);
}
// Delays between two host readings carry no container-clock term.
assert.equal(result.sustainedZeroBorrowed.upperDelayMs, result3.sustainedZeroBorrowed.upperDelayMs);
// A container-clock admission within the budget of the return is counted, not assumed earlier.
const nearReturn = (x) => {
  const id = x.loadgen.classes.batch.attemptSamples.find((a) => a.requestId.includes("setup-3")).admissionId;
  for (const s of x.managed.samples) for (const e of s.admissionProvenance.events)
    if (e.admissionId === id) e.admittedAt = new Date(1_800_000_059_995).toISOString();
};
assert.equal(change(nearReturn).borrowedAdmissionsAfterReturn.length, 1);
assert.equal(change(nearReturn).borrowedAdmissionsByRestoration.definitelyBefore, 1);
assert.equal(change3(nearReturn).borrowedAdmissionsAfterReturn.length, 0);
assert.equal(change((x) => x.backendEvents[0].schemaVersion = 3).valid, false);

const clockV4 = (fn) => gateOf(change(fn), "clockStable");
const baseClock = gateOf(result, "clockStable").observed;
assert.equal(baseClock.uncertaintyMs, 10);
assert.deepEqual(baseClock.failedSources, []);
assert.equal(baseClock.backend.gapGated, false);
assert.ok(baseClock.backend.clippedSampleCount >= 1, "the installed row precedes the capture and is not analyzed");
// Known drift: the 30ppm and 85ppm measured on this host are gradual and pass;
// v3's raw 5ms range could not. Beyond 100ppm the brackets cannot absorb it.
const driftBy = (ppm) => (x) => {
  for (const r of x.managed.burstTiming.clockSamples) r.epochMs += Math.round((r.monotonicMs - 5_000_000) * ppm / 1e6);
};
for (const ppm of [30, 85, -85]) {
  const drifting = clockV4(driftBy(ppm));
  assert.equal(drifting.passed, true, `${ppm}ppm`);
  assert.ok(Math.abs(drifting.observed.managed.fittedSlewPpm - ppm) < 2);
  assert.ok(drifting.observed.managed.maxWindowDriftMs <= 10);
}
assert.ok(clockV4(driftBy(30)).observed.managed.rawResidualRangeMs < 5.5);
assert.ok(clockV4(driftBy(85)).observed.managed.rawResidualRangeMs > 5, "v3 would have rejected this gradual drift");
const fast = clockV4(driftBy(150));
assert.deepEqual(fast.observed.failedSources, ["managed"]);
assert.deepEqual(fast.observed.managed.reasons, ["clock_slew_exceeded", "clock_drift_exceeds_budget"]);
// Known jumps: any source, either direction; never repaired.
for (const step of [5, -5]) {
  const jump = clockV4((x) => { for (const r of x.loadgen.clockSamples) if (r.monotonicMs >= 5_070_000) r.epochMs += step; });
  assert.deepEqual(jump.observed.failedSources, ["loadgen"]);
  assert.ok(jump.observed.loadgen.reasons.includes("clock_step_exceeded"));
  assert.equal(jump.observed.loadgen.violations[0].kind, "step");
}
assert.equal(clockV4((x) => { for (const r of x.loadgen.clockSamples) if (r.monotonicMs >= 5_070_000) r.epochMs += 1; }).passed, true,
  "one millisecond is timestamp resolution, not a jump");
// A fast slew hides from the step rule and still exceeds what brackets absorb.
const ramp = clockV4((x) => { for (const r of x.managed.burstTiming.clockSamples)
  r.epochMs += Math.round(Math.min(12, Math.max(0, (r.monotonicMs - 5_070_000) / 250 * 1.5))); });
assert.ok(ramp.observed.managed.reasons.includes("clock_drift_exceeds_budget"));
assert.ok(!ramp.observed.managed.reasons.includes("clock_step_exceeded"));
assert.equal(ramp.observed.managed.maxWindowDriftMs, 12);
const backendJump = clockV4((x) => { for (const e of x.backendEvents) if (e.atEpochMs >= 1_800_000_070_000) e.atEpochMs += 5; });
assert.deepEqual(backendJump.observed.failedSources, ["backend"]);
// Missing samples: one lost reading is tolerated, a gap beyond one second is not.
const between = (rows, from, to) => rows.filter((r) => r.monotonicMs <= 5_000_000 + from || r.monotonicMs >= 5_000_000 + to);
assert.equal(clockV4((x) => x.managed.burstTiming.clockSamples = between(x.managed.burstTiming.clockSamples, 80_000, 80_500)).passed, true);
const gappedV4 = clockV4((x) => x.managed.burstTiming.clockSamples = between(x.managed.burstTiming.clockSamples, 80_000, 81_250));
assert.deepEqual(gappedV4.observed.managed.reasons, ["sample_gap_exceeded"]);
assert.equal(gappedV4.observed.managed.maxSampleGapMs, 1250);
assert.deepEqual(clockV4((x) => x.loadgen.clockSamples = x.loadgen.clockSamples.filter((r) => r.monotonicMs < 5_140_000))
  .observed.loadgen.reasons, ["capture_coverage_incomplete"]);
// The load generator's series ends with its last request, which may precede the horizon.
assert.equal(baseClock.window.clientEndEpochMs, Math.max(...["interactive", "batch"].flatMap((c) =>
  f.loadgen.classes[c].attemptSamples.map((a) => a.endedAtEpochMs))));
assert.ok(baseClock.window.clientEndEpochMs < baseClock.window.endEpochMs);
assert.equal(clockV4((x) => x.loadgen.clockSamples = x.loadgen.clockSamples.filter((r) => r.monotonicMs <= 5_149_250)).passed, true);
assert.equal(clockV4((x) => x.managed.burstTiming.clockSamples = x.managed.burstTiming.clockSamples.filter((r) => r.monotonicMs <= 5_148_750)).passed, false,
  "the runner's series must reach the horizon");
const slowRead = clockV4((x) => x.loadgen.clockSamples[40].readSpanMs = 3);
assert.equal(slowRead.passed, true);
assert.equal(slowRead.observed.loadgen.slowReadCount, 1);
assert.deepEqual(clockV4((x) => x.loadgen.clockSamples[40].epochMs = null).observed.loadgen.reasons, ["invalid_samples"]);
// Scheduler rows are themselves the paired readings: a starved heartbeat is reported, not gated.
const starved = clockV4((x) => x.backendEvents = x.backendEvents.filter((e) => e.event !== "clock" ||
  e.atEpochMs < 1_800_000_030_000 || e.atEpochMs > 1_800_000_035_000));
assert.equal(starved.passed, true);
assert.ok(starved.observed.backend.maxSampleGapMs >= 5_000);
// Container alignment is measured directly; a lost probe is missing, not misaligned.
const misaligned = clockV4((x) => { for (const r of x.managed.burstTiming.clockAlignment.tyr) r.remoteEpochMs += 15; });
assert.deepEqual(misaligned.observed.failedSources, ["tyr"]);
assert.ok(misaligned.observed.tyr.reasons.includes("alignment_uncertainty_exceeded"));
const lostProbe = clockV4((x) => x.managed.burstTiming.clockAlignment.latchflo[300] = { sampleId: 301, error: "timeout" });
assert.equal(lostProbe.passed, true);
assert.deepEqual(lostProbe.observed.latchflo.errorCounts, { timeout: 1 });
const deadProbe = clockV4((x) => { const rows = x.managed.burstTiming.clockAlignment.latchflo;
  for (let i = 300; i < 312; i++) rows[i] = { sampleId: i + 1, error: "process_exited" }; });
assert.deepEqual(deadProbe.observed.latchflo.reasons, ["probe_gap_exceeded"]);
// The container may step to follow the host while its measured alignment holds.
const followed = clockV4((x) => { for (const r of x.managed.burstTiming.clockAlignment.tyr) if (r.remoteMonotonicMs >= 370_000) r.remoteEpochMs -= 5; });
assert.equal(followed.passed, true);
assert.equal(followed.observed.tyr.remoteClock.stepCount, 1);
assert.deepEqual(clockV4((x) => x.managed.burstTiming.errors.push("clock_capture_failed")).observed.failedSources, ["capture_errors"]);
assert.equal(clockV4((x) => delete x.managed.burstTiming).passed, false);

const setupV4 = (fn) => gateOf(change(fn), "batchFloorReadyBeforeSetup").observed;
assert.equal(result.diagnostics.setupReadiness.method, "checkpoint");
assert.deepEqual(result.diagnostics.setupReadiness.reasons, []);
assert.equal(result.diagnostics.setupReadiness.observationAgeMs, 98);
assert.equal(result.diagnostics.setupReadiness.primeEndedBeforeSetupMs, 800);
const lastObservation = (x) => x.loadgen.burstSetup.observations.at(-1);
assert.deepEqual(setupV4((x) => lastObservation(x).batchInFlight = 1).reasons, ["batch_request_in_flight"]);
assert.deepEqual(setupV4((x) => lastObservation(x).batchProtectedConcurrent = 0).reasons, ["batch_protected_floor_not_one"]);
assert.deepEqual(setupV4((x) => x.loadgen.burstSetup.observations = []).reasons, ["no_readiness_observation_before_setup"]);
// An answer received after setup 1 was sent cannot decide; the earlier one is stale.
assert.deepEqual(setupV4((x) => { for (const o of x.loadgen.burstSetup.observations.slice(1)) o.receivedAtEpochMs += 600; }).reasons,
  ["readiness_observation_stale", "readiness_observed_before_prime_completed", "batch_request_in_flight"]);
const slowPrime = setupV4((x) => x.loadgen.classes.batch.attemptSamples.find((a) => a.requestId.includes("prime-1")).endedAtEpochMs += 8_000);
assert.deepEqual(slowPrime.reasons, ["prime_completed_after_setup_send", "readiness_observed_before_prime_completed"]);
assert.equal(slowPrime.primeDurationMs, 8_200);
// Neither stored flag is evidence on its own.
assert.equal(setupV4((x) => { lastObservation(x).batchInFlight = 1; x.loadgen.burstSetup.status = "ready"; }).ready, false);
assert.deepEqual(setupV4((x) => x.loadgen.burstSetup.status = "missed").reasons, ["checkpoint_did_not_report_ready"]);
assert.equal(setupV4((x) => delete x.loadgen.burstSetup).ready, false);

const preflightV4 = (fn) => gateOf(change(fn), "preflightReady");
assert.equal(gateOf(result, "preflightReady").observed.clock.durationValid, true);
assert.equal(gateOf(result, "preflightReady").observed.host.status, "ready");
assert.equal(preflightV4((x) => delete x.preflight).passed, false);
assert.equal(preflightV4((x) => x.preflight.host = null).passed, false);
assert.equal(preflightV4((x) => x.preflight.host.samples[5].vm.swapouts = 11).passed, false, "swap-outs rose in the quiet window");
assert.equal(preflightV4((x) => x.preflight.host.samples[5].memory.pressure = "warn").passed, false);
assert.equal(preflightV4((x) => x.preflight.clock.durationMs = 120_000).passed, false);
assert.deepEqual(preflightV4((x) => x.preflight.clock.clockSamples = x.preflight.clock.clockSamples.slice(0, 400))
  .observed.clock.failures.duration, ["full_duration_not_covered"]);
assert.ok(preflightV4((x) => { for (const r of x.preflight.clock.clockAlignment.tyr) r.remoteEpochMs += 15; })
  .observed.clock.failures.tyr.includes("alignment_uncertainty_exceeded"));
assert.equal(preflightV4((x) => x.preflight.clock.errors.push("cancelled")).passed, false);

const undersized = spawnSync(process.execPath, ["demo/burst-recovery.mjs", "--seeds=1-4", "--dry-run"], { cwd: ROOT, encoding: "utf8" });
assert.equal(undersized.status, 1);
assert.match(undersized.stderr, /at least five pairs/);
const plan = burstPairPlan([1, 2, 3, 4, 5]);
assert.deepEqual(plan[1].order, ["long", "short"]);
const trials = plan.flatMap(({ seed }) => ["short", "long"].map((variant) => ({ seed, variant,
  runtime: { model: "pinned" }, analysis: analyzeBurstTrial(fixture(variant, seed)) })));
assert.equal(summarizeBurstPairs(plan, trials).passed, true);
assert.equal(summarizeBurstPairs(plan, trials.slice(1)).passed, false);
assert.equal(summarizeBurstPairs(plan, trials, { pilot: true }).passed, false);
const mixedProtocol = structuredClone(trials); mixedProtocol[1].analysis.protocol = "burst-recovery-v1";
assert.equal(summarizeBurstPairs(plan, mixedProtocol).passed, false);
const mismatch = structuredClone(trials); mismatch[1].runtime.model = "changed";
assert.equal(summarizeBurstPairs(plan, mismatch).passed, false);
const weak = structuredClone(trials); for (const t of weak) if (t.variant === "long") t.analysis.remainingLifetimeMedianMs = 6500;
assert.equal(summarizeBurstPairs(plan, weak).passed, false);

const temp = mkdtempSync(path.join(tmpdir(), "burst-recovery-"));
try {
  const output = path.join(temp, "dry-run");
  const dry = spawnSync(process.execPath, ["demo/burst-recovery.mjs", "--pilot", "--dry-run", `--out=${output}`], { cwd: ROOT, encoding: "utf8" });
  assert.equal(dry.status, 0, dry.stderr); assert.equal(existsSync(output), false);
  for (const args of [["--out=results/published/test"], ["--seeds=1,1"], ["--run-id=../bad"], ["--pilot=false"]]) {
    const run = spawnSync(process.execPath, ["demo/burst-recovery.mjs", "--dry-run", ...args], { cwd: ROOT, encoding: "utf8" });
    assert.equal(run.status, 1, JSON.stringify(args));
  }
  for (const args of [["--arms=static,moflux"], ["--policy-profile=unlent-concurrency-2"], ["--backend-availability"], ["--duration-ms=120000"]]) {
    const run = spawnSync(process.execPath, ["demo/vllm-contention.mjs", "--backend=metal", "--workload=metal-long-context-v1", "--burst-recovery=short", "--dry-run", ...args], { cwd: ROOT, encoding: "utf8" });
    assert.equal(run.status, 1, JSON.stringify(args));
  }
  writeFileSync(path.join(temp, "plan.json"), JSON.stringify({ protocol: BURST_PROTOCOL, pilot: true, plan: burstPairPlan([3]) }));
  const missing = readBurstRun(temp); assert.equal(missing.results.length, 2);
  assert.ok(missing.results.every((t) => !t.analysis.valid && t.error));
  // Real HTTP replay verifies that the new attribution and token fields survive
  // a local rejection and a completed streaming response.
  const bodies = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    bodies.push(JSON.parse(Buffer.concat(chunks)));
    if (bodies.length === 1) { res.writeHead(429, { "x-admission-reason": "concurrency_limit" }); res.end("{}"); return; }
    res.writeHead(200, { "content-type": "text/event-stream", "x-admission-id": `admission-${bodies.length}` });
    res.end('data: {"choices":[{"delta":{"content":"ok"}}],"usage":{"prompt_tokens":4,"completion_tokens":16}}\n\ndata: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const raw = path.join(temp, "http.json");
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["load/loadgen.mjs", `--targets=http://127.0.0.1:${server.address().port}`,
        "--duration-ms=300", "--interactive-rps=60", "--interactive-max-tokens=16", "--batch-rps=0",
        "--max-attempts=1", "--backend-availability=true", "--provider-api=openai", "--force-output-length=true",
        "--metrics-port=0", `--out=${raw}`], { cwd: ROOT });
      let logs = ""; child.stdout.on("data", (b) => logs += b); child.stderr.on("data", (b) => logs += b);
      child.on("error", reject); child.on("close", (code) => code === 0 ? resolve() : reject(new Error(logs)));
    });
    const attempts = JSON.parse(readFileSync(raw)).classes.interactive.attemptSamples;
    assert.ok(attempts.length > 1);
    assert.equal(attempts[0].admissionId, null);
    assert.equal(attempts[0].admissionReason, "concurrency_limit");
    assert.ok(attempts.slice(1).every((a) => a.admissionId?.startsWith("admission-") &&
      a.outputTokensReported === true && a.outputTokens === 16 && a.inputTokens === 4 &&
      a.responseHeadersAtMs <= a.firstTokenAtMs && a.outcome === "completed"));
  } finally { await new Promise((resolve) => server.close(resolve)); }
  for (const variant of ["short", "long"]) {
    const x = fixture(variant, 3), dir = path.join(temp, "trials", `${variant}-seed-3`);
    mkdirSync(dir, { recursive: true });
    const save = (name, value) => writeFileSync(path.join(dir, name), JSON.stringify(value));
    save("summary.json", { experiment: { protocol: BURST_PROTOCOL, variant, seeds: [3] },
      runtime: { model: "pinned" }, results: [{ arms: { moflux: x.armSummary } }] });
    save("moflux-seed-3.json", x.loadgen); save("trace-seed-3.json", x.trace);
    save("moflux-telemetry-seed-3.json", { managed: x.managed });
    save("burst-preflight-seed-3.json", x.preflight);
    writeFileSync(path.join(dir, "backend-events-1-moflux.jsonl"), x.backendEvents.map((e) => JSON.stringify(e)).join("\n"));
  }
  const replayed = readBurstRun(temp);
  assert.ok(replayed.results.every((t) => t.analysis.valid));
  assert.equal(replayed.protocol, BURST_PROTOCOL);
  // Historical manifests dispatch to the original trace and gates, not v2.
  writeFileSync(path.join(temp, "plan.json"), JSON.stringify({ protocol: "burst-recovery-v1", pilot: true, plan: burstPairPlan([3]) }));
  for (const variant of ["short", "long"]) {
    const dir = path.join(temp, "trials", `${variant}-seed-3`);
    const summaryPath = path.join(dir, "summary.json");
    const summary = JSON.parse(readFileSync(summaryPath)); summary.experiment.protocol = "burst-recovery-v1";
    writeFileSync(summaryPath, JSON.stringify(summary));
    const trace = burstTrace(3, variant, "burst-recovery-v1");
    writeFileSync(path.join(dir, "trace-seed-3.json"), JSON.stringify(trace));
    const loadPath = path.join(dir, "moflux-seed-3.json");
    const load = JSON.parse(readFileSync(loadPath)); load.trace.hash = trace.hash;
    writeFileSync(loadPath, JSON.stringify(load));
  }
  const historical = readBurstRun(temp);
  assert.equal(historical.protocol, "burst-recovery-v1");
  assert.ok(historical.results.every((t) => t.analysis.protocol === "burst-recovery-v1" &&
    !t.analysis.gates.some((g) => g.name === "batchFloorReadyBeforeSetup")));
  assert.equal(replayed.manipulation.passed, true);
  assert.ok(replayed.runs.every((r) => r.arms.moflux.endsWith("/summary.json")));
  const missingBurst = change((x) => x.loadgen.classes.interactive.attemptSamples = []);
  assert.equal(missingBurst.sustainedZeroBorrowed.status, "inconclusive");
  assert.equal(missingBurst.returnCohort.sloGoodputRps, null);
  const probeOutput = path.join(temp, "probe.jsonl");
  const probe = spawnSync("python3", ["-c", `
import importlib.util, types
spec = importlib.util.spec_from_file_location("probe", "demo/backend-probe/sitecustomize.py")
p = importlib.util.module_from_spec(spec); spec.loader.exec_module(p)
class Scheduler:
    def __init__(self):
        self.running = [types.SimpleNamespace(request_id="chatcmpl-moflux-bench-batch-setup-1-a1-abcd")]
        self.waiting = []; self.kv_cache_manager = types.SimpleNamespace(usage=0.9)
    def add_request(self, request): pass
    def schedule(self): return types.SimpleNamespace(num_scheduled_tokens={self.running[0].request_id: 10})
p.install(types.SimpleNamespace(Scheduler=Scheduler, __file__="demo/backend-probe/sitecustomize.py"))
s = Scheduler(); s.add_request(s.running[0]); s.schedule()
`], { cwd: ROOT, env: { ...process.env, MOFLUX_BACKEND_EVENTS: probeOutput, MOFLUX_BURST_RECOVERY: "true", PYTHONDONTWRITEBYTECODE: "1" }, encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  const events = readFileSync(probeOutput, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(events[0].schemaVersion, 3);
  assert.deepEqual(events.find((e) => e.event === "pressure").runningRequestIds, ["moflux-bench-batch-setup-1-a1"]);
  assert.equal(events.find((e) => e.event === "first_scheduled").requestId, "moflux-bench-batch-setup-1-a1");
} finally { rmSync(temp, { recursive: true, force: true }); }
console.log("PASS burst recovery: matched traces, exact borrowing, invalid/censored/negative results, pair manipulation gates, dry-run safety, scheduler IDs, v4 clock/readiness/preflight gates");
