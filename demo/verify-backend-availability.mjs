import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AVAILABILITY_BURST, AVAILABILITY_RETURN_REQUEST, availabilityProtocol, availabilityTrace, backendAvailabilityEpisode, availabilityDistribution, lendingReopenings } from "./backend-availability-lib.mjs";
import { buildTrace, validateTrace } from "../load/trace-lib.mjs";
import { VLLM_METAL_LONG_CONTEXT_WORKLOAD } from "./vllm-contention-lib.mjs";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = execFileSync(process.execPath, [path.join(ROOT, "demo/vllm-contention.mjs"), "--backend=metal", "--workload=metal-long-context-v1", "--backend-availability", "--dry-run"], { encoding: "utf8" });
assert.match(dryRun, /long-context-backend-availability/);
assert.match(dryRun, /PASS dry-run/);
assert.throws(() => execFileSync(process.execPath, [path.join(ROOT, "demo/vllm-contention.mjs"), "--backend=nvidia", "--backend-availability", "--dry-run"], { stdio: "pipe" }), /Command failed/);
const availabilityDryRun = (...extra) => execFileSync(process.execPath, [path.join(ROOT, "demo/vllm-contention.mjs"),
  "--backend=metal", "--workload=metal-long-context-v1", "--dry-run", ...extra], { encoding: "utf8", stdio: "pipe" });
assert.match(dryRun, /backend-availability-fixed-burst-v3/, "v3 is the default protocol");
assert.match(availabilityDryRun("--backend-availability", "--availability-protocol=fixed-burst-v2"),
  /backend-availability-fixed-burst-v2/);
assert.throws(() => availabilityDryRun("--backend-availability", "--availability-protocol=fixed-burst-v1"), /Command failed/);
assert.throws(() => availabilityDryRun("--availability-protocol=fixed-burst-v2"), /Command failed/,
  "a protocol without --backend-availability would silently run the ordinary sweep");
assert.throws(() => availabilityProtocol("fixed-burst-v1"), /must be one of fixed-burst-v2, fixed-burst-v3/);
const requestId = "moflux-bench-interactive-1-a1";
const fixture = () => ({ seed: 1, arm: "moflux", startedAtEpochMs: 10000, nominalFloor: 3,
  workload: { interactiveResumeStartMs: 900, interactiveResumeDurationMs: 1000, maxAttempts: 1,
    engine: { kvCacheBlocks: 320, blockSize: 16 } }, cacheConfig: { numGpuBlocks: 320, blockSize: 16 },
  trace: { entries: [{ id: "interactive-1", class: "interactive", arrivalMs: 900 }] },
  loadgen: { startedAtEpochMs: 10000, backendClockErrorMs: 0, generatorSaturated: 0, classes: { interactive: { attemptSamples: [
    { requestId, sentAtMs: 900, endedAtMs: 2000, firstTokenAtMs: 1600, sentAtEpochMs: 10900,
      firstTokenAtEpochMs: 11600, endedAtEpochMs: 12000, httpStatus: 200, outcome: "completed" },
  ] } } },
  demandReturn: { restorationWasNeeded: true, floorRestoredAtMs: 1200 },
  samples: [
    { sampleStartedAtMs: 990, offsetMs: 1000, clockErrorMs: 0, classes: { interactive: { limits: { protectedConcurrent: 1 } } } },
    { sampleStartedAtMs: 1190, offsetMs: 1200, clockErrorMs: 0, classes: { interactive: { limits: { protectedConcurrent: 3 } } } },
  ],
  events: [
    { event: "installed", atEpochMs: 10000, clockErrorMs: 0, schemaVersion: 2, clockBasis: "realtime" },
    ...[10800, 10900, 11000, 11100, 11200].map((atEpochMs) => ({ event: "pressure", atEpochMs, clockErrorMs: 0, kvUsage: 0.98 })),
    { event: "enqueued", requestId, atEpochMs: 10950, clockErrorMs: 0 },
    { event: "first_scheduled", requestId, atEpochMs: 11500, clockErrorMs: 0, scheduledTokens: 100 },
  ],
});
const observed = backendAvailabilityEpisode(fixture());
assert.equal(observed.status, "observed");
assert.deepEqual(observed.gapMs, { lower: 295, upper: 515 });
assert.equal(observed.engineQueueMs, 550);
assert.equal(observed.clientFirstTokenAfterGrantMs, 400);
assert.equal(observed.dispatchToScheduleMs, 600);
assert.deepEqual([observed.clock.engineStepMs, observed.clock.samplerStepMs], [0, 0]);
// Free KV from the last pressure sample before enqueue: 2% of 320 blocks, 50ms old.
assert.deepEqual(observed.freeBlocksBeforeEnqueue, { blocks: 6, sampleAgeMs: 50, waiting: null });
const change = (mutate) => { const f = fixture(); mutate(f); return backendAvailabilityEpisode(f); };
assert.equal(change((f) => f.events = f.events.filter((e) => e.event !== "pressure" || e.atEpochMs > 10950))
  .freeBlocksBeforeEnqueue, null);
assert.equal(change((f) => f.events = []).status, "inconclusive");
assert.equal(change((f) => f.events.find((e) => e.event === "pressure").kvUsage = 0.2).status, "inconclusive");
// Client offsets are diagnostics; the gap uses engine and sampler wall time only.
assert.equal(change((f) => f.loadgen.backendClockErrorMs = null).clientClockErrorMs, null);
assert.equal(change((f) => f.loadgen.backendClockErrorMs = 40).status, "observed");
// The seed-3 pilot's rejection: wall/monotonic divergence accumulated over the
// arm, with no step. A shared wall clock makes that offset irrelevant.
assert.equal(change((f) => {
  for (const e of f.events) e.clockErrorMs = -18; for (const x of f.samples) x.clockErrorMs = -16;
}).status, "observed");
assert.equal(change((f) => f.events.forEach((e, i) => { e.clockErrorMs = -0.5 * i; })).status, "observed", "gradual slew is not a step");
const oldProbe = change((f) => { f.events[0].schemaVersion = 1; delete f.events[0].clockBasis; });
assert.equal(oldProbe.status, "inconclusive");
assert.ok(oldProbe.reasons.includes("scheduler_probe_clock_basis_unsupported"));
assert.ok(change((f) => f.events.find((e) => e.event === "pressure").clockErrorMs = null).reasons.includes("engine_event_clock_missing"));
assert.ok(change((f) => f.samples[1].clockErrorMs = undefined).reasons.includes("sampler_clock_step_missing_or_exceeds_5ms_in_window"));
assert.equal(change((f) => f.loadgen.generatorSaturated = 1).status, "inconclusive");
assert.equal(change((f) => f.cacheConfig.numGpuBlocks = 321).status, "inconclusive");
assert.ok(change((f) => f.samples[0].clockErrorMs = 15).reasons.includes("sampler_clock_step_missing_or_exceeds_5ms_in_window"));
assert.ok(change((f) => f.events.at(-1).clockErrorMs = 20).reasons.includes("engine_clock_step_exceeds_5ms_in_window"));
assert.equal(change((f) => f.demandReturn.floorRestoredAtMs = null).status, "inconclusive");
const early = change((f) => f.events.at(-1).atEpochMs = 10960);
assert.equal(early.serviceBeforeRestoration, true);
assert.equal(early.status, "served_before_restoration");
assert.equal(change((f) => f.events.at(-1).atEpochMs = 11100).status, "inconclusive");
assert.equal(change((f) => { f.arm = "static"; f.demandReturn.restorationWasNeeded = false; }).status, "not_applicable");
assert.ok(early.gapMs.upper < 0);
const failed = change((f) => { f.events.pop(); Object.assign(f.loadgen.classes.interactive.attemptSamples[0], { httpStatus: 429, outcome: "failed" }); });
assert.equal(failed.status, "failed");
const censored = change((f) => { f.events.pop(); f.events.push({ event: "pressure", atEpochMs: 14000, clockErrorMs: 0, kvUsage: 1 }); f.loadgen.classes.interactive.attemptSamples[0].outcome = "censored"; });
assert.equal(censored.status, "right_censored");
assert.equal(censored.censorLowerMs, 795);
assert.equal(change((f) => f.events.pop()).status, "inconclusive", "completed request with no schedule event is missing telemetry, not censoring");
const reopenFixture = fixture();
reopenFixture.samples[1].classes.batch = { borrowedConcurrent: 2 };
reopenFixture.samples.push({ sampleStartedAtMs: 1290, offsetMs: 1300, classes: {
  interactive: { limits: { protectedConcurrent: 1 }, demandState: "idle" }, batch: { borrowedConcurrent: 2 },
} });
const reopen = lendingReopenings({ ...reopenFixture, restoredAtMs: 1200 });
assert.equal(reopen.length, 1);
assert.equal(reopen[0].reopenedWithBorrowedOccupancyObserved, true);
assert.equal(reopen[0].sinceRestorationMs, 100);
assert.equal(reopen[0].kvUsageBefore, 0.98);
assert.deepEqual(lendingReopenings({ ...reopenFixture, restoredAtMs: null }), []);
const dist = availabilityDistribution([observed, early, failed, censored]);
assert.equal(dist.episodeCount, 4);
assert.equal(dist.observedCount, 1);
assert.equal(dist.counts.served_before_restoration, 1);
assert.equal(dist.counts.failed, 1);
assert.equal(dist.percentilesMs.p99.upper, 515);
assert.equal(dist.p99NominalTailCountAtLeast10, false);
assert.deepEqual(availabilityDistribution([]).ecdf, []);

for (let seed = 1; seed <= 30; seed += 1) {
  const config = { ...VLLM_METAL_LONG_CONTEXT_WORKLOAD, seed };
  const base = buildTrace(config);
  const trace = availabilityTrace(base, config);
  validateTrace(trace, config);
  assert.deepEqual(trace, availabilityTrace(base, config));
  assert.notEqual(trace.hash, base.hash);
  assert.deepEqual(trace.entries.filter((e) => e.id.startsWith("batch-pressure-")).map((e) => e.arrivalMs), [48000, 48100, 48200]);
  assert.equal(AVAILABILITY_BURST.leadMs, 12000);
  assert.equal(AVAILABILITY_RETURN_REQUEST.inputChars, 2000);
  assert.equal(trace.availabilityProtocol, "fixed-burst-v3");
  assert.equal(trace.entries.find((e) => e.id === "batch-prime-1").arrivalMs, 25000);
  const selected = trace.entries.find((e) => e.class === "interactive" && e.arrivalMs >= 60000);
  assert.equal(selected.arrivalMs, 60000);
  // Only the selected return is enlarged; every other request keeps its class size.
  assert.equal(selected.inputChars, AVAILABILITY_RETURN_REQUEST.inputChars);
  assert.deepEqual(trace.entries.filter((e) => e.inputChars !== undefined).map((e) => e.id), [selected.id]);
  // The v2 control is the same trace without the size key.
  const control = availabilityTrace(base, config, "fixed-burst-v2");
  validateTrace(control, config);
  assert.equal(control.availabilityProtocol, "fixed-burst-v2");
  assert.ok(control.entries.every((e) => !Object.hasOwn(e, "inputChars")));
  assert.deepEqual(control.entries.map(({ id, arrivalMs }) => [id, arrivalMs]),
    trace.entries.map(({ id, arrivalMs }) => [id, arrivalMs]));
  // Seed 3 replays the hash recorded by the fixed-burst-v2 pilot (20260927T212906Z).
  if (seed === 3) assert.equal(control.hash, "d67e425ba0c8d1880994ccf4b3886161ca0581876a8cd2b3228f28e966eebd1a");
}

// Exercise the actual load generator over HTTP: request IDs and partial tokens
// survive failures instead of being retained only for completed requests.
const temp = mkdtempSync(path.join(tmpdir(), "backend-availability-"));
const seen = [];
let stalled = false;
const server = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks)); seen.push(body);
  if (stalled) return;
  if (seen.length === 1) { res.writeHead(429, { "x-admission-reason": "budget_limit" }); res.end("{}"); return; }
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'); // deliberately missing DONE
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const out = path.join(temp, "result.json");
  const args = [path.join(ROOT, "load/loadgen.mjs"), `--targets=http://127.0.0.1:${server.address().port}`,
    "--duration-ms=500", "--interactive-rps=20", "--batch-rps=0", "--max-attempts=1", "--metrics-port=0",
    "--backend-availability=true", `--out=${out}`];
  const run = (extra = []) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...args, ...extra], { cwd: ROOT }); let logs = "";
    child.stdout.on("data", (b) => logs += b); child.stderr.on("data", (b) => logs += b);
    child.on("error", reject); child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(logs)));
  });
  await run();
  const summary = JSON.parse(readFileSync(out));
  const attempts = summary.classes.interactive.attemptSamples;
  assert.ok(seen.length > 1);
  assert.match(seen[0].request_id, /^moflux-bench-interactive-.*-a1$/);
  assert.equal(attempts.length, seen.length);
  assert.equal(attempts[0].httpStatus, 429);
  assert.equal(attempts[0].firstTokenAtMs, null);
  assert.ok(attempts.slice(1).every((a) => a.firstTokenAtMs !== null && a.outcome === "failed"));
  assert.ok(Number.isFinite(summary.backendClockErrorMs));
  assert.ok(attempts.every((a) => Number.isFinite(a.sentAtEpochMs) && Number.isFinite(a.endedAtEpochMs) &&
    a.endedAtEpochMs >= a.sentAtEpochMs && Math.abs(a.sentAtEpochMs - (summary.startedAtEpochMs + a.sentAtMs)) < 50));
  assert.ok(attempts.slice(1).every((a) => Number.isFinite(a.firstTokenAtEpochMs)));
  stalled = true;
  await run(["--drain-timeout-mode=censor", "--drain-idle-ms=100", "--drain-max-ms=1000"]);
  const stallSummary = JSON.parse(readFileSync(out));
  assert.equal(stallSummary.drain.outcome, "censored");
  assert.equal(stallSummary.drain.cause, "idle_stall");
  assert.ok(stallSummary.classes.interactive.attemptSamples.every((a) => a.outcome === "censored" && Number.isFinite(a.endedAtMs)));
  // Run the Python hook against a scheduler double. No model/import dependency.
  execFileSync("python3", [path.join(ROOT, "demo/backend-probe/verify_probe.py"), temp], { stdio: "pipe" });
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve)); rmSync(temp, { recursive: true, force: true });
}
console.log("PASS backend availability: grant bounds, pressure gates, missing data, negative gaps, censoring, distribution, HTTP and scheduler instrumentation");
