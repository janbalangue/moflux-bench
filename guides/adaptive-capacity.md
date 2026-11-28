# Retry hints and adaptive capacity profiles

[The lending benchmark](lending.md) covers the proof these profiles are
held to.

MoFlux is the only local-admission arm that returns `Retry-After` /
`x-admission-retry-after-ms`, so its measured TTFT includes waiting the static
cap and Redis arms never do. `--honor-retry-hints=false` forces blind
exponential backoff for every arm; the trace is identical either way, so the
pair of runs isolates the hint's contribution:

```bash
npm run demo:hetero                 # historical 31/1 policy; hints honored
npm run demo:hetero:blind           # historical 31/1 policy; blind backoff
npm run demo:hetero:adaptive        # headroom-aware 28/4 current adaptive policy
npm run demo:hetero:headroom        # headroom-aware 28/4 policy
npm run demo:headroom:compare       # paired old-vs-headroom policy experiment
npm run demo:headroom:compare:lend1 # same experiment with a one-slot headroom lend
npm run demo:hetero:adaptive:blind  # same adaptive traces, blind backoff
```

## Adaptive profiles

The adaptive commands combine heterogeneous request sizes and progressive token
reconciliation with a fixed 32-slot / 64,000-token envelope. `adaptive-28-4` is
the control policy: interactive and batch keep 28/4 concurrency entitlements and
24,000/40,000-token entitlements, and a demanding member retains its full
entitlement. `adaptive-headroom-28-4` keeps those same nominal entitlements but
uses Latchflo 0.20.1's demand-safe, non-stranding sustained headroom lending (introduced in 0.12.4) on
`sim-interactive`. Protected/no-current-demand telemetry may expose headroom as
before. A demanding interactive member may additionally lend only after safe
slack persists for 3,000 ms, and that active-demand release is hard-capped at
2 concurrency slots and 10,000 tokens. Under the current Latchflo 0.20.1 runtime, long-lived
pressure-free demand remains `demanding`; `starved` requires aged demand plus
pending or recent rejection pressure. Rejection pressure, starvation, stale or
incomplete telemetry, pending work, or loss of the sustained-safety condition
makes the active-demand slice ineligible immediately. Capacity released as
interactive headroom remains source-aware: another eligible demanding member
may consume it, but if nobody does, it stays usable by interactive instead of
becoming stranded. Batch itself has no headroom-lending configuration and
retains its protected 4-slot / 40,000-token entitlement.

## Bounded local waiter

The bounded local waiter behavior introduced in MoFlux Bench 0.27.0 remains enabled on every
`sim-interactive` Tyr replica. Latchflo grants `maxQueuePerAgent: 1` only to
`sim-interactive`; `sim-batch` remains `maxQueuePerAgent: 0`. Each interactive
replica pins `queueTimeoutMs: 750`, so the queue converts only short concurrency
transients into waiting rather than becoming a second backlog. Tyr continues to
report live `pending` demand on its authenticated Latchflo heartbeat. Sustained
pressure therefore makes interactive headroom ineligible under Latchflo 0.20.1,
while a single short wait can complete locally without taking capacity away from
the four-slot batch floor. If that bounded wait expires, Tyr returns an
attributable admission rejection as HTTP 504 with `x-admission-reason: timeout`;
the load generator records it as `localReject` (including its snapshot and retry
hint), while an unmarked 504 remains a harness/server fault.

## The adaptive proof gate

Both profiles enable `--require-adaptive-proof`. The command exits unsuccessfully
if any seed falls below 90% interactive success, completes fewer than four batch
requests, lacks the required Latchflo lending/restoration evidence, cannot prove
the first handoff-lineage batch admission at or after `handoff_prepared` used the committed successor grant, fails to
restore the batch floor, double-allocates applied capacity, or produces an
upstream 429. The headroom profile additionally requires at least one seed to
prove an interactive-to-batch lending event at both Latchflo and Tyr's applied
capacity. Because request sizes are
stochastic, ordinary adaptive sweeps require idle-window occupancy above the static
28-slot floor somewhere in the five-seed sweep rather than on every seed.
`demo:headroom:compare` is the deliberate exception: its controlled low-pressure
trace is designed to prove active-demand headroom, so idle occupancy above 28 is
reported only as a diagnostic there. The paired comparison still requires the
normal per-seed safety proof plus its stricter in-window `demandState=demanding`
controller event and correlated bounded Tyr transfer. The complete failed run is
retained under `results/runs/` for inspection.

For both adaptive profiles, the presenter installs a bootstrap-safe capacity group while the Tyr fleet enrolls. Demand-aware lending stays disabled until fresh measured traffic is observed; for the headroom profile, the bootstrap copy also omits member-level `headroomLending` because Latchflo requires headroom lending and an enabled demand policy to be configured together. The full unchanged headroom policy is installed when measured demand arms lending.

## One-slot headroom lend

`demo:headroom:compare:lend1` runs the same comparison against
`adaptive-headroom-28-4-lend1`, which is identical except that a demanding-state
loan releases at most one interactive slot instead of two. It does not reduce the
interactive cost. Under either cap the lent tokens fund one extra batch
reservation (`effectiveFundedDemandingLend: 1`), so both profiles add about one
batch stream to the shared simulated provider. At this load that one stream costs
interactive roughly 10-15% p95. The published comparison,
`results/curated/headroom-policy-comparison-v0.44.0-20260924T225251Z-lend1.json`,
fails both the p95 limit (+11.5%) and the batch check; [`results/curated/README.md`](../results/curated/README.md)
explains the result. Each profile name fixes all of its values, so saved results
under `adaptive-headroom-28-4` keep meaning the two-slot policy.

## The paired headroom comparison

`demo:headroom:compare` is the direct policy outcome experiment. It runs MoFlux-only
five-seed sweeps for both profiles, verifies that every same-seed trace hash is
identical, and writes a paired summary of absolute and delta batch success versus
interactive success, p95 latency, TTFT p95, local rejects, and upstream 429s. This
paired command deliberately uses a controlled 3 interactive RPS, uniform-size trace
while batch still begins at 60% of the 45-second phase. That keeps interactive demand
continuously active but leaves deterministic room below the protected 28-slot /
24,000-token entitlement for longer than the 3,000 ms demanding-state sustain window.
The canonical `demo:hetero:adaptive` command now selects that same headroom-aware
profile on the ordinary 6-RPS lognormal workload; `demo:hetero:headroom` remains a
compatibility alias. Both retain the idle-occupancy-above-28 proof requirement.
Only the paired headroom exercise marks that older occupancy proof diagnostic, because
its relevant lending evidence is the stricter in-window demanding-headroom correlation.
The paired experiment then answers one explicit question:
after the protected 4-slot batch floor is restored, does headroom-aware lending turn
that bounded active-demand slack into more completed batch work without giving back
interactive protection?

A child sweep that completes all seeds and preserves `summary.json` is still a usable
policy result even when `--require-adaptive-proof` makes that child exit nonzero. The
paired runner now continues in that case so the final comparison records *why* the
policy failed. A crash, signal termination, or missing/unreadable summary still stops
the comparison immediately.

### The outcome gate

The default release gate now sizes the batch-payoff requirement from the headroom
that the configured policy can actually fund. It computes the demanding-state
increment as `min(maxDemandingConcurrentLend,
floor(maxDemandingTokenLend / batchRequiredLocalGrant))` and evaluates the batch
completion gain only on seeds with joint controller plus correlated Tyr
headroom-transfer evidence. For the default 2-slot / 10,000-token lend and the
current batch reservation, that funds one additional batch reservation, so the
default exercised-seed gate requires a median gain of at least one completion
and a median headroom completion count at least one above the exercised control
median. The safety gates are unchanged: joint headroom proof is still required
on at least 60% of seeds; exact successor-grant admission proof is required on
every seed; upstream 429s must remain zero; median interactive-success regression
must be no worse than 2 percentage points; and median interactive-p95 regression
must be no worse than 10%. Explicit overrides remain available with
`--min-median-batch-successes`, `--min-median-batch-success-delta`,
`--min-headroom-evidence-seed-fraction`,
`--max-interactive-success-regression-pp`, and
`--max-interactive-p95-regression-percent`. A raw 26/6 Tyr split is diagnostic
only. Joint headroom proof requires the controller event to occur during the measured
workload, report `demandState=demanding` and `reason=headroom`, stay within the
configured active-demand slot/token caps, and be followed by a matching Tyr applied-
capacity transfer that is also observed before the measured workload ends. Protected
or post-workload lending remains visible as diagnostic evidence but cannot satisfy the
headroom gate. If either underlying adaptive gate or
the outcome gate fails, the comparison is preserved but the command exits
unsuccessfully rather than presenting it as a passing result. The named adaptive
capacity profiles are valid in MoFlux-only mode because this paired experiment
runs each policy as its own MoFlux sweep. The legacy `--lending` flag remains
compare-only because its idle-window presentation is defined against a control
arm.
