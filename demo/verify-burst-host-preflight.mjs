import assert from "node:assert/strict";
import { BURST_HOST_PREFLIGHT_POLICY, summarizeBurstHostPreflight, waitForBurstHostReady } from "./burst-host-preflight-lib.mjs";

const pressure = (swapouts = 10, level = "normal") => ({
  memory: { pressure: level }, vm: { swapouts, pageSizeBytes: 16_384 },
  therm: { thermalWarning: false, performanceWarning: false },
});
async function run({ sample = () => pressure(), advance = (ms) => ms, ...options } = {}) {
  let time = 0, index = 0;
  const logged = [];
  const result = await waitForBurstHostReady({
    now: () => time,
    sleep: async (ms) => { time += advance(ms, index); },
    readPressure: async () => sample(index++, time),
    onSample: (value) => { logged.push(structuredClone(value)); },
    ...options,
  });
  assert.equal(logged.length, result.samples.length, "every sample is logged");
  return result;
}

const clean = await run();
assert.equal(clean.status, "ready");
assert.equal(clean.passed, true);
assert.equal(clean.durationMs, 10_000);
assert.equal(clean.samples.length, 11);
assert.equal(summarizeBurstHostPreflight(clean).passed, true);
assert.equal(clean.validation.quietWindow.durationMs, 10_000);

for (const level of ["warn", "critical"]) {
  const result = await run({ sample: (i) => pressure(10, i === 4 ? level : "normal") });
  assert.equal(result.durationMs, 15_000);
  assert.deepEqual(result.samples[4].reasons, [`memory_pressure_${level}`]);
}
const swapping = await run({ sample: (i) => pressure(i) });
assert.equal(swapping.status, "timeout");
assert.equal(swapping.durationMs, 60_000);
assert.equal(swapping.passed, false);
assert.ok(swapping.samples.slice(1).every((s) => s.reasons.includes("swapouts_increased")));
const settles = await run({ sample: (i) => pressure(i < 4 ? i : 4) });
assert.equal(settles.durationMs, 15_000);

for (const bad of [null, {}, { memory: { pressure: "normal" } }, pressure(NaN), pressure(Infinity),
  { ...pressure(), vm: { swapouts: 10, pageSizeBytes: NaN } }]) {
  const result = await run({ sample: (i) => i === 4 ? bad : pressure() });
  assert.ok(result.durationMs >= 15_000);
  assert.ok(result.samples[4].reasons.length > 0);
}
const readError = await run({ sample: (i) => { if (i === 4) throw new Error("missing vm_stat"); return pressure(); } });
assert.equal(readError.samples[4].error, "missing vm_stat");
assert.ok(readError.samples[4].reasons.includes("read_error"));
const regresses = await run({ sample: (i) => pressure(i < 4 ? 10 : 9) });
assert.equal(regresses.durationMs, 15_000);
assert.ok(regresses.samples[4].reasons.includes("swapout_counter_regression"));
const gaps = await run({ advance: (ms, index) => index === 4 ? 2_000 : ms });
assert.equal(gaps.durationMs, 16_000);
assert.ok(gaps.samples[4].reasons.includes("sample_gap_or_clock_regression"));

const forged = structuredClone(clean);
forged.samples[5].vm.swapouts = 11;
assert.equal(summarizeBurstHostPreflight(forged).passed, false, "passed flag cannot override raw evidence");
assert.equal(summarizeBurstHostPreflight({ passed: true, status: "ready" }).passed, false);
assert.equal(summarizeBurstHostPreflight({ ...clean, quietWindowMs: 1 }).passed, false);
assert.equal(summarizeBurstHostPreflight({ ...clean, status: "timeout" }).passed, false);
assert.equal(summarizeBurstHostPreflight({ ...clean, passed: false }).passed, false);
assert.equal(summarizeBurstHostPreflight({ ...clean, durationMs: 12_000 }).passed, false, "stale evidence fails");
const missingTiming = structuredClone(clean);
delete missingTiming.samples[7].atMs;
assert.equal(summarizeBurstHostPreflight(missingTiming).passed, false);

const cancelled = new AbortController();
cancelled.abort();
await assert.rejects(waitForBurstHostReady({ readPressure: () => pressure(), signal: cancelled.signal }),
  { name: "AbortError" });
const duringRead = new AbortController();
await assert.rejects(waitForBurstHostReady({ readPressure: () => {
  queueMicrotask(() => duringRead.abort());
  return new Promise(() => {});
}, signal: duringRead.signal }), { name: "AbortError" });
const duringSleep = new AbortController();
await assert.rejects(waitForBurstHostReady({ readPressure: () => pressure(), sleep: () => {
  queueMicrotask(() => duringSleep.abort());
  return new Promise(() => {});
}, signal: duringSleep.signal }), { name: "AbortError" });
await assert.rejects(waitForBurstHostReady({ readPressure: () => pressure(), onSample: () => { throw new Error("log failed"); } }),
  /log failed/u);
const blockedRead = await waitForBurstHostReady({ readPressure: () => new Promise(() => {}),
  timeoutMs: 20, quietWindowMs: 10, intervalMs: 1 });
assert.equal(blockedRead.status, "timeout");
assert.equal(blockedRead.passed, false);
assert.match(blockedRead.samples[0].error, /deadline/u);
assert.equal(BURST_HOST_PREFLIGHT_POLICY.maxSampleGapMs, 1_500);
console.log("Burst host preflight verified: readiness, resets, raw validation, timeout, and cancellation.");
