import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { BURST_CLOCK_LIMITS, analyzeClockAlignment, analyzeClockSeries, captureClockSample } from "./burst-clock-lib.mjs";
import { CONTAINER_CLOCK_PROGRAM, startContainerClockProbe } from "./burst-clock-probe.mjs";
import { waitForBurstHostReady } from "./burst-host-preflight-lib.mjs";
import { BURST_PROBE_SERVICES, startBurstRuntime } from "./burst-runtime-lib.mjs";
import { burstV4Preflight, widenBracket } from "./burst-v4-analysis-lib.mjs";

const EPOCH = 1_800_000_000_000;
// Synthetic clocks: wall = monotonic + error(t), read through Date.now's 1ms floor.
const series = ({ seconds = 180, stepMs = 250, error = () => 0, span = () => 0.01 } = {}) => {
  const rows = [];
  for (let t = 0; t <= seconds * 1000; t += stepMs) rows.push({ epochMs: Math.floor(EPOCH + t + error(t)),
    monotonicMs: 40_000 + t, readSpanMs: span(t) });
  return rows;
};
const bounds = (rows) => ({ startEpochMs: rows[0].epochMs, endEpochMs: rows.at(-1).epochMs });
const check = (rows, options) => analyzeClockSeries(rows, { ...bounds(rows), ...options });
const ppm = (rate) => (t) => t * rate / 1e6;

// ── known drift ──────────────────────────────────────────────────────
// The retained v3 pilots drifted about 30ppm: 5.4ms of raw range over 180s,
// at the raw 5ms rule's limit without any discontinuity in the clock.
const pilotDrift = check(series({ error: ppm(30) }));
assert.equal(pilotDrift.passed, true, pilotDrift.reasons.join());
assert.ok(pilotDrift.rawResidualRangeMs >= 5 && pilotDrift.rawResidualRangeMs < 6.5);
assert.ok(Math.abs(pilotDrift.fittedSlewPpm - 30) < 1);
assert.ok(pilotDrift.maxWindowDriftMs < 4);
assert.ok(pilotDrift.detrendedResidualRangeMs < 1.1);
for (const rate of [0, 43, -43, 85, 99]) assert.equal(check(series({ error: ppm(rate) })).passed, true, `${rate}ppm`);
for (const rate of [125, -125, 400]) {
  const excessive = check(series({ error: ppm(rate) }));
  assert.ok(excessive.reasons.includes("clock_slew_exceeded"), `${rate}ppm`);
  assert.ok(excessive.reasons.includes("clock_drift_exceeds_budget"), `${rate}ppm`);
  assert.ok(!excessive.reasons.includes("clock_step_exceeded"), "steady drift is not reported as a jump");
}
// Short captures: one millisecond tick must not read as hundreds of ppm.
assert.equal(check(series({ seconds: 5, error: (t) => t >= 2_000 ? 1 : 0 })).passed, true);
console.log("PASS  known drift: gradual slew within 100ppm passes; faster drift fails as drift, not as a jump");

// ── known jumps ──────────────────────────────────────────────────────
for (const size of [3, 5, 50, -3, -50]) {
  const jumped = check(series({ error: (t) => t >= 90_000 ? size : 0 }));
  assert.ok(jumped.reasons.includes("clock_step_exceeded"), `${size}ms`);
  assert.equal(jumped.stepViolationCount, 1);
  assert.equal(jumped.violations[0].kind, "step");
  assert.ok(Math.abs(jumped.violations[0].residualIncrementMs - size) <= 1);
}
// A jump on top of permitted drift is still a jump; the fit cannot absorb it.
const driftAndJump = check(series({ error: (t) => t * 30 / 1e6 + (t >= 60_000 ? 4 : 0) }));
assert.ok(driftAndJump.reasons.includes("clock_step_exceeded"));
// One millisecond is the wall clock's own resolution.
assert.equal(check(series({ error: (t) => t >= 90_000 ? 1 : 0 })).passed, true);
// A jump and its reversal are each discontinuities, even though the range returns.
assert.equal(check(series({ error: (t) => t >= 90_000 && t < 95_000 ? 6 : 0 })).stepViolationCount, 2);
// A backward wall clock is reported as such.
const backwards = check(series({ error: (t) => t >= 90_000 ? -400 : 0 }));
assert.ok(backwards.reasons.includes("wall_clock_backwards") && backwards.reasons.includes("clock_step_exceeded"));
const monoBackwards = series();
monoBackwards[100].monotonicMs -= 1_000;
assert.ok(check(monoBackwards).reasons.includes("monotonic_clock_backwards"));
// A fast slew stays under the step rule per reading and still exceeds the budget.
const fastSlew = check(series({ error: (t) => Math.min(12, Math.max(0, (t - 90_000) / 250 * 1.5)) }));
assert.ok(!fastSlew.reasons.includes("clock_step_exceeded"));
assert.ok(fastSlew.reasons.includes("clock_drift_exceeds_budget"));
assert.ok(fastSlew.maxWindowDriftMs >= 11);
// The correction episode recorded on this host: about 9ms inside 90s, no jump.
const episode = check(series({ seconds: 150, error: (t) => t * 30 / 1e6 + Math.min(5, Math.max(0, (t - 60_000) / 6_000)) }));
assert.equal(episode.passed, true, episode.reasons.join());
assert.ok(episode.maxWindowDriftMs > 7 && episode.maxWindowDriftMs <= 10);
console.log("PASS  known jumps: steps, reversals, backward clocks and fast slews fail; resolution ticks do not");

// ── missing and unusable samples ─────────────────────────────────────
const drop = (rows, from, to) => rows.filter((row) => row.monotonicMs - 40_000 < from || row.monotonicMs - 40_000 >= to);
assert.equal(check(drop(series(), 90_000, 90_750)).passed, true, "three lost readings stay inside one second");
const gap = analyzeClockSeries(drop(series(), 90_000, 91_250), bounds(series()));
assert.deepEqual(gap.reasons, ["sample_gap_exceeded"]);
assert.equal(gap.maxSampleGapMs, 1_500);
assert.equal(gap.violations[0].kind, "gap");
// A jump hidden inside a gap still shows between the readings on either side.
const hidden = analyzeClockSeries(drop(series({ error: (t) => t >= 90_500 ? 6 : 0 }), 90_000, 91_250), bounds(series()));
assert.ok(hidden.reasons.includes("clock_step_exceeded") && hidden.reasons.includes("sample_gap_exceeded"));
// Ungated gaps are reported; steps across them are still caught.
assert.equal(check(drop(series(), 90_000, 96_000), { maxGapMs: null }).passed, true);
assert.equal(check(drop(series(), 90_000, 96_000), { maxGapMs: null }).gapGated, false);
assert.ok(check(drop(series({ error: (t) => t >= 93_000 ? 6 : 0 }), 90_000, 96_000), { maxGapMs: null })
  .reasons.includes("clock_step_exceeded"));
// Coverage: the capture must reach both ends of the window it vouches for.
const full = series();
assert.deepEqual(analyzeClockSeries(full.slice(8), bounds(full)).reasons, ["capture_coverage_incomplete"]);
assert.deepEqual(analyzeClockSeries(full.slice(0, -8), bounds(full)).reasons, ["capture_coverage_incomplete"]);
assert.equal(analyzeClockSeries(full.slice(2, -2), bounds(full)).passed, true);
assert.equal(analyzeClockSeries(full, { startEpochMs: NaN, endEpochMs: full.at(-1).epochMs }).passed, false);
// A slow read is not clock evidence: it counts as missing, never as a jump.
const oneSlow = check(series({ span: (t) => t === 90_000 ? 4 : 0.01 }));
assert.equal(oneSlow.passed, true);
assert.equal(oneSlow.slowReadCount, 1);
assert.equal(oneSlow.maxReadSpanMs, 4);
assert.deepEqual(check(series({ span: (t) => t >= 90_000 && t < 91_250 ? 4 : 0.01 })).reasons, ["sample_gap_exceeded"]);
// Malformed rows fail closed and cannot be clipped away.
for (const corrupt of [(row) => { row.epochMs = null; }, (row) => { row.monotonicMs = NaN; },
  (row) => { delete row.readSpanMs; }, (row) => { row.readSpanMs = -1; }]) {
  const rows = series();
  corrupt(rows[300]);
  const result = analyzeClockSeries(rows, { ...bounds(series()), clipToCoverage: true });
  assert.deepEqual(result.reasons, ["invalid_samples"]);
  assert.deepEqual(result.invalidSampleIndices, [300]);
}
for (const rows of [undefined, [], [series()[0]], "rows", null]) assert.equal(analyzeClockSeries(rows).passed, false);
// Rows outside the capture are set aside; the capture itself is judged alone.
const longLived = series({ seconds: 600, error: (t) => t < 100_000 ? 40 : 0 });
const window = { startEpochMs: EPOCH + 200_000, endEpochMs: EPOCH + 380_000 };
assert.ok(analyzeClockSeries(longLived, window).reasons.includes("clock_step_exceeded"));
const clipped = analyzeClockSeries(longLived, { ...window, clipToCoverage: true });
assert.equal(clipped.passed, true);
assert.ok(clipped.clippedSampleCount > 1_000);
console.log("PASS  missing samples: bounded loss tolerated, gaps, slow reads, malformed rows and coverage fail closed");

// ── container alignment ──────────────────────────────────────────────
const probes = ({ seconds = 180, offset = () => 0, out = () => 1, back = () => 1, error = () => null, remoteSpan = 0.02 } = {}) => {
  const rows = [];
  for (let t = 0; t <= seconds * 1000; t += 250) {
    const failure = error(t);
    if (failure) { rows.push({ sampleId: rows.length + 1, error: failure }); continue; }
    rows.push({ sampleId: rows.length + 1,
      hostSentEpochMs: EPOCH + t, hostSentMonotonicMs: 40_000 + t, hostSentReadSpanMs: 0.01,
      hostReceivedEpochMs: EPOCH + t + out(t) + back(t), hostReceivedMonotonicMs: 40_000 + t + out(t) + back(t), hostReceivedReadSpanMs: 0.01,
      remoteEpochMs: Math.floor(EPOCH + t + out(t) + offset(t)), remoteMonotonicMs: 900 + t + out(t), remoteReadSpanMs: remoteSpan });
  }
  return rows;
};
const align = (options) => analyzeClockAlignment(probes(options), { startEpochMs: EPOCH, endEpochMs: EPOCH + (options?.seconds ?? 180) * 1000 });
const aligned = align({ offset: () => -1.5 });
assert.equal(aligned.passed, true, aligned.reasons.join());
assert.equal(aligned.maxUncertaintyMs, 4);
assert.ok(aligned.offsetIntervalMs.lower <= -1.5 && aligned.offsetIntervalMs.upper >= -1.5);
// The bound is the larger endpoint distance: offset and transport both count.
assert.equal(align({ offset: () => 6 }).passed, true);
assert.equal(align({ offset: () => 6 }).maxUncertaintyMs, 8);
// Proven misalignment in either direction fails, however fast the transport.
for (const size of [15, -15, 400, -400]) {
  const off = align({ offset: () => size });
  assert.ok(off.reasons.includes("alignment_uncertainty_exceeded"), `${size}ms`);
  assert.equal(off.usableSampleCount, 0);
}
// Misalignment that begins mid-capture is caught at the first probe that proves it.
const drifting = align({ offset: (t) => t >= 120_000 ? -14 : -1 });
assert.ok(drifting.reasons.includes("alignment_uncertainty_exceeded"));
assert.equal(drifting.violations[0].index, 480);
// A slow probe proves neither alignment nor misalignment; it is missing.
const slowOnce = align({ back: (t) => t === 90_000 ? 150 : 1 });
assert.equal(slowOnce.passed, true);
assert.equal(slowOnce.uninformativeSampleCount, 1);
assert.equal(slowOnce.roundTripMs.max, 151);
const slowTransport = align({ back: () => 30 });
assert.equal(slowTransport.passed, false);
assert.equal(slowTransport.misalignedSampleCount, 0);
assert.ok(slowTransport.reasons.includes("insufficient_samples"));
// Lost probes: one is tolerated, a run beyond the probe gap limit is not.
const lost = align({ error: (t) => t === 90_000 ? "timeout" : null });
assert.equal(lost.passed, true);
assert.deepEqual(lost.errorCounts, { timeout: 1 });
assert.equal(lost.maxProbeGapMs, 500);
const dead = align({ error: (t) => t >= 90_000 ? "process_exited" : null });
assert.deepEqual(dead.reasons, ["capture_coverage_incomplete"]);
const outage = align({ error: (t) => t >= 90_000 && t < 93_000 ? "timeout" : null });
assert.deepEqual(outage.reasons, ["probe_gap_exceeded"]);
assert.equal(outage.errorSampleCount, 12);
assert.equal(align({ remoteSpan: 3 }).passed, false, "a slow remote read is not alignment evidence");
// The container may step to follow the host: reported, and judged by alignment.
const followed = align({ offset: (t) => t < 90_000 ? -1 - t * 50 / 1e6 : -1 });
assert.equal(followed.passed, true);
assert.equal(followed.remoteClock.gated, false);
assert.equal(followed.remoteClock.stepCount, 1);
assert.ok(followed.remoteClock.maxResidualIncrementMs >= 4);
// Malformed and backward probes fail closed.
const malformed = probes();
malformed[40].remoteEpochMs = null;
assert.ok(analyzeClockAlignment(malformed, { startEpochMs: EPOCH, endEpochMs: EPOCH + 180_000 }).reasons.includes("invalid_samples"));
const reversed = probes();
reversed[40].hostReceivedEpochMs = reversed[40].hostSentEpochMs - 5;
assert.ok(analyzeClockAlignment(reversed, { startEpochMs: EPOCH, endEpochMs: EPOCH + 180_000 }).reasons.includes("clock_backwards_during_probe"));
for (const rows of [undefined, [], "rows", null]) assert.equal(analyzeClockAlignment(rows).passed, false);
assert.deepEqual(widenBracket({ lowerEpochMs: 100, upperEpochMs: 360, grant: "g" }),
  { lowerEpochMs: 90, upperEpochMs: 370, grant: "g", observedLowerEpochMs: 100, observedUpperEpochMs: 360, timingUncertaintyMs: 10 });
assert.equal(widenBracket(null), null);
assert.equal(BURST_CLOCK_LIMITS.uncertaintyBudgetMs, 10);
console.log("PASS  alignment: bracketed bounds, proven misalignment, slow and lost probes, container steps");

// ── real paired readings and the container probe ─────────────────────
const live = [];
for (let i = 0; i < 6; i++) { live.push(captureClockSample()); await delay(20); }
assert.ok(live.every((row) => row.readSpanMs >= 0 && row.readSpanMs < 5 && Number.isInteger(row.epochMs)));
function fakeDocker(respond) {
  const calls = [];
  const spawn = (command, argv) => {
    const child = new EventEmitter();
    Object.assign(child, { exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough(),
      kill() { if (child.exitCode === null) { child.exitCode = 0; queueMicrotask(() => child.emit("exit", 0)); } return true; } });
    child.stdin = new Writable({ write(chunk, _encoding, done) {
      for (const line of String(chunk).split("\n").filter(Boolean)) respond(Number(line), child);
      done();
    } });
    calls.push({ command, argv });
    return child;
  };
  return { spawn, calls };
}
const reply = (id, child, shift = 0) => child.stdout.write(`${JSON.stringify({ id, epochMs: Date.now() + shift,
  monotonicMs: performance.now(), readSpanMs: 0.02 })}\n`);
{
  const docker = fakeDocker((id, child) => reply(id, child));
  const probe = await startContainerClockProbe({ service: "tyr-moflux", spawn: docker.spawn });
  const row = await probe.sample();
  assert.deepEqual(docker.calls[0].argv.slice(0, 6), ["compose", "exec", "-T", "tyr-moflux", "node", "-e"]);
  assert.equal(docker.calls[0].argv[6], CONTAINER_CLOCK_PROGRAM);
  assert.equal(row.error, undefined);
  assert.ok(row.hostSentEpochMs <= row.remoteEpochMs && row.remoteEpochMs <= row.hostReceivedEpochMs);
  await probe.stop();
  assert.equal((await probe.sample()).error, "stopped");
}
{
  // A silent container times out; the late answer cannot be reattached.
  const docker = fakeDocker(() => {});
  const probe = await startContainerClockProbe({ service: "latchflo", spawn: docker.spawn, timeoutMs: 30 });
  const row = await probe.sample();
  assert.equal(row.error, "timeout");
  assert.equal(row.remoteEpochMs, null);
  assert.ok(Number.isFinite(row.hostSentEpochMs) && Number.isFinite(row.hostReceivedEpochMs));
  await probe.stop();
}
{
  const docker = fakeDocker((_id, child) => child.stdout.write("not json\n"));
  const probe = await startContainerClockProbe({ service: "tyr-moflux", spawn: docker.spawn });
  assert.equal((await probe.sample()).error, "invalid_response");
  assert.equal((await probe.sample()).error, "invalid_response", "a failed probe stays failed");
  await probe.stop();
}
{
  const docker = fakeDocker((_id, child) => { child.exitCode = 1; child.emit("exit", 1); });
  const probe = await startContainerClockProbe({ service: "tyr-moflux", spawn: docker.spawn });
  assert.equal((await probe.sample()).error, "process_exited");
  await probe.stop();
}
await assert.rejects(startContainerClockProbe({}), /requires a service/u);
{
  // The fixed container program itself, run locally: this host is aligned with itself.
  const probe = await startContainerClockProbe({ command: "env", args: [],
    env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` }, timeoutMs: 5_000 });
  const rows = [];
  for (let i = 0; i < 5; i++) { rows.push(await probe.sample()); await delay(20); }
  await probe.stop();
  assert.ok(rows.every((row) => !row.error), JSON.stringify(rows.find((row) => row.error)));
  assert.ok(rows.slice(1).every((row) => row.remoteEpochMs >= row.hostSentEpochMs - 1 && row.remoteEpochMs <= row.hostReceivedEpochMs + 1));
}
console.log("PASS  container probe: fixed program, correlation, timeout, invalid output and exit are explicit rows");

// ── runtime: preflights gate collection ──────────────────────────────
let quietClock = 0;
const quietHost = await waitForBurstHostReady({ now: () => quietClock, sleep: async (ms) => { quietClock += ms; },
  readPressure: async () => ({ memory: { pressure: "normal" }, vm: { swapouts: 7, pageSizeBytes: 16_384 } }) });
const fakeProbe = (shift = 0, startupErrors = 0) => {
  let stopped = 0, id = 0;
  const start = async ({ args }) => ({ args, remaining: startupErrors,
    async sample() {
      if (this.remaining > 0) { this.remaining--; return { sampleId: ++id, error: "timeout" }; }
      const sent = captureClockSample(), remote = captureClockSample(), received = captureClockSample();
      return { sampleId: ++id, hostSentEpochMs: sent.epochMs, hostSentMonotonicMs: sent.monotonicMs, hostSentReadSpanMs: sent.readSpanMs,
        hostReceivedEpochMs: received.epochMs, hostReceivedMonotonicMs: received.monotonicMs, hostReceivedReadSpanMs: received.readSpanMs,
        remoteEpochMs: remote.epochMs + shift, remoteMonotonicMs: remote.monotonicMs, remoteReadSpanMs: remote.readSpanMs };
    },
    async stop() { stopped++; } });
  return { start, stopped: () => stopped };
};
const runtime = async ({ probe = fakeProbe(), waitForHost = async () => quietHost, signal, readPoolStats } = {}) => {
  const written = [], progress = [];
  const started = startBurstRuntime({ dockerArgs: ["compose", "-p", "test"], signal, sleep: (ms) => delay(ms, undefined, { signal }),
    readPressure: async () => ({}), readPoolStats: readPoolStats ?? (async () => ({ admissionClasses: { classes: { batch: {
      inFlight: 0, limits: { protectedConcurrent: 1 } } } } })),
    writePreflight: (data) => written.push(structuredClone(data)), onProgress: (message) => progress.push(message),
    clockPreflightMs: 700, startProbe: probe.start, waitForHost });
  return { started, written, progress, probe };
};
{
  const { started, written, progress, probe } = await runtime();
  const active = await started;
  assert.deepEqual(Object.keys(BURST_PROBE_SERVICES), ["tyr", "latchflo"]);
  assert.equal(written.length, 2);
  assert.equal(written[0].host, null, "clock evidence is retained before the host check starts");
  assert.ok(written[1].clock.clockSamples.length >= 3 && written[1].clock.clockAlignment.tyr.length >= 3);
  assert.equal(burstV4Preflight(written[1], { requiredClockDurationMs: 700 }).passed, true);
  assert.equal(burstV4Preflight(written[1]).passed, false, "a short preflight never satisfies the 180s protocol");
  assert.match(active.readinessUrl, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{48}$/u);
  const state = await (await fetch(active.readinessUrl)).json();
  assert.deepEqual([state.batchInFlight, state.batchProtectedConcurrent], [0, 1]);
  assert.ok(state.sampleStartedAtEpochMs <= state.observedAtEpochMs);
  assert.equal((await fetch(active.readinessUrl.replace(/.$/u, "x"))).status, 404);
  assert.equal((await fetch(active.readinessUrl, { method: "DELETE" })).status, 404);
  const report = (body) => fetch(active.readinessUrl, { method: "POST", body: JSON.stringify(body) });
  assert.equal((await report({ status: "missed", reasons: ["prime_not_completed"] })).status, 204);
  assert.equal((await report({ status: "ready", reasons: [] })).status, 204);
  assert.equal((await fetch(active.readinessUrl, { method: "POST", body: "x".repeat(8_192) })).status, 503);
  assert.ok(progress.some((line) => /SETUP READINESS MISSED \(prime_not_completed\)/u.test(line)));
  await delay(300);
  const timing = await active.stop();
  assert.equal(await active.stop(), timing, "stop is idempotent");
  assert.deepEqual(timing.setupReports.map((r) => r.status), ["missed", "ready"]);
  assert.deepEqual(timing.errors, []);
  assert.ok(timing.clockSamples.length >= 2 && timing.clockAlignment.latchflo.length >= 2);
  assert.ok(timing.clockSamples[0].epochMs >= written[1].clock.clockSamples.at(-1).epochMs, "measured capture excludes preflight rows");
  assert.equal(probe.stopped(), 2);
  await assert.rejects(fetch(active.readinessUrl), "the readiness endpoint closes with the runtime");
}
{
  // A misaligned container stops the trial before the host check or any request.
  let hostChecked = false;
  const { started, written, probe } = await runtime({ probe: fakeProbe(40), waitForHost: async () => { hostChecked = true; return quietHost; } });
  await assert.rejects(started, /burst clock preflight failed \(.*tyr: alignment_uncertainty_exceeded.*\); trial not started/u);
  assert.equal(hostChecked, false);
  assert.equal(written.length, 1, "the failing clock evidence is retained");
  assert.equal(probe.stopped(), 2);
}
{
  // docker exec start-up is waited out before the capture; a probe that never answers stops the trial.
  const slowStart = await runtime({ probe: fakeProbe(0, 3) });
  const active = await slowStart.started;
  assert.ok(slowStart.written[1].clock.clockAlignment.tyr.every((row) => !row.error));
  await active.stop();
  const silent = await runtime({ probe: fakeProbe(0, Infinity) });
  await assert.rejects(silent.started, /burst clock probe for tyr did not answer; trial not started/u);
  assert.equal(silent.written.length, 0);
  assert.equal(silent.probe.stopped(), 2);
}
{
  const { started, written } = await runtime({ waitForHost: async () => ({ ...quietHost, status: "timeout", passed: false }) });
  await assert.rejects(started, /burst host preflight failed \(preflight_did_not_finish_ready\).*trial not started/u);
  assert.equal(written.length, 2);
}
{
  const { started } = await runtime({ readPoolStats: async () => { throw new Error("tyr unavailable"); } });
  const active = await started;
  assert.equal((await fetch(active.readinessUrl)).status, 503);
  await active.stop();
}
{
  const controller = new AbortController();
  const { started, probe } = await runtime({ signal: controller.signal });
  setTimeout(() => controller.abort(new Error("interrupted")), 150);
  await assert.rejects(started);
  assert.equal(probe.stopped(), 2);
}
console.log("PASS  runtime: clock then host preflight gate collection; readiness endpoint, reports and cleanup");
