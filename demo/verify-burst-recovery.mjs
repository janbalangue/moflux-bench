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
  const pressure = [];
  for (let offset = 59_900; offset <= 60_100 + burstWorkload(protocol).interactiveResumeDurationMs; offset += 100) pressure.push({ event: "pressure", atEpochMs: epoch + offset,
    clockErrorMs: 0, runningRequestIds: offset < 66_000 + (variant === "long" ? 10_000 : 0)
      ? [1, 2, 3].map((i) => `moflux-bench-batch-setup-${i}-a1`) : [], waitingRequestIds: [] });
  return { seed, variant, protocol, trace, arm: { pool: "test-pool", port: 8104 },
    loadgen: { trace: { hash: trace.hash }, generatorSaturated: 0, backendClockErrorMs: 0, startedAtEpochMs: epoch,
      classes: Object.fromEntries(["interactive", "batch"].map((c) => [c, { serverError: 0, transportError: 0, requestError: 0,
        upstreamReject: 0, localRejectGrantUnavailable: {}, attemptSamples: attempts.filter((a) => a.requestId.includes(`-${c}-`)) }])) },
    managed: { samples, errors: [] }, backendEvents: [{ event: "installed", schemaVersion: 3, schedulerSourceSha256: "source" }, ...pressure],
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
assert.equal(change((x) => {
  for (const s of x.managed.samples) if (s.offsetMs < 42000) s.classes.batch.limits.protectedConcurrent = 0;
}).gates.find((g) => g.name === "batchFloorReadyBeforeSetup").passed, false);
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
assert.equal(change((x) => x.managed.samples.at(-1).clockErrorMs = 6).valid, false);
const clockGate = (analysis) => analysis.gates.find((g) => g.name === "clockStable");
const drift = clockGate(change((x) => x.managed.samples.at(-1).clockErrorMs = 6));
assert.equal(drift.passed, false);
assert.deepEqual(drift.observed.failedSources, ["managed"]);
assert.equal(drift.observed.managed.minErrorMs, 0);
assert.equal(drift.observed.managed.maxErrorMs, 6);
assert.equal(drift.observed.managed.rangeMs, 6);
assert.equal(drift.observed.managed.maxRangeMs, 5);
// The stream gate bounds drift, not absolute offset; keep the existing rule.
assert.equal(clockGate(change((x) => { for (const s of x.managed.samples) s.clockErrorMs = 6; })).passed, true);
assert.equal(clockGate(change((x) => x.managed.samples.at(-1).clockErrorMs = 5)).passed, true);
// A fitted, smooth drift is descriptive and cannot rescue a failed raw-range gate.
const linearDrift = clockGate(change((x) => {
  for (const sample of x.managed.samples) sample.clockErrorMs = sample.offsetMs * 40 / 1_000_000;
}));
assert.equal(linearDrift.passed, false);
assert.ok(Math.abs(linearDrift.observed.managed.fittedDriftPpm - 40) < 0.00001);
assert.ok(linearDrift.observed.managed.residualRangeMs < 0.00001);
assert.equal(linearDrift.observed.managed.captureDurationMs, 150_500);
assert.equal(clockGate(result).observed.managed.fittedDriftPpm, 0);
const missingClock = clockGate(change((x) => delete x.backendEvents.at(-1).clockErrorMs));
assert.deepEqual(missingClock.observed.failedSources, ["backend"]);
assert.equal(missingClock.observed.backend.nonFiniteCount, 1);
assert.equal(clockGate(change((x) => x.backendEvents = [x.backendEvents[0]])).observed.backend.sampleCount, 0);
const loadClock = clockGate(change((x) => x.loadgen.backendClockErrorMs = -6));
assert.deepEqual(loadClock.observed.failedSources, ["loadgen"]);
assert.equal(loadClock.observed.loadgen.backendClockErrorMs, -6);
assert.equal(loadClock.observed.loadgen.maxAbsoluteErrorMs, 5);
assert.equal(change((x) => x.managed.samples = x.managed.samples.filter((s) => s.offsetMs < 150000)).valid, false);
// Coverage must extend through the first sample at or beyond each protocol's
// horizon, including when no telemetry remains inside the return window.
const samplerGate = (analysis) => analysis.gates.find((g) => g.name === "samplerIntegrity");
for (const protocol of ["burst-recovery-v1", "burst-recovery-v2", BURST_PROTOCOL]) {
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
console.log("PASS burst recovery: matched traces, exact borrowing, invalid/censored/negative results, pair manipulation gates, dry-run safety, scheduler IDs");
