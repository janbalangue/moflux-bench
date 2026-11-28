# The load generator

`load/loadgen.mjs` is **open-loop**. Arrivals follow a Poisson process on a
timer and do not wait for completions. A fixed worker pool cannot generate more
load than the system absorbs, so overload hides inside the generator instead of
appearing in the numbers — that is coordinated omission, and it is the most
common way a benchmark like this quietly lies in the vendor's favor.

If the generator itself runs out of headroom it increments
`generator_saturated_total`. **Any run where that is non-zero must be
discarded**, because the bottleneck was the instrument. The Grafana dashboard
has a panel for it that turns red.

Two competing classes: `interactive` (small, latency-sensitive, high priority)
and `batch` (large prompts, arriving as a step function partway through).
Retries use exponential backoff with jitter, which is what converts provider
rejection into retry amplification.

When a rejection carries a retry hint — `x-admission-retry-after-ms`, or
`Retry-After` — the generator waits that long instead of guessing. The hint is
a floor, never a license to retry sooner: the wait is the larger of the blind
backoff and the server's estimate, spread by a fraction of itself so replicas
do not wake together. That mirrors how Tyr consumes `Retry-After` from
Latchflo, so the harness measures a well-behaved client rather than a bespoke
one. A no-control arm receives no hints and is unaffected.

`--honor-retry-hints=false` forces blind backoff over the **identical trace**,
which makes the hint's contribution an exact A/B rather than an inference. The
hint spread reuses the trace's pre-drawn `retryJitter` rather than drawing
fresh randomness, so the trace hash is unchanged and hint-aware runs stay
comparable to results recorded before this existed.

Reading the result: expect completion rate to rise and tail latency to look
worse. Requests that previously exhausted their attempt budget contributed no
latency sample at all; when they start succeeding they contribute slow ones. A
p95 increase alongside a completion increase is the fix working.

To check that per request, add `--emit-phase-samples=true` to a presenter or
sweep command, for example
`npm run demo:hetero:adaptive:blind -- --emit-phase-samples=true`. Each arm's
class summary then carries `phaseSamples`, one record per completed request with
`arrivalMs`, `completedAtMs`, `latencyMs` and `ttftMs`. Latency and TTFT are
measured from the request's first attempt, so they include every rejection and
retry wait. A sample's `arrivalMs` identifies its trace entry, and that entry's
`id` matches the `requestId` on the request's rejection snapshots. The option is
off by default because it enlarges every summary. It is not part of the scenario
or the trace, so it cannot split a sweep. The class `latencyMs` and `ttftMs`
percentiles are computed from the same records whether or not the option is set.
