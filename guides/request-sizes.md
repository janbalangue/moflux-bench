# Request size heterogeneity

Until version 0.10.0 every request in a class was the same size: 1,200 chars
and 400 max tokens for interactive, on every request and every seed. That makes
the benchmark unable to measure its own subject.

With a single fixed size per class, **token-aware admission and a plain
concurrency semaphore are the same algorithm**. N slots times one constant is a
fixed token ceiling, so there is no admission decision token accounting can
make that a counter cannot. Measured on the committed policy, the interactive
pool had 31 concurrency slots against 36 token-funded ones — the token budget
never decided a single admission, on any seed. Any advantage claimed for token
awareness was unattributable, and a static per-replica cap was expected to
match it.

Real traffic in one class spans one to two orders of magnitude, because context
length, retrieved documents, and conversation history vary per call.

```bash
npm run demo:hetero             # lognormal sizes with historical 31/1 policy
npm run demo:hetero:adaptive    # lognormal sizes with headroom-aware adaptive 28/4 policy
```

Use the historical command to reproduce the reviewed 31/1 corpus. Use the
adaptive command for the current product claim: interactive can borrow idle
batch capacity, and the four-slot batch floor must return when demand arrives.

`--size-distribution=lognormal` draws an input size and a max-token count per
request. `--interactive-size-sigma` (default 0.75) and `--batch-size-sigma`
(default 0) control the spread. Sizes are clamped to a bounded multiple of the
class median, because an unclamped tail produces requests whose reservation
exceeds any single grant — reproducing the stranded-capacity failure through
the workload rather than the configuration.

## Version 1 results are preserved

`--size-distribution` defaults to `uniform`, which reproduces the version-1
trace **bit for bit**. Seed 3 still hashes to
`14745a767634923c7d42d626df4d541b98ff66372c5d84ebe1f33b33ebe9c02b`, asserted on
every verify run. Sizes are drawn from a separate seeded stream, so arrival
times and retry jitter are identical between a v1 trace and its v2 counterpart;
only the sizes are new.

A version-1 trace cannot replay under a heterogeneous configuration, or the
reverse. Mixing them would offer different work to the two arms of a pair while
both reported a matching scenario.

## Reading the result

Every class summary now carries `bindingConstraint`:

```json
"bindingConstraint": {
  "budgetLimited": 0,
  "concurrencyLimited": 13,
  "tokenBoundShare": 0,
  "exercisedTokenAwareness": false
}
```

`exercisedTokenAwareness: false` means the token budget refused nothing, so
nothing in that run is attributable to token-aware admission — whatever the
configuration claims. Check it before reading any comparison between MoFlux and
a concurrency-limited arm. A run where it is false is measuring two
concurrency limiters.

`requestSizes` reports the realized min, p50, p95, max, and spread of the
replayed trace, so a claimed distribution can be checked against what actually
ran.

Both are aggregated across seeds. `aggregate.arms.<arm>` carries
`budgetLimitedRejects`, `concurrencyLimitedRejects`, `tokenBoundShare`, and the
realized sizes; a top-level `tokenAwareness` block reports how many seeds each
arm's token budget refused work on, distinguishing "one seed exercised it" from
"every seed did". The sweep prints this above the head-to-head table and names
any arm whose budget refused nothing.
