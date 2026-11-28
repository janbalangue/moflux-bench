# Metrics that matter

The one that carries the argument is the **reject split**. A local reject costs
nothing. An upstream 429 was earned only after provider capacity had already
been spent on the request. Both look like a 429 to the caller; they are not the
same event, and the harness counts them separately.

Since 0.22.0, every local rejection is also preserved as a full admission-time
evidence record in `classes.<class>.localRejectSnapshots`. The record is keyed
back to the immutable trace request and includes the target replica, attempt,
rejection timestamp, Tyr pool/reason/type, admission class and revision, retry
hint, Latchflo grant provenance, and Tyr's complete `error.detail` object. That
object carries the global concurrency state, token-budget state, shared
capacity, class-protected/borrowed capacity, and the capacity constraint that
bound the decision. It is intentionally retained as an object rather than
flattened so new Tyr detail fields survive without a benchmark release.

For compact analysis, local rejects remain aggregated by pool and exact reason
with the observed `requested`, `available`, and `budget` token ranges.
`localRejectConstraints` additionally counts `global`, `admission_class`,
`admission_class_protection`, and `unspecified` decisions, and Prometheus exports
those counts as `bench_local_reject_constraint_total`. Seed preservation requires
`localRejectSnapshots.length === localReject`, so missing rejection evidence
invalidates the run instead of disappearing from the result.

A snapshot looks like this (values are illustrative):

```json
{
  "requestId": "batch-17",
  "requestClass": "batch",
  "attempt": 1,
  "rejectedAtMs": 18432.1,
  "target": "http://127.0.0.1:8104",
  "type": "admission_rejected",
  "pool": "sim-batch",
  "reason": "budget_limit",
  "admissionClass": "batch",
  "admissionRevision": 17,
  "retryAfterMs": 1250,
  "grant": { "id": "...", "controllerEpoch": 3 },
  "detail": {
    "limitRevision": 17,
    "constraint": "admission_class_protection",
    "inFlight": 4,
    "maxConcurrent": 8,
    "pending": 0,
    "maxQueue": 0,
    "tokenBudget": { "budget": 2500, "inFlightTokens": 2500, "effectiveBudget": 2500, "available": 0, "requested": 9008 },
    "sharedCapacity": { "concurrency": { "capacity": 4, "inUse": 4, "available": 0, "requestedBorrowed": 1 } },
    "admissionClass": { "id": "batch", "inFlight": 1, "protectedConcurrent": 1, "borrowedConcurrent": 0 }
  }
}
```

The others: token goodput (not throughput — abandoned work does not count),
latency and TTFT percentiles **split by class**, retry amplification (with the
`retryHints` breakdown of how much waiting was informed rather than guessed),
peak
envelope occupancy against ground truth from the simulator, and the cost of the
admission decision itself. Latency and TTFT are client-observed benchmark
metrics, not Tyr-native telemetry. During demos the load generator pushes them
to a persistent relay, which lets Prometheus retain both the baseline and
MoFlux arm after each short-lived generator process exits.

## An arm that measured nothing is not a result

Every other assertion on an arm checks that the right workload was *offered*:
the trace hash matches, the logical request counts match, the generator never
saturated. None of them checks that the workload produced an *outcome*. An arm
whose replicas are healthy but whose upstream is not the provider simulator
satisfies all three while reporting:

```
success 0.0%   goodput 0.00 req/s   p50 0.00s   local rejects 0
upstream 429 0   peak active ?/32   interactive retries 4.00x
```

Percentiles read `0.00s` because there are no successful samples, and retry
amplification pins to `--max-attempts` because every attempt failed. Aggregated
across seeds it becomes a published median.

The load generator already separates outcomes a policy decided (`success`,
`localReject`, `upstreamReject`) from outcomes nobody decided (`transportError`,
`serverError`). `demo/arm-health-lib.mjs` gates on that split: an arm with no
successes **and** no admission decisions is refused, as is one whose
unattributable failures exceed 1% of attempts. All 42 committed arm summaries
under `results/` carry zero of either, so that tolerance is headroom rather than
an allowance the published numbers depend on. A policy that legitimately refuses
every request, or a provider that 429s throughout, is a result and still passes.
