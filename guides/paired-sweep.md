# The paired seed sweep

The canonical presenter now runs a **paired five-seed sweep**. For each seed it
runs a fresh no-control baseline and then the corresponding Tyr + Latchflo arm.
For each seed, the presenter generates one immutable request trace containing
every logical arrival, retry-jitter draw, target selection, and provider sample
key. It replays that exact trace through both arms. Admission decisions still
change which attempts reach the provider and when, but the offered logical
workload no longer changes between arms or reruns.

## Capacity policy and enrollment

All four Tyr replicas continue serving `sim-interactive`, while only replica 4
also registers for `sim-batch`. The canonical policy is now an exact
**31 interactive / 1 batch** concurrency split with 30,000 interactive tokens
and 10,000 batch tokens. This preserves one guaranteed batch admission while
keeping every provider slot usable: the interactive pool funds all 31 of its
slots and the batch pool funds its single 9,942-token reservation. Tyr enrollment uses a short lease first; after all
four agents are visible, the presenter promotes both pools to the long run lease
and waits for one simultaneously ready, correctly sized fleet-wide grant set.
For demand-aware runs, the same 28/4 capacity group is installed during this
bootstrap with lending temporarily disabled so pre-benchmark idle heartbeats
cannot release the protected floor. Once the measured load generator is running,
the presenter waits for a fresh interactive demand report and then arms the
configured demand policy. Each accepted grant must also have enough remaining
lifetime for a stable benchmark start. Startup fails if any live local grant is
too small or too close to expiration. Pool creation also sends Latchflo 0.20.1's durable
minimum-grant invariants: one concurrency slot, 755 tokens for interactive, and
9,942 tokens for batch. Latchflo therefore rejects an unusable split before it
can issue a zero-capacity or sub-request grant.

## Runtime, protocol and progressive reconciliation

The licensed path is pinned to **Tyr 0.35.0**, **Latchflo 0.20.1**,
**async-bulkhead-llm 3.18.0**, and **async-bulkhead-ts 1.0.1**. The canonical
comparison uses Anthropic-shaped streaming because that protocol exposes input
usage at `message_start` and cumulative output usage while the response is still
active. Tyr enables progressive reconciliation on every benchmark pool with a
256-token update step and a 256-token future-output safety margin. This lets the
benchmark measure capacity returned before completion rather than conflating it
with the ordinary final refund. An explicit OpenAI compatibility path remains
available, but OpenAI-shaped usage in this simulator arrives only at completion
and therefore cannot demonstrate early release.

See [runtime pins and comparison limits](runtime-pins.md) for what each
pinned release changes.

## Images

The single canonical command can use images that already exist, pull configured
registry images, or build missing images from local source directories. Place
`tyr-admission-controller` and `latchflo-control-plane` beside this repository,
or set `MOFLUX_TYR_SOURCE_DIR` and `MOFLUX_LATCHFLO_SOURCE_DIR` in the local
environment file.

On first use, the command creates an ignored `demo/moflux/.env` with random
local-only tokens and the pinned image tags. For each missing image it first
looks for a matching local source repository, builds the exact pinned tag when
one is available, and otherwise attempts a registry pull. Existing env files
are never overwritten. `npm run demo:doctor` remains available as a standalone
preflight, but it is not required before the canonical command.

## Capacity-aware routing

Tyr 0.35.0 capacity-aware routing is enabled for the licensed four-replica
MoFlux arm. Managed Tyr configs start with `peers: []`: each replica advertises
its routable endpoint when it registers, Latchflo 0.20.1 publishes a durable,
versioned `routingTopology`, and Tyr applies only newer topology revisions. Tyr
then polls private capacity snapshots for the currently active peers and may
forward a request once to the peer with better request-specific headroom. Tyr
also reports bounded per-pool demand snapshots on the existing authenticated
heartbeat. The benchmark generates one local-only shared routing secret in
`demo/moflux/.env`; the secret is never committed or distributed by Latchflo.
Latchflo remains off the synchronous request path.

## Running it

Run the canonical progressive comparison:

```bash
npm run demo
# Equivalent explicit protocol selection:
npm run demo:progressive
```

For the retained **simulated** OpenAI-shaped protocol path:

```bash
npm run demo:openai:sim
```

`npm run demo` is non-interactive: it runs seeds 1 through 5, resets
benchmark-local Latchflo/Tyr state before each pair, preserves every raw arm
result, and prints medians with min/max spread. The presenter rejects any pair
whose scenario fingerprints differ, whose load generator saturates, or whose
token allocation cannot fund every configured concurrency slot. Use
`npm run demo:record` for the step-through recording flow.

Rehearse the legacy one-pair flow with `npm run demo:single`, or choose seeds
explicitly:

```bash
node demo/seed-sweep.mjs --seeds=3,7,11 --step
```

## What a result records

Each MoFlux result separates final settlement from capacity returned while the
stream was active. It records total reserved, consumed, refunded, and overrun
tokens; progressive usage reports; applied and coalesced updates; tokens released
before completion; and `progressiveEarlyReleaseRate`, the early-release share of
all refunds. The Grafana dashboard charts both that share and reconciliation
activity. A refund is unused safety reservation returned for reuse, not newly
created capacity.

The aggregate is written to `results/runs/video-seed-sweep/<run-id>/summary.json`
and raw evidence alongside it, with `results/runs/video-seed-sweep/latest.json`
pointing at the newest run. That whole tree is generated and git-ignored.
Reviewed evidence in `results/video-seed-sweep.json` and
`results/video-seed-sweep/` is never written by a run — promoting a run to
reviewed evidence is a separate, deliberate step that refuses to replace an
existing copy without `--force`:

```bash
npm run evidence:list
node demo/publish-evidence.mjs --as=video-seed-sweep
```

## Concurrency and token splits

Concurrency slots and in-flight tokens are separate resources. The historical
policy uses `--batch-concurrency-slots=1` with `--batch-token-percent=25`.
`--batch-concurrency-percent` remains available for experiments, and the legacy
`--batch-floor-percent` still sets both dimensions, but exact slots cannot be
combined with either percentage-based concurrency flag.

```bash
MOFLUX_BENCH_RESULTS_DIR=results/interactive-first-31-1 \
  node demo/seed-sweep.mjs --seeds=1-5 --pause-ms=0 \
  --batch-concurrency-slots=1 --batch-token-percent=25
```

Use a separate results directory for every policy. Startup now rejects both
sub-request grants and nominal concurrency that the pool's token allocation
cannot actually fund. The old 24/8 policy therefore fails preflight with seven
stranded batch slots instead of silently reaching only 25/32 provider
concurrency.

## Enrollment lease

The enrollment lease defaults to 5 seconds for static runs and 2 seconds for
demand-aware runs, and can be changed for unusually slow local Docker startup
with `--enrollment-grant-ttl-ms`. It must remain shorter than `--grant-ttl-ms`;
no benchmark traffic begins during enrollment. Demand-aware lending is armed
only after fresh demand from the measured run is visible to Latchflo.

## Recording and cleanup

See [`demo/VIDEO-DEMO.md`](../demo/VIDEO-DEMO.md) for the recording flow and narration. Stop the
containers afterward with `npm run demo:down`.
