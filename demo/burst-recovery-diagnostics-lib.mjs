const finite = (value) => typeof value === "number" && Number.isFinite(value);
const observed = (value) => finite(value) ? value : null;

/** Track the original borrowed requests, independently of current occupancy. */
export function summarizeOriginalBorrowers({ setup = [], returnedAtEpochMs, accountingZeroEpochMs } = {}) {
  const attributionComplete = setup.length > 0 && setup.every((request) =>
    typeof request.admission?.resources?.borrowedConcurrency === "boolean");
  const borrowers = setup.filter((request) => request.admission?.resources?.borrowedConcurrency === true)
    .map(({ requestId, attempt }) => {
      const completedAtEpochMs = attempt?.outcome === "completed" ? observed(attempt.endedAtEpochMs) : null;
      return { requestId, outcome: attempt?.outcome ?? "missing", completedAtEpochMs,
        remainingStreamMs: finite(completedAtEpochMs) && finite(returnedAtEpochMs)
          ? completedAtEpochMs - returnedAtEpochMs : null };
    });
  const completedCount = borrowers.filter((request) => finite(request.completedAtEpochMs)).length;
  const allStreamsCompleted = attributionComplete && borrowers.length > 0 && completedCount === borrowers.length;
  // A last observed completion is not the final borrower completion if any
  // borrowed request is missing or still censored.
  const lastCompletedAtEpochMs = allStreamsCompleted
    ? Math.max(...borrowers.map((request) => request.completedAtEpochMs)) : null;
  return { attributionComplete, borrowedRequestCount: borrowers.length, completedCount, allStreamsCompleted,
    lastCompletedAtEpochMs,
    lastCompletionDelayMs: finite(lastCompletedAtEpochMs) && finite(returnedAtEpochMs)
      ? lastCompletedAtEpochMs - returnedAtEpochMs : null,
    // This signed difference uses the observed upper endpoint of accounting
    // zero. It is not an exact physical capacity-reclamation interval.
    afterAccountingZeroMs: finite(lastCompletedAtEpochMs) && finite(accountingZeroEpochMs)
      ? lastCompletedAtEpochMs - accountingZeroEpochMs : null,
    borrowers };
}

const validKv = (sample) => finite(sample.kvUsage) && sample.kvUsage >= 0 && sample.kvUsage <= 1;

function pressureSummary(samples, saturationThreshold) {
  const usable = samples.filter(validKv);
  const saturated = usable.filter((sample) => sample.kvUsage >= saturationThreshold);
  const times = saturated.map((sample) => sample.atEpochMs).filter(finite);
  return { pressureSampleCount: samples.length, validKvSampleCount: usable.length,
    missingOrInvalidKvSampleCount: samples.length - usable.length,
    maxKvUsage: usable.length ? Math.max(...usable.map((sample) => sample.kvUsage)) : null,
    // Samples are observations, not durations: the scheduler observer does
    // not provide uninterrupted sampling while the engine is idle.
    saturationSampleCount: usable.length ? saturated.length : null,
    firstSaturationAtEpochMs: times.length ? Math.min(...times) : null };
}

function borrowerTransitions(pressure, setup, returnedAtEpochMs, horizonEpochMs) {
  if (!finite(returnedAtEpochMs) || !finite(horizonEpochMs) || horizonEpochMs <= returnedAtEpochMs) return null;
  const ids = setup.filter((request) => request.admission?.resources?.borrowedConcurrency === true)
    .map((request) => request.requestId);
  const hasIdentities = (sample) => Array.isArray(sample.runningRequestIds) && Array.isArray(sample.waitingRequestIds);
  const state = (sample, id) => {
    const running = sample.runningRequestIds.includes(id), waiting = sample.waitingRequestIds.includes(id);
    return running === waiting ? null : running ? "running" : "waiting";
  };
  const samples = pressure.filter((sample) => finite(sample.atEpochMs)).sort((a, b) => a.atEpochMs - b.atEpochMs);
  const transitions = [];
  let previous = null, identitySampleCount = 0;
  for (const sample of samples) {
    if (sample.atEpochMs >= horizonEpochMs) break;
    if (!hasIdentities(sample)) { previous = null; continue; }
    if (sample.atEpochMs >= returnedAtEpochMs) {
      identitySampleCount++;
      if (previous) for (const requestId of ids) {
        const from = state(previous, requestId), to = state(sample, requestId);
        if (from && to && from !== to) transitions.push({ requestId, from, to,
          lowerEpochMs: previous.atEpochMs, upperEpochMs: sample.atEpochMs });
      }
    }
    previous = sample;
  }
  return { identitySampleCount,
    runningToWaitingCount: identitySampleCount ? transitions.filter((transition) => transition.from === "running").length : null,
    waitingToRunningCount: identitySampleCount ? transitions.filter((transition) => transition.from === "waiting").length : null,
    transitions };
}

/** Descriptive scheduler observations; no timing, workload or validity gates. */
export function summarizeBurstEnginePressure({ backendEvents = [], armSummary, setup = [],
  returnedAtEpochMs, horizonEpochMs } = {}) {
  const saturationThreshold = 1;
  const pressure = backendEvents.filter((event) => event.event === "pressure");
  const windowKnown = finite(returnedAtEpochMs) && finite(horizonEpochMs) && horizonEpochMs > returnedAtEpochMs;
  const windowSummary = windowKnown ? pressureSummary(pressure.filter((sample) => finite(sample.atEpochMs) &&
    sample.atEpochMs >= returnedAtEpochMs && sample.atEpochMs < horizonEpochMs), saturationThreshold) : null;
  const preemptions = armSummary?.vllm?.preemptions;
  return { saturationThreshold,
    capture: pressureSummary(pressure, saturationThreshold),
    returnWindow: windowSummary ? { ...windowSummary,
      firstSaturationDelayMs: finite(windowSummary.firstSaturationAtEpochMs)
        ? windowSummary.firstSaturationAtEpochMs - returnedAtEpochMs : null } : null,
    // The counter spans the measured arm, so it cannot identify the request,
    // instant or cause of a particular observed scheduler state transition.
    preemptionsDuringArm: { start: observed(preemptions?.start), end: observed(preemptions?.end),
      delta: finite(preemptions?.delta) && preemptions.delta >= 0 ? preemptions.delta : null },
    originalBorrowerTransitions: borrowerTransitions(pressure, setup, returnedAtEpochMs, horizonEpochMs) };
}
