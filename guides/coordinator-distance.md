# Coordinator distance

Every admission-control design answers "may this request proceed" against state
shared across replicas, and there are two ways to do it.

**Per-request coordination** (arm 4, Redis) consults the shared store on every
admission. The decision is always exact. The cost is one round trip per
attempt, on the request's critical path, forever.

**Lease-based coordination** (MoFlux) holds a grant of capacity and decides
locally against it. The round trip is paid on grant renewal, off the critical
path, amortized across every admission the grant covers. The decision is exact
within the grant and approximate across the fleet.

On loopback these are indistinguishable, because a round trip costs a few
hundred microseconds. Every comparison in this harness was run that way until
0.10.0, which gave the per-request design the most favorable condition it can
have and one that does not exist in production — a same-AZ hop is roughly
0.5-1ms, cross-AZ 1-3ms, and a contended instance considerably more.

```bash
npm run demo:coordinator      # full sweep at 0, 1, 5, 15, 30, 50ms
```

`--coordinator-latency-ms` is applied to the Redis client's every command.
Only arm 4 receives it, because only arm 4 consults a coordinator while
admitting; sending it to the others would make them look sensitive to a service
they never call. `demo/verify-loadgen-args.mjs` enforces that routing.

Since 0.19.0, provider-sim readiness is taken from its own `server.listen()`
callback banner rather than from an HTTP client probe. The ladder repeatedly
stops and rebinds port 9000 between arms and rungs, so startup must not depend on
Node's fetch connection pool, HTTP parser, or proxy configuration. Tyr and
replica readiness still use their application-level `/healthz` checks.

A bound socket is not the same as owning the address the replicas will dial, so
the banner is followed by an identity probe: provider-sim publishes an instance
id in that banner and serves `service` and `instance` from `/admin/stats`, and
each arm confirms the two match over the same global fetch the load generator
uses. This catches a foreign process holding `127.0.0.1:9000` while the
simulator binds `0.0.0.0` (macOS allows both, and the specific bind wins
loopback), an HTTP proxy intercepting loopback, and a simulator left over from an
earlier arm — each before a measured phase is spent rather than after.

Each rung writes its own run directory under
`results/runs/video-seed-sweep/<ladder-id>-coord-<rung>ms/` and is read back from
it, so a rung is attributable to the sweep that produced it. Every arm records
the rung it ran at; only the Redis arm records having *paid* it. The ladder's own default capacity policy is the historical 31/1 profile. The
`demo:coordinator:adaptive` command explicitly selects classic
`adaptive-28-4` to isolate coordinator-distance behavior; it intentionally does
not inherit the heterogeneous benchmark's headroom-aware policy.

On Node 24, the arm proxy also treats caller disconnects from the response side.
After the request body has been consumed, `IncomingMessage.close` may represent a
normal completed request; only a `ServerResponse.close` before `writableEnded`
cancels the in-flight provider fetch. This keeps the four comparison arms on the
same forwarding path without turning successful admissions into transport errors.

## The prediction, and how it can fail

Per-request coordination should degrade roughly linearly with distance,
multiplied by attempts per request. Lease-based coordination should be flat.

`results/coordinator-ladder.json` reports, per arm, a linear fit of added
latency against coordinator distance **within each seed**, then aggregates
those slopes across seeds. Every seed replays a byte-identical trace at every
rung, so the seed is the natural unit of pairing and the slope is the effect
the pairing isolates.

Through 0.19.0 the report did something else: it fitted six cross-seed medians,
one per rung. On the 20260813T054929Z ladder the between-seed spread was
194-505ms against a 132ms effect, and the median landed on a different seed at
different rungs, so a single rank swap read as an outlier, r² collapsed to
0.0487, and every arm — Redis included — was reported as
coordinator-independent. That failure is asymmetric and worth stating plainly:
under an r² gate, noise confirms flatness for an arm predicted to be flat and
refutes degradation for an arm predicted to degrade, so an unpaired fit over
noisy medians can only ever report "no coordination cost", whichever way the
data points. The unpaired figures are still published as
`unpairedCoordinatorIndependent` for continuity, and are not the verdict.

Four verdicts are possible per arm, and **"insensitive" is not the default**:

| verdict | meaning |
| --- | --- |
| `degrades` | 95% interval excludes zero from above, or the exact two-sided sign test establishes a positive direction at p < 0.05 |
| `improves` | 95% interval excludes zero from below, or the exact two-sided sign test establishes a negative direction at p < 0.05 |
| `insensitive` | interval lies wholly inside ±0.1 ms/ms — an effect worth caring about is positively ruled out. Tested **before** the interval's sign, so a negligible-but-measurable slope reads as negligible rather than directional |
| `inconclusive` | interval contains both zero and a real effect |

`inconclusive` is a normal outcome at five seeds. It is not evidence of
flatness and must not be published as any. `resolutionMsPerMs` reports the
smallest slope the ladder could have ruled out, so a reader can tell
"measured as flat" from "could not tell" without reading this file.

Direction is counted both ways. A slope of exactly zero is neither degrading
nor improving, so `seedsDegrading`, `seedsImproving` and `seedsTied` are all
published and the sign test runs over the seeds that actually moved — five
rising and three tied is a test on five, not on eight. Testing direction as
"not the other side" would read eight motionless seeds as eight seeds agreeing
on improvement, and at six seeds or more that clears the sign test.

`verdictBasis` names the rule that fired, because the two rules are not equally
strong. An interval excluding zero is the better evidence. Unanimous direction
across five seeds is a sign test at two-sided p = 0.0625 — the most extreme
result five seeds can produce, and still short of 0.05 — so **five unanimous
seeds remain `inconclusive` when the interval also spans zero**. Six unanimous
seeds reach 0.031 and eight reach 0.008. The report also publishes a
`directionalP` for the pre-specified positive-slope t test, but that diagnostic
does not override the two-sided verdict threshold.

The ladder also records admission-decision cost directly for both Redis and
MoFlux. Redis exports per-outcome decision sum/count metrics around its atomic
Lua reserve; MoFlux reads Tyr 0.35.0's per-outcome decision histogram
`_sum`/`_count` deltas. Paired sensitivity therefore fits admitted and rejected
decision cost separately against coordinator distance rather than pooling
outcomes. Redis's slope measures the coordinator round-trip dependency; MoFlux's
slope tests whether its local synchronous decision work remains independent of
that distance. TTFT remains the user-visible consequence, with provider
latency, retries and queueing left visible rather than mistaken for decision
cost.

The crossover is reported only when it is **observed and stable inside the
tested ladder**. A paired crossing requires a majority of *seeds* to change
hands, be confirmed at at least one subsequent larger rung, and keep that
majority through every larger tested rung. A one-rung majority flip — including
a lead that appears only at the final rung — is retained as
`transientMajorityLeadRungsMs`, not promoted to a crossover. This prevents the
old "first sign flip wins" behavior from calling a noisy 1ms lead a crossing
when the arm falls behind again at 5, 15 or 30ms, or calling an unconfirmed
50ms endpoint a stable crossing. If the two arms never establish a persistent
lead, the report says so and gives the narrowest median deficit rather than
extrapolating beyond the tested range.

Sizing note: each rung is a complete paired sweep, so the cost is
rungs × seeds × arms runs — the six-rung, five-seed ladder above took just over
two hours. Start with two or three rungs before committing to the full ladder.

```bash
npm run demo:coordinator:reanalyze -- --reanalyze=20260813T054929Z
```

Re-reads an existing ladder's per-rung run directories and rebuilds the report
from them, running nothing. A change to the analysis must not require re-paying
for the measurement; every per-seed arm summary the analysis reads is already
on disk, named by the sweep that wrote it. A ladder that died partway is re-read
on the rungs that completed, with the missing ones named and the partial fit
declared; fewer than two rungs is refused outright.

To continue an interrupted ladder instead of only analyzing it, pass
`--resume=<ladder-id>` with the same rung, seed, profile and order arguments.
Completed rung summaries are validated before reuse; missing rungs run normally.
For example, the adaptive ladder can resume with:

```bash
npm run demo:coordinator:adaptive -- --resume=20260813T201610Z
```

## What the admission-decision measurement covers

The admission-cost measurement introduced in MoFlux Bench 0.27.0 measures both sides directly. Redis times its atomic Lua
reserve round trip, which grants or refuses immediately and therefore has no
separate queue-wait component. Tyr 0.35.0 exports
`tyr_admission_decision_seconds` and `tyr_admission_queue_wait_seconds`; the
benchmark reads histogram `_sum` / `_count` values before and after each run so
startup traffic cannot enter the result.

The comparison is intentionally **per outcome**. `admitted` and `rejected` get
separate decision means because Redis and MoFlux can reject at different rates
for different reasons; pooling them would compare different mixtures. Tyr's
`decisionDuration` is synchronous local admission work and explicitly excludes
the awaited concurrency queue. Queue wait is retained as a separate diagnostic
and is never added to the MoFlux decision-cost headline.

For every Tyr pool/outcome/admission-class series, the benchmark requires the
decision histogram count, queue-wait histogram count, and
`tyr_admission_decisions_total` count to agree after baseline subtraction. Tyr
0.30.0 or later with an absent metric or zero total decisions is a hard error: lost
instrumentation must never become a reported zero. Historical pre-0.27.0 runs
remain `not-instrumented`. The Redis arm likewise checks its per-outcome timing
counts against its admitted and local-rejected counters.

The MoFlux result also records a diagnostic four-`hrtime.bigint()` clock
overhead measurement alongside the decision number. It is not subtracted from
the measured decision duration; the reported value therefore remains
conservative. The benchmark asserts the managed arm is actually running
`admissionMode: enforce` from Tyr `/stats` before collecting any timing claim.

The report framing is explicit: **Redis's atomic reserve round trip is its total
decision cost; MoFlux's decision duration is local synchronous Tyr/ABL work and
excludes queue wait.** No quantile interpolation is used for the headline.

## Rung order is a variable

```bash
npm run demo:coordinator:adaptive          # 0/5/20/50ms x 8 seeds, adaptive-28-4
npm run demo:coordinator:adaptive:strict   # same ladder + full adaptive outcome gate
```

`--rung-order` is `ascending` by default, which is fully confounded: the largest rung is always measured last,
so drift over the ladder's several hours — thermal, background load, a warming
cache — is collinear with coordinator distance and cannot be separated from it
afterwards. `rungOrderConfounding` in the report is the Spearman correlation
between rung magnitude and run position; ascending scores 1.

`--rung-order=alternating` runs smallest, largest, next smallest, next largest,
which drops that to 0.26 for a six-rung ladder while staying deterministic, so
the ladder is still reproducible from its arguments. `given` uses the order
passed to `--rungs`.

This is not hypothetical. On the 20260813T054929Z ladder the 1ms rung, run
second, sits above both its 0ms and 5ms neighbors in **every arm** — including
baseline and static-cap, which never receive the coordinator flag at all. A
rung effect appearing in arms not under the manipulation is host state rather
than coordination cost, and ascending order gives no way to tell them apart
after the fact.

The adaptive ladder is useful as a **secondary realism run**, not as a
replacement for the historical 31/1 ladder. It puts MoFlux under the current
28/4 demand-aware policy used by the adaptive benchmark, which makes the result
easier to compare with current product evidence. It also introduces real
lending and handoff dynamics that are unrelated to coordinator distance and can
add variance, so the simpler historical ladder remains the cleaner isolation of
the coordinator-path effect.

The adaptive ladder spends its budget differently on purpose: **seeds are the
replicate, rungs are not.** The interval is taken over per-seed slopes, so its
width is governed by seed count; rungs buy within-seed precision the interval
cannot report. At the measured cost of roughly four minutes per seed per rung,
six rungs by five seeds and four rungs by eight seeds cost about the same two
hours.

The normal adaptive ladder does **not** require the full
`--require-adaptive-proof` gate. That gate asserts batch-floor restoration,
handoff commit, batch completions and other policy outcomes that are important
for the heterogeneous adaptive benchmark, but orthogonal to the ladder's coordinator-latency
question. Conditioning each rung on those outcomes can censor an otherwise
valid measurement and bias the fitted sample. Every rung still records its
`adaptiveProof` status and failures in `coordinator-ladder.json`. Use
`demo:coordinator:adaptive:strict` only when the intended experiment really is
"coordinator sensitivity among runs that also pass the complete adaptive
acceptance gate."
