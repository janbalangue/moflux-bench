// Prospective burst-recovery-v4 timing checks. Wall timestamps remain the
// observations; these checks never fit or subtract an offset from the data.
export const BURST_CLOCK_LIMITS = Object.freeze({
  uncertaintyBudgetMs: 10,
  maxSlewPpm: 100,
  localJumpAllowanceMs: 2,
  driftWindowMs: 90_000,
  maxReadSpanMs: 1,
  maxGapMs: 1000,
  maxProbeGapMs: 2000,
  sampleIntervalMs: 250,
  timestampResolutionMs: 1,
});

const MAX_REPORTED_VIOLATIONS = 5;
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const observed = (value) => finite(value) ? value : null;

/** Bracket a direct wall read with monotonic reads; do not map either clock. */
export function captureClockSample() {
  const before = Number(process.hrtime.bigint()) / 1e6;
  const epochMs = Date.now();
  const after = Number(process.hrtime.bigint()) / 1e6;
  return { epochMs, monotonicMs: (before + after) / 2, readSpanMs: after - before };
}

function coverage(first, last, { startEpochMs, endEpochMs, coverageToleranceMs }) {
  const startRequested = startEpochMs !== undefined;
  const endRequested = endEpochMs !== undefined;
  const startValid = !startRequested || finite(startEpochMs);
  const endValid = !endRequested || finite(endEpochMs);
  const intervalValid = !startRequested || !endRequested ||
    (startValid && endValid && endEpochMs >= startEpochMs);
  return {
    startEpochMs: observed(startEpochMs), endEpochMs: observed(endEpochMs), coverageToleranceMs,
    firstEpochMs: observed(first), lastEpochMs: observed(last),
    startGapMs: startRequested && startValid && finite(first) ? Math.max(0, first - startEpochMs) : null,
    endGapMs: endRequested && endValid && finite(last) ? Math.max(0, endEpochMs - last) : null,
    passed: startValid && endValid && intervalValid && finite(coverageToleranceMs) && coverageToleranceMs >= 0 &&
      (!startRequested || (finite(first) && first <= startEpochMs + coverageToleranceMs)) &&
      (!endRequested || (finite(last) && last >= endEpochMs - coverageToleranceMs)),
  };
}

/**
 * Validate paired readings in capture order. A reading whose monotonic bracket
 * exceeds 1 ms is not clock evidence and counts as missing; malformed rows fail.
 * Gradual drift is allowed prospectively: a fitted slew within 100 ppm, and
 * within any 90 s (the return observation window) a wall-minus-monotonic
 * change no larger than the 10 ms budget that brackets carry. A jump between
 * consecutive readings or a backward clock fails and is not repaired. The
 * least-squares fit describes the drift rate. It is never a timestamp
 * correction and never a synchronization test.
 *
 * maxGapMs=null reports gaps without gating them. Use it only for a source
 * whose every recorded timestamp is itself one of these paired readings.
 */
export function analyzeClockSeries(rows = [], {
  epochField = "epochMs", monoField = "monotonicMs", spanField = "readSpanMs",
  maxGapMs = BURST_CLOCK_LIMITS.maxGapMs, startEpochMs, endEpochMs,
  coverageToleranceMs = maxGapMs ?? BURST_CLOCK_LIMITS.maxGapMs, clipToCoverage = false,
} = {}) {
  const reasons = [];
  const gapGated = maxGapMs !== null;
  const samples = (Array.isArray(rows) ? rows : []).map((row, index) => ({ index,
    epochMs: row?.[epochField], monotonicMs: row?.[monoField], readSpanMs: row?.[spanField] }));
  const wellFormed = (row) => finite(row.epochMs) && finite(row.monotonicMs) &&
    finite(row.readSpanMs) && row.readSpanMs >= 0;
  const invalid = samples.filter((row) => !wellFormed(row));
  if (!Array.isArray(rows) || invalid.length) reasons.push("invalid_samples");
  if (gapGated && (!finite(maxGapMs) || maxGapMs <= 0)) reasons.push("invalid_gap_limit");
  // A long-lived source also records rows outside this capture. Rows are
  // selected by their own wall reading; a step still shows at the window edge.
  const clip = clipToCoverage && finite(startEpochMs) && finite(endEpochMs) && finite(coverageToleranceMs);
  const inWindow = samples.filter((row) => wellFormed(row) && (!clip ||
    (row.epochMs >= startEpochMs - coverageToleranceMs && row.epochMs <= endEpochMs + coverageToleranceMs)));
  const usable = inWindow.filter((row) => row.readSpanMs <= BURST_CLOCK_LIMITS.maxReadSpanMs);
  if (usable.length < 2) reasons.push("insufficient_samples");
  const first = usable[0], last = usable.at(-1);
  const residuals = usable.map((row) => ({ index: row.index,
    elapsedMonotonicMs: row.monotonicMs - first.monotonicMs,
    rawResidualMs: (row.epochMs - first.epochMs) - (row.monotonicMs - first.monotonicMs) }));
  const increments = [];
  for (let i = 1; i < usable.length; i++) {
    const previous = usable[i - 1], current = usable[i];
    const elapsedMonotonicMs = current.monotonicMs - previous.monotonicMs;
    const elapsedWallMs = current.epochMs - previous.epochMs;
    const residualIncrementMs = elapsedWallMs - elapsedMonotonicMs;
    const allowedIncrementMs = BURST_CLOCK_LIMITS.localJumpAllowanceMs +
      BURST_CLOCK_LIMITS.maxSlewPpm * Math.max(0, elapsedMonotonicMs) / 1e6;
    increments.push({ index: current.index, elapsedMonotonicMs, elapsedWallMs, residualIncrementMs, allowedIncrementMs });
  }
  const steps = increments.filter((row) => Math.abs(row.residualIncrementMs) > row.allowedIncrementMs);
  const gaps = gapGated ? increments.filter((row) => row.elapsedMonotonicMs > maxGapMs) : [];
  if (increments.some((row) => row.elapsedMonotonicMs < 0)) reasons.push("monotonic_clock_backwards");
  if (increments.some((row) => row.elapsedWallMs < 0)) reasons.push("wall_clock_backwards");
  if (steps.length) reasons.push("clock_step_exceeded");
  if (gaps.length) reasons.push("sample_gap_exceeded");
  const durationMs = first && last ? last.monotonicMs - first.monotonicMs : null;
  if (usable.length >= 2 && !(durationMs > 0)) reasons.push("nonpositive_duration");
  const xMean = residuals.reduce((sum, row) => sum + row.elapsedMonotonicMs, 0) / residuals.length;
  const yMean = residuals.reduce((sum, row) => sum + row.rawResidualMs, 0) / residuals.length;
  const denominator = residuals.reduce((sum, row) => sum + (row.elapsedMonotonicMs - xMean) ** 2, 0);
  const slope = denominator > 0 ? residuals.reduce((sum, row) => sum +
    (row.elapsedMonotonicMs - xMean) * (row.rawResidualMs - yMean), 0) / denominator : null;
  const fittedSlewPpm = finite(slope) ? slope * 1e6 : null;
  // Date.now has 1 ms resolution. Bound the slope's quantization contribution
  // for short captures instead of misclassifying a single millisecond tick as
  // host drift. Long captures still reject excessive steady slewing.
  const slopeResolutionPpm = durationMs > 0 ? 2 * BURST_CLOCK_LIMITS.timestampResolutionMs / durationMs * 1e6 : null;
  if (finite(fittedSlewPpm) && Math.abs(fittedSlewPpm) > BURST_CLOCK_LIMITS.maxSlewPpm + slopeResolutionPpm)
    reasons.push("clock_slew_exceeded");
  // Increments bound each step; this bounds what the brackets must absorb,
  // including a fast slew spread across readings that no single step shows.
  let maxWindowDriftMs = residuals.length ? 0 : null;
  for (let i = 0; i < residuals.length; i++) {
    let low = residuals[i].rawResidualMs, high = low;
    for (let j = i + 1; j < residuals.length &&
      residuals[j].elapsedMonotonicMs - residuals[i].elapsedMonotonicMs <= BURST_CLOCK_LIMITS.driftWindowMs; j++) {
      low = Math.min(low, residuals[j].rawResidualMs); high = Math.max(high, residuals[j].rawResidualMs);
    }
    maxWindowDriftMs = Math.max(maxWindowDriftMs, high - low);
  }
  if (finite(maxWindowDriftMs) && maxWindowDriftMs > BURST_CLOCK_LIMITS.uncertaintyBudgetMs)
    reasons.push("clock_drift_exceeds_budget");
  // Descriptive: what one constant rate leaves unexplained.
  const detrended = finite(slope) ? residuals.map((row) =>
    row.rawResidualMs - yMean - slope * (row.elapsedMonotonicMs - xMean)) : [];
  const detrendedResidualRangeMs = detrended.length ? Math.max(...detrended) - Math.min(...detrended) : null;
  const captureCoverage = coverage(first?.epochMs, last?.epochMs, { startEpochMs, endEpochMs, coverageToleranceMs });
  if (!captureCoverage.passed) reasons.push("capture_coverage_incomplete");
  const raw = residuals.map((row) => row.rawResidualMs);
  return { passed: reasons.length === 0, reasons, sampleCount: samples.length, usableSampleCount: usable.length,
    invalidSampleCount: invalid.length, invalidSampleIndices: invalid.slice(0, MAX_REPORTED_VIOLATIONS).map((row) => row.index),
    slowReadCount: inWindow.length - usable.length, clippedSampleCount: samples.length - invalid.length - inWindow.length,
    durationMs, fittedSlewPpm, slopeResolutionPpm,
    rawResidualRangeMs: raw.length ? Math.max(...raw) - Math.min(...raw) : null, maxWindowDriftMs, detrendedResidualRangeMs,
    maxReadSpanMs: inWindow.length ? Math.max(...inWindow.map((row) => row.readSpanMs)) : null,
    gapGated, maxSampleGapMs: increments.length ? Math.max(...increments.map((row) => row.elapsedMonotonicMs)) : null,
    maxResidualIncrementMs: increments.length ? Math.max(...increments.map((row) => Math.abs(row.residualIncrementMs))) : null,
    coverage: captureCoverage,
    stepViolationCount: steps.length, gapViolationCount: gaps.length,
    violations: [...steps.map((row) => ({ kind: "step", ...row })), ...gaps.map((row) => ({ kind: "gap", ...row }))]
      .sort((a, b) => a.index - b.index).slice(0, MAX_REPORTED_VIOLATIONS) };
}

/**
 * Every probe brackets a direct remote wall read by local send/receive wall
 * reads, so the remote-minus-host offset lies between (remote - received) and
 * (remote - sent), each widened by the 1 ms read resolution. There is no
 * symmetric-latency assumption and no remote timestamp normalization.
 *
 * A probe proves alignment when the larger endpoint distance is inside the
 * budget. A probe whose whole interval is outside the budget proves
 * misalignment and fails. A slow, failed or timed-out probe proves neither and
 * counts as missing; usable probes must then stay within the probe gap limit.
 *
 * A container clock is disciplined toward the host and may step to follow it,
 * so its own steps and rate are reported and its measured alignment is gated.
 */
export function analyzeClockAlignment(rows = [], {
  startEpochMs, endEpochMs, maxGapMs = BURST_CLOCK_LIMITS.maxProbeGapMs,
  coverageToleranceMs = maxGapMs,
} = {}) {
  const reasons = [];
  const samples = Array.isArray(rows) ? rows : [];
  if (!Array.isArray(rows)) reasons.push("invalid_samples");
  if (!finite(maxGapMs) || maxGapMs <= 0) reasons.push("invalid_gap_limit");
  const budget = BURST_CLOCK_LIMITS.uncertaintyBudgetMs, resolution = BURST_CLOCK_LIMITS.timestampResolutionMs;
  const errorCounts = {};
  const measurements = samples.map((row, index) => {
    if (typeof row?.error === "string") {
      errorCounts[row.error] = (errorCounts[row.error] ?? 0) + 1;
      return { index, status: "error" };
    }
    const spans = [row?.hostSentReadSpanMs, row?.hostReceivedReadSpanMs, row?.remoteReadSpanMs];
    if (![row?.hostSentEpochMs, row?.hostReceivedEpochMs, row?.remoteEpochMs, row?.hostSentMonotonicMs,
      row?.hostReceivedMonotonicMs, row?.remoteMonotonicMs, ...spans].every(finite) || spans.some((span) => span < 0)) {
      return { index, status: "invalid" };
    }
    const roundTripWallMs = row.hostReceivedEpochMs - row.hostSentEpochMs;
    const roundTripMonotonicMs = row.hostReceivedMonotonicMs - row.hostSentMonotonicMs;
    const offsetLowerMs = row.remoteEpochMs - row.hostReceivedEpochMs - resolution;
    const offsetUpperMs = row.remoteEpochMs - row.hostSentEpochMs + resolution;
    const boundMs = Math.max(Math.abs(row.remoteEpochMs - row.hostSentEpochMs),
      Math.abs(row.remoteEpochMs - row.hostReceivedEpochMs)) + resolution;
    const status = roundTripWallMs < 0 || roundTripMonotonicMs < 0 ? "backwards"
      : offsetLowerMs > budget || offsetUpperMs < -budget ? "misaligned"
      : boundMs <= budget && spans.every((span) => span <= BURST_CLOCK_LIMITS.maxReadSpanMs) ? "aligned"
      : "uninformative";
    return { index, status, boundMs, offsetLowerMs, offsetUpperMs, roundTripMonotonicMs,
      hostSentEpochMs: row.hostSentEpochMs, hostReceivedEpochMs: row.hostReceivedEpochMs,
      hostSentMonotonicMs: row.hostSentMonotonicMs };
  });
  const count = (status) => measurements.filter((row) => row.status === status).length;
  if (count("invalid")) reasons.push("invalid_samples");
  if (count("backwards")) reasons.push("clock_backwards_during_probe");
  if (count("misaligned")) reasons.push("alignment_uncertainty_exceeded");
  const usable = measurements.filter((row) => row.status === "aligned");
  if (usable.length < 2) reasons.push("insufficient_samples");
  const gapsMs = usable.slice(1).map((row, i) => row.hostSentMonotonicMs - usable[i].hostSentMonotonicMs);
  if (finite(maxGapMs) && gapsMs.some((gap) => gap > maxGapMs)) reasons.push("probe_gap_exceeded");
  const captureCoverage = coverage(usable[0]?.hostSentEpochMs, usable.at(-1)?.hostReceivedEpochMs,
    { startEpochMs, endEpochMs, coverageToleranceMs });
  if (!captureCoverage.passed) reasons.push("capture_coverage_incomplete");
  // Every answered probe is also a paired remote reading, slow transport or not.
  const remote = analyzeClockSeries(samples.filter((row, index) =>
    !["error", "invalid"].includes(measurements[index].status)),
    { epochField: "remoteEpochMs", monoField: "remoteMonotonicMs", spanField: "remoteReadSpanMs", maxGapMs: null });
  const roundTrips = measurements.map((row) => row.roundTripMonotonicMs).filter(finite).sort((a, b) => a - b);
  const violations = measurements.filter((row) => ["invalid", "backwards", "misaligned"].includes(row.status));
  return { passed: reasons.length === 0, reasons, sampleCount: samples.length, usableSampleCount: usable.length,
    uninformativeSampleCount: count("uninformative"), errorSampleCount: count("error"), errorCounts,
    misalignedSampleCount: count("misaligned"), invalidSampleCount: count("invalid"),
    uncertaintyBudgetMs: budget, maxUncertaintyMs: usable.length ? Math.max(...usable.map((row) => row.boundMs)) : null,
    // Descriptive intersection of the usable offset intervals; never applied.
    offsetIntervalMs: usable.length ? { lower: Math.max(...usable.map((row) => row.offsetLowerMs)),
      upper: Math.min(...usable.map((row) => row.offsetUpperMs)) } : null,
    roundTripMs: roundTrips.length ? { median: roundTrips[Math.floor((roundTrips.length - 1) / 2)],
      max: roundTrips.at(-1) } : null,
    maxProbeGapMs: gapsMs.length ? Math.max(...gapsMs) : null, coverage: captureCoverage,
    remoteClock: { gated: false, fittedSlewPpm: remote.fittedSlewPpm, rawResidualRangeMs: remote.rawResidualRangeMs,
      maxWindowDriftMs: remote.maxWindowDriftMs, maxResidualIncrementMs: remote.maxResidualIncrementMs,
      stepCount: remote.stepViolationCount, slowReadCount: remote.slowReadCount, maxReadSpanMs: remote.maxReadSpanMs },
    violations: violations.slice(0, MAX_REPORTED_VIOLATIONS) };
}
