import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BURST_REPLAY_PROTOCOL, BURST_SETUP_MAX_WAIT_MS, burstSetupVerdict, observeBurstSetup, pairedClockSample,
  replayBurstTrace, validateBurstReplayOptions } from "./burst-replay-lib.mjs";

const entries = [
  { id: "interactive-warmup-1", class: "interactive", arrivalMs: 5_000 },
  { id: "batch-prime-1", class: "batch", arrivalMs: 41_000, inputChars: 400, maxTokens: 1 },
  { id: "batch-setup-1", class: "batch", arrivalMs: 42_000 },
  { id: "batch-setup-2", class: "batch", arrivalMs: 44_000 },
  { id: "batch-setup-3", class: "batch", arrivalMs: 46_000 },
  { id: "interactive-burst-1", class: "interactive", arrivalMs: 60_000 },
  { id: "interactive-burst-2", class: "interactive", arrivalMs: 60_000 },
  { id: "interactive-steady-1", class: "interactive", arrivalMs: 61_029 },
  { id: "batch-steady-1", class: "batch", arrivalMs: 62_042 },
  { id: "interactive-steady-89", class: "interactive", arrivalMs: 148_998 },
];
const originalEntries = structuredClone(entries);
const epochStart = 1_800_000_000_000;
const successfulPrime = (at = 41_400) => ({ outcome: "completed", outputTokens: 1,
  outputTokensReported: true, endedAtEpochMs: epochStart + at });
const config = { burstRecoveryProtocol: BURST_REPLAY_PROTOCOL,
  burstSetupReadinessUrl: "http://127.0.0.1:8123/readiness-test", traceFile: "provided",
  backendAvailability: true, maxAttempts: 1 };

async function scenario({ primeCompletedMs = 41_400, prime = successfulPrime(primeCompletedMs),
  readinessAtMs = 42_000, requestLatencyMs = 0, read = null, missingPrime = false } = {}) {
  let now = 0;
  const sent = [];
  const polls = [];
  const result = await replayBurstTrace({ entries,
    scheduleEntry: async (entry) => {
      now = Math.max(now, entry.arrivalMs);
      sent.push({ ...entry, actualSentMs: now });
    },
    offsetMs: () => now,
    epochMs: () => epochStart + now,
    sleep: async (ms) => { now += ms; },
    getPrimeAttempt: () => missingPrime ? null : now >= primeCompletedMs ? prime : { endedAtEpochMs: null },
    readReadiness: async (timeoutMs) => {
      polls.push({ atMs: now, timeoutMs });
      now += requestLatencyMs;
      if (read) return read({ now, timeoutMs });
      return { ready: now >= readinessAtMs, observedAtEpochMs: epochStart + now,
        batchInFlight: 0, protectedConcurrent: now >= readinessAtMs ? 1 : 0 };
    },
  });
  return { result, now, sent, polls };
}

assert.equal(validateBurstReplayOptions({}, { entries }), false);
assert.equal(validateBurstReplayOptions(config, { entries }), true);
for (const bad of [
  { burstRecoveryProtocol: "burst-recovery-v3" },
  { burstRecoveryProtocol: "" },
  { burstSetupReadinessUrl: "" },
  { burstSetupReadinessUrl: "http://example.com:8123/readiness" },
  { burstSetupReadinessUrl: "http://127.0.0.1/readiness" },
  { burstSetupReadinessUrl: "http://user:secret@127.0.0.1:8123/readiness" },
  { burstSetupReadinessUrl: "https://127.0.0.1:8123/readiness" },
  { backendAvailability: false }, { traceFile: "" }, { maxAttempts: 2 },
]) assert.throws(() => validateBurstReplayOptions({ ...config, ...bad }, { entries }));
assert.throws(() => validateBurstReplayOptions(config, { entries: entries.filter((e) => e.id !== "batch-prime-1") }));
assert.throws(() => validateBurstReplayOptions(config, { entries: [...entries, entries[1]] }));
assert.throws(() => validateBurstReplayOptions(config, {
  entries: entries.map((e) => e.id === "batch-prime-1" ? { ...e, maxTokens: 2 } : e),
}));
console.log("PASS  v4 requires explicit compatible flags and a canonical trace with loopback readiness");

// ── burst-recovery-v4: observe-only checkpoint, arrivals stay fixed ──
// Simulated time: the prime is sent at 41000ms, setup request 1 at 42000ms,
// and a readiness read takes `latencyMs`. Nothing here schedules a request.
async function checkpoint({ primeEndsAtMs = 41_400, prime = successfulPrime(primeEndsAtMs), setupSentAtMs = 42_000,
  latencyMs = 10, floorAtMs = 0, failReads = false, missingPrime = false, neverSent = false } = {}) {
  let now = 0;
  const reads = [];
  const result = await observeBurstSetup({
    offsetMs: () => now, epochMs: () => epochStart + now, sleep: async (ms) => { now += ms; },
    getPrimeAttempt: () => missingPrime ? undefined : now >= 41_000 ? (now >= primeEndsAtMs ? prime : { endedAtEpochMs: null, outcome: "failed" }) : undefined,
    getSetupAttempt: () => !neverSent && now >= setupSentAtMs ? { sentAtEpochMs: epochStart + setupSentAtMs } : undefined,
    readReadiness: async (timeoutMs) => {
      reads.push({ atMs: now, timeoutMs });
      const sampleStartedAtEpochMs = epochStart + now + 1;
      now += latencyMs;
      if (failReads) throw new Error("readiness HTTP 503");
      return { sampleStartedAtEpochMs, observedAtEpochMs: epochStart + now - 1,
        batchInFlight: now >= primeEndsAtMs + latencyMs ? 0 : 1, batchProtectedConcurrent: now >= floorAtMs ? 1 : 0 };
    },
  });
  return { result, reads, now };
}
{
  const { result, reads, now } = await checkpoint();
  assert.equal(result.status, "ready");
  assert.deepEqual(result.reasons, []);
  assert.equal(reads[0].atMs, 41_000, "observation begins with the prime, never earlier");
  assert.ok(reads.every((read) => read.timeoutMs === 250));
  assert.ok(result.observations.length >= 9 && result.observations.length <= 11);
  assert.ok(now < 42_100, "the verdict is available as soon as setup request 1 has been sent");
  assert.equal(result.setupSentAtEpochMs, epochStart + 42_000);
  assert.ok(result.observation.receivedAtEpochMs <= result.setupSentAtEpochMs);
  assert.ok(result.setupSentAtEpochMs - result.observation.sampleStartedAtEpochMs <= 120);
  assert.equal(result.observations[0].batchInFlight, 1, "earlier observations are retained, not selected");
}
for (const [options, reasons] of [
  // The 8.2s prime of pilot 20261004T173611Z: identified at 42s, not after the trace.
  [{ primeEndsAtMs: 49_200 }, ["prime_not_completed", "batch_request_in_flight"]],
  [{ prime: { ...successfulPrime(), outcome: "failed" } }, ["prime_not_completed_with_one_reported_token"]],
  [{ prime: { ...successfulPrime(), outputTokens: 2 } }, ["prime_not_completed_with_one_reported_token"]],
  [{ prime: { ...successfulPrime(), outputTokensReported: false } }, ["prime_not_completed_with_one_reported_token"]],
  [{ missingPrime: true, primeEndsAtMs: 0 }, ["prime_attempt_missing"]],
  [{ floorAtMs: 60_000 }, ["batch_protected_floor_not_one"]],
  [{ failReads: true }, ["no_readiness_observation_before_setup"]],
  [{ latencyMs: 1_200 }, ["no_readiness_observation_before_setup"]],
  [{ neverSent: true }, ["setup_send_missing", "no_readiness_observation_before_setup"]],
]) {
  const { result, now } = await checkpoint(options);
  assert.equal(result.status, "missed", JSON.stringify(options));
  assert.deepEqual(result.reasons, reasons, JSON.stringify(options));
  assert.ok(now <= 43_300, "a missed checkpoint is reported at once and never waits for readiness");
}
{
  // The analysis recomputes the verdict from the retained rows and the prime's final state.
  const { result } = await checkpoint({ primeEndsAtMs: 49_200 });
  const later = burstSetupVerdict({ observations: result.observations, prime: successfulPrime(49_200),
    setupSentAtEpochMs: result.setupSentAtEpochMs });
  assert.deepEqual(later.reasons, ["prime_completed_after_setup_send", "readiness_observed_before_prime_completed", "batch_request_in_flight"]);
  assert.equal(later.primeEndedBeforeSetupMs, -7_200);
  const { result: ready } = await checkpoint();
  const verdict = (change) => { const rows = structuredClone(ready.observations); change(rows);
    return burstSetupVerdict({ observations: rows, prime: successfulPrime(), setupSentAtEpochMs: ready.setupSentAtEpochMs }); };
  assert.equal(verdict(() => {}).ready, true);
  assert.ok(verdict((rows) => { rows.at(-1).sampleStartedAtEpochMs -= 600; }).reasons.includes("readiness_observation_stale"));
  assert.equal(verdict((rows) => { rows.at(-1).sampleStartedAtEpochMs -= 380; }).ready, true, "500ms is inclusive");
  assert.deepEqual(verdict((rows) => { rows.at(-1).batchInFlight = null; }).reasons, ["batch_request_in_flight"]);
  assert.deepEqual(verdict((rows) => { rows.at(-1).error = "timeout"; rows.at(-2).batchProtectedConcurrent = 0; }).reasons,
    ["batch_protected_floor_not_one"], "an errored row is skipped; the previous answer decides");
  for (const bad of [undefined, {}, { observations: "rows" }]) assert.equal(burstSetupVerdict(bad).ready, false);
}
console.log("PASS  v4 checkpoint observes prime, in-flight and floor state before setup 1 and never moves an arrival");

{
  const { result, sent } = await scenario();
  assert.equal(result.status, "ready");
  assert.equal(result.shiftMs, 0);
  assert.equal(result.primeCompletedAtEpochMs, epochStart + 41_400);
  assert.deepEqual(sent.map((e) => e.arrivalMs), entries.map((e) => e.arrivalMs));
}
{
  // The bounded barrier is NOT part of v4; it stays covered as the candidate
  // for a later version. Reproduce the observed 8.2-second prime and allow the
  // admission state to catch up: only the declared second segment shifts.
  const { result, sent, polls } = await scenario({ primeCompletedMs: 49_200, readinessAtMs: 49_400 });
  assert.equal(result.status, "ready");
  assert.equal(result.shiftMs, 7_400);
  assert.equal(result.readyAtEpochMs, epochStart + 49_400);
  assert.equal(result.maxWaitMs, BURST_SETUP_MAX_WAIT_MS);
  assert.equal(polls[0].atMs, 49_200);
  assert.equal(sent.filter((e) => e.id === "batch-prime-1").length, 1);
  for (const entry of sent) {
    const base = entries.find((e) => e.id === entry.id);
    assert.equal(entry.arrivalMs, base.arrivalMs + (base.arrivalMs >= 42_000 ? 7_400 : 0));
  }
  assert.equal(sent.find((e) => e.id === "interactive-burst-1").arrivalMs,
    sent.find((e) => e.id === "interactive-burst-2").arrivalMs);
  assert.equal(sent.at(-1).arrivalMs - sent.find((e) => e.id === "interactive-burst-1").arrivalMs,
    entries.at(-1).arrivalMs - 60_000);
  assert.deepEqual(entries, originalEntries);
}
console.log("PASS  (not v4) bounded barrier: slow prime and delayed floor readiness uniformly shift later arrivals");

for (const options of [
  { missingPrime: true },
  { prime: { ...successfulPrime(), outcome: "failed" } },
  { prime: { ...successfulPrime(), outputTokensReported: false } },
  { prime: { ...successfulPrime(), outputTokens: 2 } },
  { primeCompletedMs: Infinity },
  { readinessAtMs: Infinity },
  { read: () => { throw new Error("readiness unavailable"); } },
  { read: () => ({ ready: true }) },
]) {
  const { result, sent, now } = await scenario(options);
  assert.equal(result.status, "failed");
  assert.ok(result.reason);
  assert.equal(result.maxWaitMs, 15_000);
  assert.equal(sent.length, 2);
  assert.ok(sent.every((e) => e.arrivalMs < 42_000));
  assert.ok(now <= 57_000);
}
{
  const { result, sent, polls } = await scenario({ requestLatencyMs: 1_000, readinessAtMs: 56_800 });
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "readiness_timeout");
  assert.equal(sent.length, 2);
  assert.ok(polls.at(-1).timeoutMs < 1_000);
  assert.equal(result.readiness.ready, true, "late response remains evidence but cannot release setup");
}
console.log("PASS  (not v4) bounded barrier: failed, missing, stalled and late readiness never release requests");

{
  let monotonicCalls = 0;
  const sample = pairedClockSample(() => epochStart, () => [10, 12][monotonicCalls++]);
  assert.deepEqual(sample, { epochMs: epochStart, monotonicMs: 11, readSpanMs: 2 });
}

// Exercise the real CLI's opt-in boundary; no benchmark service is required.
const directory = mkdtempSync(join(tmpdir(), "moflux-burst-replay-"));
try {
  const loadgen = fileURLToPath(new URL("./loadgen.mjs", import.meta.url));
  const output = join(directory, "legacy-summary.json");
  const legacy = spawnSync(process.execPath, [loadgen, "--metrics-port=0", "--interactive-rps=0",
    "--batch-rps=0", `--out=${output}`], { encoding: "utf8", timeout: 10_000 });
  assert.equal(legacy.status, 0, legacy.stderr);
  const summary = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(Object.hasOwn(summary, "burstSetup"), false);
  assert.equal(Object.hasOwn(summary, "clockSamples"), false);
  assert.equal(Object.hasOwn(summary.config, "burstRecoveryProtocol"), false);
  const invalid = spawnSync(process.execPath, [loadgen, "--metrics-port=0",
    `--burst-recovery-protocol=${BURST_REPLAY_PROTOCOL}`], { encoding: "utf8", timeout: 10_000 });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /requires --backend-availability=true/);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
console.log("PASS  paired clock samples preserve read uncertainty and legacy CLI output remains unchanged");
