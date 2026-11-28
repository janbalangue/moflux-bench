# The provider simulator

`sim/provider-sim.mjs` models the constraint that actually bites a shared
inference pool: **per-stream token rate falls as batch concurrency rises.**

The curve is the Universal Scalability Law, chosen because it is a published
model with interpretable parameters rather than a shape invented to flatter a
result:

```
speedup(n)   = n / (1 + σ(n−1) + κ·n(n−1))
aggregate(n) = r1 · speedup(n)          tokens/sec pool-wide
perStream(n) = aggregate(n) / n
```

- **σ** (contention) — 0 is linear scaling, 1 is fully serialized
- **κ** (coherency) — above 0, aggregate throughput becomes retrograde past a peak

`σ=0, κ=0` is the null hypothesis: capacity is effectively free, so admission
control should show little benefit. **Any claimed benefit must grow with σ.** If
a result appears at σ=0, suspect a bug.

σ is the number a skeptic will attack, so it is swept rather than chosen:

```bash
npm run sweep
```

Measured against the analytic curve at n=40 concurrent streams, r1=90:

| σ | κ | predicted tok/s | observed | error |
|---|---|---|---|---|
| 0 | 0 | 3600 | 3595.7 | 0.1% |
| 0.05 | 0 | 1220.3 | 1215.0 | 0.4% |
| 0.15 | 0 | 525.5 | 522.6 | 0.6% |
| 0.25 | 0 | 334.9 | 335.7 | 0.3% |
| 0.35 | 0 | 245.7 | 255.7 | 4.1% |
| 0.6 | 0 | 147.5 | 143.8 | 2.5% |
| 0.15 | 0.005 | 245.7 | 242.4 | 1.4% |

The simulator also samples a heavy-tailed output length (p99/median ≈ 5.8) and
**never discloses it to the caller** — an estimator must not be able to see the
thing it is trying to predict. True input tokens use a character ratio distinct
from any estimator's assumed ratio, plus jitter, so input estimation error is
non-zero and measurable.
