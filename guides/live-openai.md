# Live OpenAI experiments

Two live OpenAI paths are opt-in and budget-capped. The compatibility path stays deliberately tiny:

```bash
export OPENAI_API_KEY='...'
npm run demo:openai:dry-run   # calculates the maximum planned cost; sends nothing
npm run demo:openai           # 8 direct + 8 Tyr requests by default
```

The compatibility default is the OpenAI **Responses API** (`POST /v1/responses`),
`gpt-5.6-luna`, 32 maximum output tokens, and a `$0.01` conservative per-run
budget. It measures provider compatibility plus direct-vs-Tyr latency/TTFT; it
is **not** overload evidence. Use `npm run demo:openai:chat` to retain the
legacy Chat Completions compatibility check, or `npm run demo:openai:responses`
for the explicit Responses form of the default.

## The overload experiment

The live overload experiment introduced in MoFlux Bench 0.29.0 uses sustained direct-provider calibration before the comparison. Calibrate first,
review the result and your account limits, then dry-run the matched comparison:

```bash
npm run demo:openai:overload:calibrate:dry-run
npm run demo:openai:overload:calibrate

npm run demo:openai:overload:dry-run
npm run demo:openai:overload
```

### Calibration

Calibration now establishes a 24-request baseline at 4 RPS, then offers bounded
10-second stages at 10, 20, 30, and 40 RPS by default. It reports the first
credible pressure signal from provider 429/5xx/transport failures, TTFT or
end-to-end p95 inflation, or persistent request/token rate-limit headroom at or
below 5%. The reported goodput/offered-rate ratio is diagnostic only because its
wall-clock denominator includes the final drain tail; it cannot by itself declare
provider pressure. Non-overload provider failures invalidate the pressure
inference instead of being counted as overload. Before the baseline and every
sustained stage, the harness also makes a tiny direct-provider probe and requires
at least 95% request and token headroom. If the bucket is depleted it waits using
the provider reset headers and reprobes; failure to recover within the bounded
recovery window invalidates the evidence instead of running from an unequal
starting state. Missing request/token limit headers also fail closed because the
starting condition cannot be proven. The conservative default reserves up to 1,054 requests including
recovery probes and remains below the $0.10 spend guard at the bundled model
pricing. Calibration is never mixed into arm-comparison evidence.

Useful overrides include:

```bash
npm run demo:openai:overload:calibrate -- \
  --calibration-rps-steps=10,20,30,40,50 \
  --calibration-stage-ms=10000 \
  --calibration-baseline-requests=24 \
  --calibration-baseline-rps=4
```

The old `--calibration-steps` / `--calibration-requests-per-worker` burst mode is
retained for backward compatibility and is selected automatically when either
legacy option is supplied. New runs should use sustained calibration.

### Compare mode

Compare mode generates one immutable mixed interactive/batch request trace and
replays it through three arms: direct OpenAI, a fail-fast static local
concurrency cap, and Tyr protected admission classes using the same physical
concurrency cap. The canonical default trace runs for 10 seconds with a 10 RPS
interactive stream and a 70 RPS batch surge from 2-10 seconds, using 64-character
inputs and 8-token output reservations. Static and MoFlux both use a 36-request
physical cap; MoFlux protects 8 interactive and 4 batch slots, leaving 24 shared
slots available for cross-class borrowing. This avoids accidentally turning
protected floors into rigid static partitions when the provider is not under
pressure. The conservative worst-case plan is about $0.168 at the reviewed
default model pricing. The default overload budget is `$0.18`,
and every explicit live-OpenAI per-run override remains hard-capped at `$1.00`.
The harness also refuses more than 2,000 planned requests, including the maximum
configured rate-limit recovery probes, in one invocation.

### Multi-seed sweep

For publication evidence across multiple independently guarded seeds, use the
sequential sweep wrapper. It always runs the same three arms (`direct`, `static`,
`moflux`) once per seed, but counterbalances their execution order with a
deterministic six-permutation schedule keyed by seed. Seeds 1-6 cover every
possible arm order once; seeds 7-8 repeat the first two permutations, leaving each
arm in each first/middle/last position either two or three times across the default
eight-seed sweep. The wrapper keeps the original per-seed request/spend and
recovered-headroom gates, then validates identical runtime/workload/policies before
pooling raw request records into one top-level `summary.json`. Per-seed summaries
remain next to it for provenance. The sweep itself has a separate aggregate spend
ceiling. A live sweep now aborts immediately after the first inconclusive seed,
because the pooled publication gate requires every included seed to be a
conclusive provider-overload comparison; continuing would only spend more money
on a sweep that could not qualify.

```bash
npm run demo:openai:overload:sweep:dry-run

# Remove --dry-run only after reviewing all eight per-seed plans.
npm run demo:openai:overload:sweep
```

Those bare commands use the reviewed 80-RPS canonical profile described above,
require 99% starting request/token headroom before every arm, reserve at most
`$0.18` per seed (`$1.44` across eight seeds), and retain the `$1.50` aggregate
sweep ceiling. Every workload and policy parameter remains explicitly
overridable for new calibration work.

Generated output lands under
`results/runs/openai-live-overload-sweep/<run-id>/summary.json`, with
`seed-1/summary.json` through `seed-8/summary.json` retained beneath the same
run directory. The pooled summary recomputes success counts, provider failures,
TTFT/latency percentiles, and goodput from the raw per-request records; it does
not average per-seed p95 values. It also records paired per-seed deltas, the
actual arm order and arm position for every seed, aggregate first/middle/last
position counts, and flags for conclusive
provider pressure, rate-limit isolation, zero controlled-arm 429s, counterbalanced
arm ordering, and a positive MoFlux interactive-success advantage on every seed.

### What the experiment isolates

The first live overload experiment intentionally isolates **single-node protected
concurrency**. It does not enable Tyr's in-flight token budget and does not run
Latchflo fleet coordination. That keeps the provider question separate from the
coordinator question already covered by simulator sweeps. Tyr request classes
are selected through short-lived benchmark JWTs served by an ephemeral local
JWKS endpoint; the OpenAI API key remains only in the caller process and is
forwarded as the provider `Authorization` header. Generated JWT signing keys
exist only in memory.

### When a run counts as an overload comparison

A completed run is not automatically an overload win. The JSON explicitly marks
`conclusiveProviderOverloadComparison=false` unless the direct arm shows a strict
provider-pressure signal, local admission contention is exercised, Tyr's bounded
admission-class attribution is proven, and every arm starts with verified recovered
provider rate-limit headroom. Before each arm, a direct-provider recovery probe
requires at least 95% request and token headroom; depleted buckets are allowed to
recover using provider reset headers, and failure to recover makes the comparison
inconclusive. `--runs` still rotates arm order across repetitions, while
`--arm-cooldown-ms` is only an optional minimum pause before the mandatory recovery
gate. Useful fairness overrides are `--rate-limit-start-headroom-ratio`,
`--rate-limit-recovery-timeout-ms`, and `--rate-limit-recovery-max-probes`.

## API key, pricing and the spend guard

For either live path, the API key is read only from `OPENAI_API_KEY`; it is not
copied into benchmark env files, Docker Compose, logs, or result JSON. Unknown
models require explicit current input/output prices. The spend guard protects one
planned run and does not know account-wide monthly spend. Pricing for the bundled
default was reviewed against OpenAI's model page on 2026-08-28.
