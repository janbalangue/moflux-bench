import { traceHash } from "../load/trace-lib.mjs";

/** One preregistered return request per independent seed; no success selection. */
const finite = (x) => typeof x === "number" && Number.isFinite(x);
const first = (events, type, id) => events.find((e) => e.event === type && e.requestId === id);

// Fixed before observing outcomes; all arms replay the same pressure opportunity.
// v2 moves the burst from 10s to 12s before the return. On the pilot M1 a
// 1,607-token prefill is one ~2.9s scheduler step and decode steps are ~120ms,
// so three staggered prefills finish about 8.5s after the burst and the three
// requests stay resident for roughly another 7.5s. Twelve seconds places the
// return and its ~1s grant restoration inside decode rather than at the end of
// the last prefill step, where a 50s burst left under a second of margin.
// v3 keeps that burst and enlarges only the selected return request. In the v2
// seed-3 pilot it was admitted through the never-lent slot, needed 8 KV blocks,
// fit beside the three resident burst requests, and was scheduled 0.28ms after
// enqueue, so no request was waiting when the grant came back. vLLM reported 118 prompt
// tokens for 400 characters and 1,607 for 7,100: about 29 template tokens plus
// 0.222 per character. Three resident burst requests hold 101-105 blocks each,
// leaving at most 17 of 320 free, and 2,000 characters is about 474 tokens, or
// 30 blocks. The installed scheduler admits a waiting request only when its
// full prompt fits and never preempts running work to make room for it, so the
// request waits in the engine until a resident request finishes.
export const AVAILABILITY_PROTOCOL = "fixed-burst-v3";
export const AVAILABILITY_BURST = Object.freeze({ leadMs: 12_000, spacingMs: 100, requests: 3 });
export const AVAILABILITY_RETURN_REQUEST = Object.freeze({ inputChars: 2_000 });
/**
 * Grant sampling for this experiment. The Metal default of 1s makes the grant
 * bracket about a second wide, which cannot order a request scheduled within
 * ~100ms of the return against restoration. Two light HTTP reads per sample;
 * `--managed-telemetry-interval-ms` still overrides it.
 */
export const AVAILABILITY_MANAGED_INTERVAL_MS = 250;
export function availabilityTrace(trace, workload) {
  const returning = trace.entries.filter((e) => e.class === "interactive" &&
    e.arrivalMs >= workload.interactiveResumeStartMs);
  const entries = trace.entries.filter((e) => e.class !== "batch" ||
    e.arrivalMs >= workload.interactiveResumeStartMs).map((e) => ({ ...e }));
  const selected = returning.sort((a, b) => a.arrivalMs - b.arrivalMs)[0];
  // Only the selected request is enlarged; later returns keep the class size.
  if (selected) Object.assign(entries.find((e) => e.id === selected.id), {
    arrivalMs: workload.interactiveResumeStartMs, inputChars: AVAILABILITY_RETURN_REQUEST.inputChars });
  else entries.push({ id: "interactive-resume-1", class: "interactive",
    arrivalMs: workload.interactiveResumeStartMs, inputChars: AVAILABILITY_RETURN_REQUEST.inputChars,
    retryJitter: [1], targetSlots: [0], providerSeeds: [trace.workload.seed] });
  // Establish batch demand early enough for the controller to lend idle slots.
  entries.push({ id: "batch-prime-1", class: "batch", arrivalMs: workload.batchStartMs,
    retryJitter: [1], targetSlots: [0], providerSeeds: [trace.workload.seed] });
  for (let i = 0; i < AVAILABILITY_BURST.requests; i += 1) entries.push({
    id: `batch-pressure-${i + 1}`, class: "batch",
    arrivalMs: workload.interactiveResumeStartMs - AVAILABILITY_BURST.leadMs + i * AVAILABILITY_BURST.spacingMs,
    retryJitter: [1], targetSlots: [0], providerSeeds: [trace.workload.seed + i],
  });
  entries.sort((a, b) => a.arrivalMs - b.arrivalMs || a.id.localeCompare(b.id));
  const result = { ...trace, entries, planned: {
    interactive: entries.filter((e) => e.class === "interactive").length,
    batch: entries.filter((e) => e.class === "batch").length, total: entries.length,
  }, availabilityProtocol: AVAILABILITY_PROTOCOL };
  return { ...result, hash: traceHash(result) };
}

/**
 * Each source records wall minus its own monotonic clock. Frequency slew moves
 * that reading by parts per million and scales every interval alike; a step
 * appears as a jump between adjacent readings and would bias the gap.
 */
const clockStepMs = (readings) => readings.length > 1
  ? Math.max(...readings.slice(1).map((r, i) => Math.abs(r - readings[i]))) : 0;
const clockDriftMs = (readings) => readings.length ? Math.max(...readings) - Math.min(...readings) : 0;
const CLOCK_STEP_LIMIT_MS = 5;

export function backendAvailabilityEpisode({ seed, arm, trace, loadgen, events, samples,
  demandReturn, startedAtEpochMs, workload, nominalFloor, cacheConfig, pressureThreshold = 0.9 }) {
  const result = { seed, arm, status: "inconclusive", reasons: [], pressureThreshold };
  const reject = (reason) => { result.reasons.push(reason); };
  const ordered = [...events].sort((a, b) => a.atEpochMs - b.atEpochMs);
  const intent = trace.entries.filter((e) => e.class === "interactive" &&
    e.arrivalMs >= workload.interactiveResumeStartMs &&
    e.arrivalMs < workload.interactiveResumeStartMs + workload.interactiveResumeDurationMs)
    .sort((a, b) => a.arrivalMs - b.arrivalMs)[0];
  if (!intent) { reject("no_return_request"); return result; }
  result.requestId = `moflux-bench-${intent.id}-a1`;
  result.selection = "first planned interactive return request, attempt 1; never replaced by a success";
  if (cacheConfig?.numGpuBlocks !== workload.engine?.kvCacheBlocks ||
      cacheConfig?.blockSize !== workload.engine?.blockSize || !workload.engine) reject("kv_pool_not_verified");
  if (workload.maxAttempts !== 1) reject("retries_not_supported");
  if (loadgen?.generatorSaturated !== 0) reject("generator_saturated_or_unknown");
  const installed = ordered.find((e) => e.event === "installed");
  if (!installed) reject("scheduler_hook_missing");
  // Schema 1 mapped a monotonic clock to epoch at engine start, so its drift
  // grew for the life of the engine and cannot be compared to grant samples.
  else if (!(installed.schemaVersion >= 2) || installed.clockBasis !== "realtime") reject("scheduler_probe_clock_basis_unsupported");
  if (ordered.some((e) => !finite(e.atEpochMs) || !finite(e.clockErrorMs))) reject("engine_event_clock_missing");
  // Client stamps are diagnostics only; the gap uses engine and sampler wall time.
  result.clientClockErrorMs = finite(loadgen?.backendClockErrorMs) ? loadgen.backendClockErrorMs : null;
  if (arm === "static" && demandReturn?.restorationWasNeeded !== true) {
    result.status = result.reasons.length ? "inconclusive" : "not_applicable";
    result.reasons.push("static_control_has_no_restoration_transition");
    return result;
  }
  if (demandReturn?.restorationWasNeeded !== true) reject("no_restoration_needed");
  const restored = demandReturn?.floorRestoredAtMs;
  const byOffset = [...samples].sort((a, b) => a.offsetMs - b.offsetMs);
  const before = byOffset.filter((s) => finite(restored) && s.offsetMs < restored &&
    s.classes?.interactive?.limits?.protectedConcurrent < nominalFloor).at(-1);
  const after = samples.find((s) => s.offsetMs === restored &&
    s.classes?.interactive?.limits?.protectedConcurrent >= nominalFloor);
  // The grant may change while either HTTP stats request is in flight.
  if (!before || !after || !finite(before.sampleStartedAtMs)) {
    reject("grant_transition_not_bracketed"); return result;
  }
  const lower = startedAtEpochMs + before.sampleStartedAtMs;
  const upper = startedAtEpochMs + after.offsetMs;
  result.grantRestoration = { lowerEpochMs: lower, upperEpochMs: upper, uncertaintyMs: upper - lower };
  const pressure = ordered.filter((e) => e.event === "pressure" && e.atEpochMs >= lower - 1000 && e.atEpochMs <= upper);
  result.pressure = { samples: pressure.length,
    min: pressure.length ? Math.min(...pressure.map((e) => e.kvUsage)) : null,
    max: pressure.length ? Math.max(...pressure.map((e) => e.kvUsage)) : null,
    latestAgeMs: pressure.length ? upper - pressure.at(-1).atEpochMs : null,
    maxSampleGapMs: pressure.length > 1 ? Math.max(...pressure.slice(1).map((e, i) => e.atEpochMs - pressure[i].atEpochMs)) : null };
  // Sustained local pressure around restoration, not a peak elsewhere in the run.
  if (pressure.length < 3 || pressure[0].atEpochMs > lower || result.pressure.maxSampleGapMs > 500 || pressure.at(-1).atEpochMs < upper - 500 ||
      pressure.some((e) => !finite(e.kvUsage) || e.kvUsage < pressureThreshold || e.kvUsage > 1)) {
    reject("high_pressure_not_sustained_at_restoration");
  }
  const request = loadgen?.classes?.interactive?.attemptSamples?.find((a) => a.requestId === result.requestId);
  const enqueued = first(ordered, "enqueued", result.requestId);
  const scheduled = first(ordered, "first_scheduled", result.requestId);
  result.request = request ?? null;
  result.enqueuedAtEpochMs = enqueued?.atEpochMs ?? null;
  result.scheduledAtEpochMs = scheduled?.atEpochMs ?? null;
  // Diagnostic only: whether free KV was below the enlarged request when it
  // reached the engine, from the last scheduler pressure sample before enqueue.
  const lastPressure = enqueued && ordered.filter((e) => e.event === "pressure" &&
    e.atEpochMs <= enqueued.atEpochMs).at(-1);
  result.freeBlocksBeforeEnqueue = lastPressure && finite(lastPressure.kvUsage) && finite(cacheConfig?.numGpuBlocks)
    ? { blocks: Math.round((1 - lastPressure.kvUsage) * cacheConfig.numGpuBlocks),
        sampleAgeMs: enqueued.atEpochMs - lastPressure.atEpochMs, waiting: lastPressure.waiting ?? null }
    : null;
  if (!request || !finite(request.sentAtMs) || !finite(request.endedAtMs)) reject("request_attempt_missing");
  if (ordered.filter((e) => e.event === "first_scheduled" && e.requestId === result.requestId).length > 1) reject("duplicate_first_schedule_event");
  if (scheduled && (!enqueued || enqueued.atEpochMs > scheduled.atEpochMs || !(scheduled.scheduledTokens > 0))) {
    reject("invalid_scheduler_event_order");
  }
  const clientEnd = finite(request?.endedAtEpochMs) ? request.endedAtEpochMs
    : finite(loadgen?.startedAtEpochMs) && finite(request?.endedAtMs) ? loadgen.startedAtEpochMs + request.endedAtMs : Infinity;
  const observationEnd = Math.min(ordered.at(-1)?.atEpochMs ?? upper, clientEnd);
  // Engine events and grant samples read the same host wall clock, so there is
  // no cross-process mapping to drift; only a clock step inside the measured
  // interval can bias the gap.
  const windowEnd = Math.max(upper, scheduled?.atEpochMs ?? observationEnd);
  const engineReadings = ordered.filter((e) => e.atEpochMs >= lower - 1000 && e.atEpochMs <= windowEnd)
    .map((e) => e.clockErrorMs).filter(finite);
  const samplerReadings = byOffset.filter((s) => s.offsetMs >= before.offsetMs &&
    startedAtEpochMs + s.sampleStartedAtMs <= windowEnd).map((s) => s.clockErrorMs);
  const samplerFinite = samplerReadings.length > 1 && samplerReadings.every(finite);
  result.clock = { basis: "realtime", stepLimitMs: CLOCK_STEP_LIMIT_MS,
    engineStepMs: clockStepMs(engineReadings), engineDriftMs: clockDriftMs(engineReadings),
    samplerStepMs: samplerFinite ? clockStepMs(samplerReadings) : null,
    samplerDriftMs: samplerFinite ? clockDriftMs(samplerReadings) : null };
  if (result.clock.engineStepMs > CLOCK_STEP_LIMIT_MS) reject("engine_clock_step_exceeds_5ms_in_window");
  if (!samplerFinite || result.clock.samplerStepMs > CLOCK_STEP_LIMIT_MS) {
    reject("sampler_clock_step_missing_or_exceeds_5ms_in_window");
  }
  if (request) {
    result.dispatchAfterGrantMs = finite(request.sentAtEpochMs) ? request.sentAtEpochMs - upper : null;
    result.clientFirstTokenAfterGrantMs = finite(request.firstTokenAtEpochMs)
      ? request.firstTokenAtEpochMs - upper : null;
    // Service latency from client dispatch, defined even when service precedes restoration.
    result.dispatchToScheduleMs = finite(request.sentAtEpochMs) && scheduled
      ? scheduled.atEpochMs - request.sentAtEpochMs : null;
  }
  if (result.reasons.length) return result;
  if (scheduled) {
    // Preserve negative bounds: service before restoration is not a zero-delay reclamation.
    result.status = "observed";
    result.gapMs = { lower: scheduled.atEpochMs - upper - 5, upper: scheduled.atEpochMs - lower + 5 };
    result.serviceBeforeRestoration = result.gapMs.upper < 0;
    if (result.serviceBeforeRestoration) {
      result.status = "served_before_restoration";
    } else if (result.gapMs.lower < 0) {
      result.status = "inconclusive";
      reject("schedule_order_overlaps_grant_uncertainty");
    }
    result.engineQueueMs = scheduled.atEpochMs - enqueued.atEpochMs;
    result.pendingInEngineAtRestoration = enqueued.atEpochMs <= lower;
  } else if (request.httpStatus >= 400 || request.outcome === "failed") {
    result.status = "failed";
    result.reasons.push("selected_request_failed_without_scheduling");
  } else if (request.outcome === "censored" && enqueued) {
    result.status = "right_censored";
    // Observe only through the last engine event, never assume trace coverage past it.
    result.censorLowerMs = observationEnd - upper - 5;
    if (result.censorLowerMs < 0) { result.status = "inconclusive"; reject("observation_ended_before_restoration"); }
  } else {
    reject("selected_request_scheduler_event_missing");
  }
  return result;
}

/** Episodes whose measurement gates passed, whatever their outcome. */
export const VALID_AVAILABILITY_STATUSES = Object.freeze(["observed", "served_before_restoration", "failed", "right_censored"]);

export function availabilityDistribution(episodes) {
  const observed = episodes.filter((e) => e.status === "observed");
  const counts = Object.fromEntries(["observed", "right_censored", "failed", "inconclusive", "served_before_restoration", "not_applicable"]
    .map((status) => [status, episodes.filter((e) => e.status === status).length]));
  const bounds = (key) => observed.map((e) => e.gapMs[key]).sort((a, b) => a - b);
  const low = bounds("lower"), high = bounds("upper");
  const percentile = (a, q) => a.length ? a[Math.ceil(a.length * q) - 1] : null;
  const ecdf = [...new Set([...low, ...high])].sort((a, b) => a - b).map((ms) => ({ ms,
    observedLower: high.filter((x) => x <= ms).length / observed.length,
    observedUpper: low.filter((x) => x <= ms).length / observed.length,
  }));
  return { episodeCount: episodes.length, counts, observedCount: observed.length,
    unit: "one preregistered request per seed/arm; separate arms and configurations",
    conditionalOnObserved: true,
    percentilesMs: Object.fromEntries([0.5, 0.9, 0.95, 0.99].map((q) => [`p${q * 100}`, {
      lower: percentile(low, q), upper: percentile(high, q),
      nominalTailObservations: observed.length * (1 - q),
    }])),
    minMs: low[0] ?? null, maxMs: high.at(-1) ?? null,
    ecdf, p99NominalTailCountAtLeast10: observed.length >= 1000,
    note: "Percentiles and ECDF are conditional on observed episodes, with grant-sampling and 5ms clock bounds. Failures, inconclusive trials and censoring remain in counts and raw episodes; do not interpret conditional tails as all-trial latency. At least 1000 valid episodes gives only about 10 observations above p99. Bounds are measurement bounds, not confidence intervals.",
    episodes };
}

/** Reopening is an admission transition; global KV gauges do not identify owners. */
export function lendingReopenings({ samples, events, restoredAtMs, startedAtEpochMs, nominalFloor }) {
  if (!finite(restoredAtMs)) return [];
  const ordered = [...samples].sort((a, b) => a.offsetMs - b.offsetMs);
  const pressure = events.filter((e) => e.event === "pressure").sort((a, b) => a.atEpochMs - b.atEpochMs);
  const rows = [];
  for (let i = 1; i < ordered.length; i += 1) {
    const previous = ordered[i - 1], current = ordered[i];
    if (previous.offsetMs < restoredAtMs ||
        !(previous.classes?.interactive?.limits?.protectedConcurrent >= nominalFloor) ||
        !(current.classes?.interactive?.limits?.protectedConcurrent < nominalFloor)) continue;
    const at = startedAtEpochMs + current.offsetMs;
    const kv = pressure.filter((e) => e.atEpochMs <= at).at(-1);
    const borrowed = previous.classes?.batch?.borrowedConcurrent;
    rows.push({ lowerAtMs: previous.sampleStartedAtMs ?? null, upperAtMs: current.offsetMs,
      sinceRestorationMs: current.offsetMs - restoredAtMs,
      interactiveDemandState: current.classes?.interactive?.demandState ?? null,
      borrowedConcurrentBefore: finite(borrowed) ? borrowed : null,
      borrowedConcurrentAfter: current.classes?.batch?.borrowedConcurrent ?? null,
      reopenedWithBorrowedOccupancyObserved: finite(borrowed) ? borrowed > 0 : null,
      kvUsageBefore: kv && at - kv.atEpochMs <= 500 ? kv.kvUsage : null,
      kvSampleAgeMs: kv ? at - kv.atEpochMs : null,
      note: "Floor reduction is an observed lending reopening. Borrowed occupancy is admission-side and does not identify a previous loan cohort or prove backend KV residency/recovery.",
    });
  }
  return rows;
}
