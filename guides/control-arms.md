# Comparing against the alternatives, not against nothing

A sweep that only runs MoFlux against no admission control answers a question
nobody is choosing between. The decision a reader actually faces is MoFlux
against a static per-replica cap or a Redis token bucket — policies they could
write themselves in an afternoon. Arms 2 and 4 exist precisely so that
comparison can be made, and they are now runnable inside the same paired sweep:

```bash
npm run demo:arms      # baseline, static cap, Redis, MoFlux — five seeds
```

Every arm sits in the same request-path position, uses the same four replicas
and the same provider, and replays the same immutable trace. Only the admission
policy changes. Tyr is stopped for the duration of each control arm so no grant
or admission decision from the managed path can leak into a control
measurement, and the Redis keys are flushed before arm 4 so a leaked lease from
an earlier seed cannot silently shrink the capacity this seed sees.

Arm 2 derives its local cap from the actual replica topology: with a 32-slot
provider envelope and four replicas, every local semaphore receives 8 slots.
The presenter and replica both fail before traffic starts if that calculation
is missing, non-finite, or would give a replica zero capacity; an invalid arm is
never aggregated as benchmark evidence.

The aggregate gains two sections:

- `aggregate.versusBaseline` — every policy against no control. Answers "does
  this help at all", which is the easy question.
- `aggregate.mofluxVersus` — MoFlux against each alternative, paired per seed
  and then medianed. Answers "is this worth deploying over the thing I would
  otherwise build", which is the one that decides anything.

Raw evidence per seed is preserved as `static-cap-seed-N.json`,
`redis-coordinated-seed-N.json`, and `arm-comparisons-seed-N.json`. The
existing `video-comparison.json` keeps its exact baseline-versus-MoFlux shape,
so nothing downstream of it changes.

Expect the control arms to do well. Arm 2 eliminates every upstream 429 with a
local semaphore and no coordination at all; arm 4 is a properly built Redis
reserve. If MoFlux cannot beat them on something that matters, that is the
result, and it is better to find it here than in a customer's cluster.

## Sample result

Historical single-run example: four replicas, envelope 32, σ=0.25, r1=400,
20s phase, seed 7. Treat it as illustrative, not publishable; the canonical
licensed demo now reports a five-seed aggregate:

| arm | int success | int p99 | int TTFT p99 | batch success | retries | cheap rejects | upstream 429 |
|---|---|---|---|---|---|---|---|
| 1 — no control | 88% | 11.3s | 4.02s | 85% | 1.53× | 0 | 99 |
| 2 — cap = env/N | 96% | 12.9s | 8.50s | 95% | 1.54× | 73 | 0 |
| 4 — Redis coordinated | 97% | 7.0s | 2.41s | 11% | 1.34× | 144 | 0 |

Three things worth reading carefully, including the ones that are inconvenient:

1. **Arm 2 eliminates every upstream 429 but makes TTFT worse** (8.50s vs
   4.02s). Its bounded queue converts rejection into waiting. Unbounded queues
   hide overload until it surfaces as timeouts — a limiter that "improves
   success rate" by making everyone wait has not necessarily helped.
2. **Arm 4 wins on interactive latency and destroys batch** (11% success, 3.7×
   retry amplification). Token-aware admission protects small requests by
   aggressively refusing large ones, and with no priority reserve and no way to
   express "batch should wait rather than fail," batch traffic absorbs the whole
   cost.
3. **Arm 3 comes out close to identical to Arm 1.** A cap that never binds is
   not protection, it is configuration that resembles protection. That is the
   finding, not a harness bug.
