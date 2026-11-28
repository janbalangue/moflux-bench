# Known limitations

- **σ=1 is excluded.** At fully-serialized contention the simulator
  under-delivers ~11% against its own model, and the cause is not yet
  identified. Two hypotheses (tick quantization, TTFT-base formulation) were
  tested and neither explained it. The sweep is bounded at σ≤0.6 and σ=1 results
  should not be reported until this is understood.
- **A synthetic provider is a model.** It does not capture real provider-side
  scheduling, noisy neighbors, or actual vLLM/TensorRT batching. This measures
  *decision quality and coordination*, not absolute performance against a real
  provider. Read every number that way.
- **Trace determinism does not make the real-time system deterministic.** The
  logical arrival schedule, retry jitter, target choices, and request-level
  provider samples are now immutable and replayed exactly. HTTP scheduling,
  timer wakeups, and service progress still use a real clock, so measured
  latency and saturation boundaries can vary. Publish medians with spread
  across at least five seeds; single-run numbers remain anecdotes.
- **Workload calibration is load-bearing and easy to get wrong.** Set r1 too low
  and nothing completes inside a phase; set offered load too low and the
  envelope never saturates, so every arm looks identical. Both failure modes
  were hit while building this. Check that peak occupancy reaches the envelope
  and that success rates are neither 0% nor 100% before trusting a comparison.
- **Adaptive capacity-floor restoration is acknowledged and non-preemptive.**
  Tyr 0.35.0 reports bounded per-class demand plus ordered class occupancy
  evidence. Latchflo 0.20.1 transfers physical handoff safety authority to the
  restrictive successor grants after every drain ACK, so natural expiry of the
  predecessor lease no longer aborts an otherwise safe restoration. Running
  borrowers are never revoked; the lower shared authority drains by attrition,
  Tyr acknowledges the shrink, and Latchflo commits only after fresh occupancy
  proves the transfer safe. Prepared-successor expiry remains the conservative
  fallback after ACK; before ACK, the predecessor lease remains authoritative.
- **Streaming chunk granularity** is one SSE frame per simulator tick, not per
  token.
