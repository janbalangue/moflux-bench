/** Prospectively versioned setup readiness for burst-recovery-v4. */
export const BURST_REPLAY_PROTOCOL = "burst-recovery-v4";
export const BURST_PRIME_AT_MS = 41_000;
export const BURST_SETUP_AT_MS = 42_000;
export const BURST_SETUP_MAX_WAIT_MS = 15_000;
export const BURST_SETUP_MAX_OBSERVATION_AGE_MS = 500;
export const BURST_PRIME_REQUEST_ID = "moflux-bench-batch-prime-1-a1";
export const BURST_SETUP_REQUEST_ID = "moflux-bench-batch-setup-1-a1";
const POLL_MS = 50;
const CHECKPOINT_POLL_MS = 100;
const CHECKPOINT_REQUEST_TIMEOUT_MS = 250;
const CHECKPOINT_GIVE_UP_MS = BURST_SETUP_AT_MS + 1_000;
const REQUEST_TIMEOUT_MS = 1_000;
const finite = (value) => typeof value === "number" && Number.isFinite(value);

export function validateBurstReplayOptions(config, trace) {
  if (!config.burstRecoveryProtocol && !config.burstSetupReadinessUrl) return false;
  if (config.burstRecoveryProtocol !== BURST_REPLAY_PROTOCOL) {
    throw new Error("burst setup readiness requires --burst-recovery-protocol=burst-recovery-v4");
  }
  if (!config.backendAvailability || !config.traceFile || config.maxAttempts !== 1) {
    throw new Error("burst-recovery-v4 requires --backend-availability=true, --trace-file, and --max-attempts=1");
  }
  let url;
  try { url = new URL(config.burstSetupReadinessUrl); } catch {
    throw new Error("burst-recovery-v4 requires a loopback HTTP --burst-setup-readiness-url");
  }
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.hash || !url.port) {
    throw new Error("--burst-setup-readiness-url must use HTTP, a loopback IP, and an explicit port without credentials or a fragment");
  }
  const expected = [
    ["batch-prime-1", "batch", BURST_PRIME_AT_MS],
    ["batch-setup-1", "batch", BURST_SETUP_AT_MS],
    ["batch-setup-2", "batch", 44_000],
    ["batch-setup-3", "batch", 46_000],
    ["interactive-burst-1", "interactive", 60_000],
    ["interactive-burst-2", "interactive", 60_000],
  ];
  if (!Array.isArray(trace?.entries) || expected.some(([id, cls, at]) => {
    const matches = trace.entries.filter((entry) => entry.id === id);
    return matches.length !== 1 || matches[0].class !== cls || matches[0].arrivalMs !== at;
  }) || !trace.entries.some((entry) => entry.id === "batch-prime-1" && entry.maxTokens === 1 && entry.inputChars === 400)) {
    throw new Error("burst-recovery-v4 requires the canonical prime, setup, and return trace entries");
  }
  return true;
}

/** Pair each wall reading with the midpoint and span of its monotonic reads. */
export function pairedClockSample(epochMs = Date.now, monotonicMs = () => performance.now()) {
  const before = monotonicMs();
  const epoch = epochMs();
  const after = monotonicMs();
  return { epochMs: epoch, monotonicMs: (before + after) / 2, readSpanMs: after - before };
}

/**
 * Required state before setup request 1: the prime completed with its one
 * reported token, no batch request is in flight, and the batch protected
 * floor is one. The deciding observation is the last one the client had
 * received before it sent setup request 1, and it must have begun after the
 * prime ended and within 500 ms of that send. Every timestamp is a host wall
 * reading, so the verdict needs no cross-clock alignment. Pure: the loadgen
 * calls it live and the analysis recomputes it from the retained rows.
 */
export function burstSetupVerdict({ observations = [], prime, setupSentAtEpochMs } = {}) {
  const reasons = [];
  const primeEnded = finite(prime?.endedAtEpochMs);
  if (!prime) reasons.push("prime_attempt_missing");
  else if (!primeEnded) reasons.push("prime_not_completed");
  else if (prime.outcome !== "completed" || prime.outputTokensReported !== true || prime.outputTokens !== 1) {
    reasons.push("prime_not_completed_with_one_reported_token");
  }
  const sent = finite(setupSentAtEpochMs);
  if (!sent) reasons.push("setup_send_missing");
  else if (primeEnded && prime.endedAtEpochMs >= setupSentAtEpochMs) reasons.push("prime_completed_after_setup_send");
  const usable = (Array.isArray(observations) ? observations : []).filter((row) => !row?.error &&
    [row?.sampleStartedAtEpochMs, row?.observedAtEpochMs, row?.receivedAtEpochMs].every(finite) &&
    row.sampleStartedAtEpochMs <= row.observedAtEpochMs);
  const observation = sent ? usable.filter((row) => row.receivedAtEpochMs <= setupSentAtEpochMs).at(-1) ?? null : null;
  if (!observation) reasons.push("no_readiness_observation_before_setup");
  else {
    if (setupSentAtEpochMs - observation.sampleStartedAtEpochMs > BURST_SETUP_MAX_OBSERVATION_AGE_MS) {
      reasons.push("readiness_observation_stale");
    }
    if (primeEnded && observation.sampleStartedAtEpochMs < prime.endedAtEpochMs) {
      reasons.push("readiness_observed_before_prime_completed");
    }
    if (observation.batchInFlight !== 0) reasons.push("batch_request_in_flight");
    if (observation.batchProtectedConcurrent !== 1) reasons.push("batch_protected_floor_not_one");
  }
  return { ready: reasons.length === 0, reasons, observation,
    primeEndedAtEpochMs: primeEnded ? prime.endedAtEpochMs : null,
    setupSentAtEpochMs: sent ? setupSentAtEpochMs : null,
    primeEndedBeforeSetupMs: primeEnded && sent ? setupSentAtEpochMs - prime.endedAtEpochMs : null,
    observationAgeMs: observation && sent ? setupSentAtEpochMs - observation.sampleStartedAtEpochMs : null };
}

/**
 * Observe-only checkpoint for burst-recovery-v4. Arrivals stay fixed: this
 * polls the runner's admission state from the prime's planned send until
 * setup request 1 has actually been sent, then reports the verdict at once.
 * It never delays, moves, retries or cancels a request; a missed checkpoint
 * makes the trial invalid and the open-loop trace continues unchanged.
 */
export async function observeBurstSetup({ offsetMs, epochMs = Date.now, sleep,
  getPrimeAttempt, getSetupAttempt, readReadiness }) {
  const observations = [];
  const sentAt = () => { const at = getSetupAttempt()?.sentAtEpochMs; return finite(at) ? at : null; };
  const untilPrimeMs = BURST_PRIME_AT_MS - offsetMs();
  if (untilPrimeMs > 0) await sleep(untilPrimeMs);
  while (sentAt() === null && offsetMs() < CHECKPOINT_GIVE_UP_MS) {
    const atMs = offsetMs(), requestedAtEpochMs = epochMs();
    let state = null, error = null;
    try { state = await readReadiness(CHECKPOINT_REQUEST_TIMEOUT_MS); }
    catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    observations.push({ atMs, requestedAtEpochMs, receivedAtEpochMs: epochMs(),
      sampleStartedAtEpochMs: state?.sampleStartedAtEpochMs ?? null, observedAtEpochMs: state?.observedAtEpochMs ?? null,
      batchInFlight: state?.batchInFlight ?? null, batchProtectedConcurrent: state?.batchProtectedConcurrent ?? null,
      ...(error === null ? {} : { error }) });
    if (sentAt() !== null) break;
    // Poll through the planned send; the last answer received before the
    // actual send decides, so a late poll is retained but cannot count.
    await sleep(Math.min(CHECKPOINT_POLL_MS, Math.max(1, BURST_SETUP_AT_MS - offsetMs())));
  }
  const verdict = burstSetupVerdict({ observations, prime: getPrimeAttempt(), setupSentAtEpochMs: sentAt() });
  return { schemaVersion: 1, status: verdict.ready ? "ready" : "missed", reasons: verdict.reasons,
    decidedAtMs: offsetMs(), decidedAtEpochMs: epochMs(), setupSentAtEpochMs: verdict.setupSentAtEpochMs,
    primeEndedAtEpochMs: verdict.primeEndedAtEpochMs, observation: verdict.observation, observations };
}

/**
 * NOT part of burst-recovery-v4, which keeps fixed arrivals. This bounded
 * barrier is the candidate for a later protocol version if the fixed schedule
 * proves unreliable on a quiet host; nothing in the load generator calls it.
 *
 * Replay only the initial segment until the one-shot prime has completed and
 * the runner has observed the required admission state. After that point all
 * arrivals move by one common offset; there are no per-request retries or
 * completion-dependent arrivals in the measured cohort.
 *
 * Dependencies permit deterministic tests of deadlines, failed primes, and
 * slow/unavailable readiness endpoints without collecting benchmark evidence.
 */
export async function replayBurstTrace({ entries, scheduleEntry, offsetMs, epochMs = Date.now,
  sleep, getPrimeAttempt, readReadiness }) {
  await Promise.all(entries.filter((entry) => entry.arrivalMs < BURST_SETUP_AT_MS).map(scheduleEntry));
  const waitBeforeBarrierMs = BURST_SETUP_AT_MS - offsetMs();
  if (waitBeforeBarrierMs > 0) await sleep(waitBeforeBarrierMs);
  const deadlineMs = BURST_SETUP_AT_MS + BURST_SETUP_MAX_WAIT_MS;
  let primeCompletedAtEpochMs = null;
  let readiness = null;
  let readinessError = null;
  const failed = (reason) => ({ status: "failed", reason,
    failedAtEpochMs: epochMs(), waitedMs: Math.max(0, offsetMs() - BURST_SETUP_AT_MS),
    maxWaitMs: BURST_SETUP_MAX_WAIT_MS, primeCompletedAtEpochMs, readiness, readinessError });
  while (offsetMs() < deadlineMs) {
    const prime = getPrimeAttempt();
    if (!prime) return failed("prime_attempt_missing");
    if (finite(prime.endedAtEpochMs)) {
      if (prime.outcome !== "completed" || prime.outputTokens !== 1 || prime.outputTokensReported !== true) {
        return failed("prime_not_successfully_completed_with_one_reported_token");
      }
      primeCompletedAtEpochMs = prime.endedAtEpochMs;
      try {
        readiness = await readReadiness(Math.min(REQUEST_TIMEOUT_MS, deadlineMs - offsetMs()));
        readinessError = null;
      } catch (error) {
        readinessError = error instanceof Error ? error.message : String(error);
      }
      // A late success is still a failed barrier. Never release an arrival
      // beyond the predeclared readiness bound, even when HTTP eventually wins.
      if (offsetMs() >= deadlineMs) break;
      if (readinessError === null && readiness?.ready === true && finite(readiness.observedAtEpochMs)) {
        const readyAtEpochMs = epochMs();
        const shiftMs = Math.max(0, offsetMs() - BURST_SETUP_AT_MS);
        const result = { status: "ready", shiftMs, readyAtEpochMs,
          primeCompletedAtEpochMs, readiness, maxWaitMs: BURST_SETUP_MAX_WAIT_MS };
        await Promise.all(entries.filter((entry) => entry.arrivalMs >= BURST_SETUP_AT_MS)
          .map((entry) => scheduleEntry({ ...entry, baseArrivalMs: entry.arrivalMs,
            arrivalMs: entry.arrivalMs + shiftMs })));
        return result;
      }
    }
    const remainingMs = deadlineMs - offsetMs();
    if (remainingMs > 0) await sleep(Math.min(POLL_MS, remainingMs));
  }
  return failed(primeCompletedAtEpochMs === null ? "prime_completion_timeout" : "readiness_timeout");
}
