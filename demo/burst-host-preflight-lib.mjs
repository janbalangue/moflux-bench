import { performance } from "node:perf_hooks";
import { setTimeout as sleepFor } from "node:timers/promises";

export const BURST_HOST_PREFLIGHT_POLICY = Object.freeze({
  timeoutMs: 60_000, quietWindowMs: 10_000, intervalMs: 1_000, maxSampleGapMs: 1_500,
});

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const counter = (value) => Number.isSafeInteger(value) && value >= 0;
const DEADLINE = Symbol("preflight deadline");

function checkedPolicy(policy) {
  const result = { ...BURST_HOST_PREFLIGHT_POLICY, ...policy };
  if (!Object.values(result).every((value) => finite(value) && value > 0) ||
      result.quietWindowMs > result.timeoutMs || result.intervalMs > result.maxSampleGapMs) {
    throw new TypeError("invalid burst host preflight policy");
  }
  return result;
}

function reasonsForSample(sample, previous, policy) {
  const reasons = [];
  if (!sample || typeof sample !== "object") return ["missing_sample"];
  if (typeof sample.error === "string") reasons.push("read_error");
  if (!finite(sample.startedAtMs) || !finite(sample.completedAtMs) || !finite(sample.atMs) ||
      sample.startedAtMs < 0 || sample.completedAtMs < sample.startedAtMs ||
      sample.atMs !== sample.completedAtMs) reasons.push("invalid_sample_timing");
  else {
    if (sample.completedAtMs - sample.startedAtMs > policy.maxSampleGapMs) reasons.push("slow_sample");
    if (previous && (!finite(previous.atMs) || sample.startedAtMs < previous.atMs ||
        sample.atMs <= previous.atMs || sample.atMs - previous.atMs > policy.maxSampleGapMs)) {
      reasons.push("sample_gap_or_clock_regression");
    }
  }
  if (!["normal", "warn", "critical"].includes(sample.memory?.pressure)) reasons.push("missing_memory_pressure");
  else if (sample.memory.pressure !== "normal") reasons.push(`memory_pressure_${sample.memory.pressure}`);
  if (!counter(sample.vm?.swapouts)) reasons.push("invalid_swapout_counter");
  if (!Number.isSafeInteger(sample.vm?.pageSizeBytes) || sample.vm.pageSizeBytes <= 0) reasons.push("invalid_page_size");
  if (previous && counter(sample.vm?.swapouts) && counter(previous.vm?.swapouts)) {
    if (sample.vm.swapouts < previous.vm.swapouts) reasons.push("swapout_counter_regression");
    else if (sample.vm.swapouts > previous.vm.swapouts) reasons.push("swapouts_increased");
  }
  if (previous?.vm?.pageSizeBytes && sample.vm?.pageSizeBytes !== previous.vm.pageSizeBytes) {
    reasons.push("page_size_changed");
  }
  return reasons;
}

function analyzeSamples(result, expectedPolicy) {
  const policy = checkedPolicy(expectedPolicy);
  const errors = [];
  if (result?.schemaVersion !== 1) errors.push("invalid_schema_version");
  for (const key of Object.keys(BURST_HOST_PREFLIGHT_POLICY)) {
    if (result?.[key] !== policy[key]) errors.push(`policy_mismatch_${key}`);
  }
  if (!finite(result?.durationMs) || result.durationMs < 0 || result.durationMs > policy.timeoutMs) {
    errors.push("invalid_duration");
  }
  const samples = Array.isArray(result?.samples) ? result.samples : [];
  if (samples.length === 0) errors.push("missing_samples");
  let previous, quietStart, quietCount = 0, quietWindow = null;
  const observations = [];
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index];
    const reasons = reasonsForSample(sample, previous, policy);
    if (finite(sample?.atMs) && (sample.atMs > policy.timeoutMs || sample.atMs > result?.durationMs)) {
      reasons.push("sample_after_deadline_or_result");
    }
    // A broken interval can start a new candidate only on the following clean sample.
    if (reasons.length) { quietStart = undefined; quietCount = 0; quietWindow = null; }
    else {
      if (!quietStart) { quietStart = { sample, index }; quietCount = 0; }
      quietCount++;
      const durationMs = sample.startedAtMs - quietStart.sample.completedAtMs;
      quietWindow = { startMs: quietStart.sample.completedAtMs, endMs: sample.startedAtMs,
        durationMs: Math.max(0, durationMs), sampleCount: quietCount,
        startIndex: quietStart.index, endIndex: index, swapouts: sample.vm.swapouts,
        pageSizeBytes: sample.vm.pageSizeBytes };
    }
    observations.push({ index, atMs: sample?.atMs ?? null, reasons,
      quietForMs: quietWindow?.durationMs ?? 0 });
    previous = sample;
  }
  // Require the final evidence to be fresh; an old quiet window cannot justify a later start.
  if (samples.length && finite(result?.durationMs) && finite(samples.at(-1)?.atMs) &&
      result.durationMs - samples.at(-1).atMs > policy.maxSampleGapMs) errors.push("stale_final_sample");
  const passed = errors.length === 0 && quietWindow !== null && quietWindow.durationMs >= policy.quietWindowMs;
  return { passed, status: passed ? "ready" : "not_ready",
    reason: passed ? "normal_pressure_and_no_swapout_growth" : errors[0] ??
      observations.at(-1)?.reasons[0] ?? "quiet_window_incomplete",
    sampleCount: samples.length, quietWindow, errors, observations };
}

/** Recompute readiness from raw samples; never accept a stored `passed` flag as evidence. */
export function summarizeBurstHostPreflight(result, expectedPolicy = BURST_HOST_PREFLIGHT_POLICY) {
  const analysis = analyzeSamples(result, expectedPolicy);
  if (result?.status === "ready" && result?.passed === true) return analysis;
  return { ...analysis, passed: false, status: "not_ready", reason: "preflight_did_not_finish_ready",
    errors: [...analysis.errors, "preflight_did_not_finish_ready"] };
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException("Burst host preflight cancelled", "AbortError");
}

/** Bound even an unresponsive read/sleeper, and detach every abort listener/timer. */
async function bounded(operation, signal, remainingMs) {
  throwIfAborted(signal);
  let timer, onAbort;
  const limit = new Promise((resolve, reject) => {
    timer = setTimeout(() => resolve(DEADLINE), Math.max(0, remainingMs));
    if (signal) {
      onAbort = () => reject(signal.reason ?? new DOMException("Burst host preflight cancelled", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try { return await Promise.race([Promise.resolve().then(operation), limit]); }
  finally { clearTimeout(timer); if (onAbort) signal.removeEventListener("abort", onAbort); }
}

/** Wait after engine warm-up, before trace collection. Performs no host mutations. */
export async function waitForBurstHostReady({ readPressure, sleep = (ms) => sleepFor(ms),
  now = () => performance.now(), signal, onSample = () => {},
  timeoutMs = BURST_HOST_PREFLIGHT_POLICY.timeoutMs,
  quietWindowMs = BURST_HOST_PREFLIGHT_POLICY.quietWindowMs,
  intervalMs = BURST_HOST_PREFLIGHT_POLICY.intervalMs } = {}) {
  if (typeof readPressure !== "function" || typeof sleep !== "function" ||
      typeof now !== "function" || typeof onSample !== "function") throw new TypeError("invalid preflight callback");
  const policy = checkedPolicy({ timeoutMs, quietWindowMs, intervalMs });
  throwIfAborted(signal);
  const origin = now();
  if (!finite(origin)) throw new TypeError("preflight clock must be finite");
  let lastNow = origin;
  const elapsed = () => {
    const current = now();
    if (!finite(current) || current < lastNow) throw new Error("preflight monotonic clock regressed or is invalid");
    lastNow = current;
    return current - origin;
  };
  const result = { schemaVersion: 1, ...policy, samples: [], durationMs: 0 };
  const finish = (status) => {
    const completed = { ...result, status, passed: status === "ready" };
    const validation = summarizeBurstHostPreflight(completed, policy);
    return { ...completed, passed: completed.passed && validation.passed, validation };
  };
  while (true) {
    throwIfAborted(signal);
    const startedAtMs = elapsed();
    if (startedAtMs >= timeoutMs) { result.durationMs = timeoutMs; return finish("timeout"); }
    let pressure, error;
    try {
      pressure = await bounded(() => readPressure({ signal }), signal, timeoutMs - startedAtMs);
      if (pressure === DEADLINE) error = "host pressure read exceeded preflight deadline";
    } catch (cause) {
      throwIfAborted(signal);
      error = cause instanceof Error ? cause.message : String(cause);
    }
    throwIfAborted(signal);
    const completedAtMs = elapsed();
    result.durationMs = Math.min(timeoutMs, completedAtMs);
    const sample = { ...(pressure !== DEADLINE && pressure && typeof pressure === "object" ? pressure : {}),
      startedAtMs, completedAtMs, atMs: completedAtMs, ...(error === undefined ? {} : { error }) };
    result.samples.push(sample);
    const validation = analyzeSamples(result, policy);
    sample.reasons = [...validation.observations.at(-1).reasons];
    sample.quietForMs = validation.observations.at(-1).quietForMs;
    // Logging is deliberately awaited: failures must remain visible to the caller.
    const logged = await bounded(() => onSample(sample), signal, Math.max(0, timeoutMs - completedAtMs));
    if (logged === DEADLINE || pressure === DEADLINE || completedAtMs >= timeoutMs) return finish("timeout");
    result.durationMs = Math.min(timeoutMs, elapsed());
    if (analyzeSamples(result, policy).passed) return finish("ready");
    const remainingMs = timeoutMs - elapsed();
    if (remainingMs <= 0) { result.durationMs = timeoutMs; return finish("timeout"); }
    const slept = await bounded(() => sleep(Math.min(intervalMs, remainingMs), { signal }), signal, remainingMs);
    if (slept === DEADLINE) { result.durationMs = timeoutMs; return finish("timeout"); }
  }
}
