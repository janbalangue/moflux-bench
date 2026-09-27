# Grant restoration to backend availability (0.47.0)

This opt-in experiment asks how long it takes returning interactive work to
receive a KV allocation and a scheduler token budget after Tyr's grant is
restored, while the scheduler's KV pool is deliberately constrained. It measures
**request-specific scheduler availability**, not the release of particular batch
KV blocks, physical GPU memory reclamation, kernel execution, or restoration of
all three protected slots.

## Run

Requires the existing local vLLM Metal, Tyr and Latchflo prerequisites described
in [VLLM-CONTENTION.md](VLLM-CONTENTION.md). The first implementation supports
Metal on one host; it refuses NVIDIA because host/container clock and observer
wiring have not been validated.

```sh
npm run demo:vllm:metal:availability:dry-run
npm run verify:backend-availability
npm run demo:vllm:metal:availability:single  # seed 3: instrumentation pilot
npm run demo:vllm:metal:availability        # seeds 1–30: distribution pilot
```

Run measured commands from an ordinary terminal session. vLLM's engine
allocates POSIX shared memory at startup; a sandboxed shell that denies it
fails before the first arm with `PermissionError ... shm_open`, which is an
environment failure rather than an experiment result.

The sweep retains the four counterbalanced FCFS, priority, static and MoFlux
arms, fresh engines, immutable model revision, excluded warmup, and the `metal-long-context-v1` request sizes: long batch requests, 320 scheduler KV blocks
of 16 tokens, prefix caching disabled. Results have a separate
`-backend-availability-fixed-burst-v2` namespace under `results/runs/`. The two-slot reserve
can be tested with `--policy-profile=unlent-concurrency-2`, kept in its own
corpus, but it cannot pass the pressure gate with this workload: with two slots
never lent, MoFlux admits at most two long batch requests, about 64% of the
pool. This is an intervention on the scheduler pool, not host memory pressure.

The `fixed-burst-v2` availability protocol replaces pre-return random batch
arrivals with a priming request at 25 seconds (to establish batch demand),
then three requests at 48.0, 48.1 and 48.2 seconds and fixes the first
returning interactive arrival at 60 seconds. Later arrivals retain the seeded
trace. All arms replay the same trace and its recomputed hash. This creates a
repeatable pressure opportunity; it does not guarantee residency or relax the
90% gate. The protocol is reported in the plan and summary and uses a separate
results namespace from the original random-arrival pilot. Keep these corpora
separate. The workload's batch RPS describes the remaining random arrivals;
the saved trace is authoritative for the pre-return burst.

The burst lead comes from scheduler step timing in the random-arrival seed-3
pilot on an M1, not from latency outcomes: each 1,607-token prefill ran as one
~2.9s step with no pressure sample, and three-way decode steps took ~120ms.
Three staggered prefills therefore end about 8.5s after the burst, and the
requests stay resident for roughly another 7.5s. A 12-second lead puts the
return and its ~1s grant restoration inside decode on that host. `fixed-burst-v1`
(a 10-second lead, which left under a second before the pressure window) has
no completed run and is superseded.

Do the one-seed pilot first. A 30-seed, four-arm sweep is substantial local
inference work. A seed is not replaced just because it fails the pressure gate;
keep all attempted seeds and report the valid fraction. Extend the preregistered
seed range if more valid episodes are needed. Do not tune pressure thresholds
using observed latency outcomes.

## Measurement

1. Select the **first planned interactive request in the return window**, before
   observing success, rejection or latency. Use attempt 1; retries are forbidden
   for this analysis. Other requests cannot replace a failed selected request.
2. Tyr's grant transition is bracketed between the start of the last stats read
   showing a deficit and completion of the first restored read. This includes
   HTTP sampling uncertainty. No observed deficit means no measured restoration.
3. An opt-in Python import observer wraps the existing vLLM scheduler's
   `add_request` and `schedule` methods. It leaves scheduler selection and policy
   untouched. It records enqueue and the first step with positive scheduled
   tokens, after the scheduler has allocated the resources for that step.
   Preemption/resumption cannot create a second first-schedule event.
4. A deterministic request ID in the vLLM request body joins intent, the client
   attempt and the scheduler. Enqueue-to-schedule latency and dispatch timing
   expose admission/demand delay that would otherwise be mistaken for KV wait.
   First content-token arrival is retained even if the stream later fails.
5. Scheduler events (probe schema 2) and grant samples read the same host
   wall clock, so there is no cross-process mapping to drift. Each source also
   records wall time minus its own monotonic clock. Ordinary NTP frequency
   correction changes that reading by parts per million and scales every
   interval alike; a clock step appears as a jump between adjacent readings.
   A jump over 5ms from grant lower bound − 1s through the selected request's
   schedule or observation end makes the episode inconclusive. Schema 1
   mapped monotonic time to epoch at engine start and accumulated ~3.5ms per
   arm; its events are rejected rather than compared with wall time. Client
   attempts carry wall-clock stamps for dispatch and first-token diagnostics,
   which do not enter the gap. Gap bounds add a conservative 5ms timing
   allowance. Grants are sampled every 250ms in this mode (the Metal default
   is 1s) so the restoration bracket can order early service; the bracket
   width remains explicit. These are measurement bounds, not statistical
   confidence intervals.

`gapMs.lower = scheduled − grant.upper − 5ms`

`gapMs.upper = scheduled − grant.lower + 5ms`

Negative bounds are preserved. If the entire interval is negative, the selected
request was already served before restoration; it is classified as
`served_before_restoration` and excluded from post-restoration percentiles and
the 30-observation gate. A gap interval straddling zero is inconclusive because
sampling cannot establish event order. Neither case is zero-delay recovery.
`pendingInEngineAtRestoration` identifies whether the selected request was
already queued before the entire grant interval. Interpret later-enqueued
requests as end-to-end service availability, including admission/arrival delay,
not a pure backend resource wait. Scheduling proves capacity for this request
at one step; preemption can still occur subsequently.

## Validity and distribution

In addition to the existing experiment gates, each episode requires:

- Engine-reported pool size of 320 blocks × 16 tokens.
- At least three scheduler pressure samples in the interval from one second
  before the grant's lower bound through its upper bound; **every observed
  sample is at least 90% occupied**, observations begin before the grant lower
  bound, gaps between pressure samples are at most 500ms, and the last is at
  most 500ms old.
- A real grant transition, unsaturated load generator, installed schema-2
  observer, matched request attempt, ordered scheduler events, and no clock
  step over 5ms in the measured interval.

Pressure is sampled while the scheduler steps, so a stalled scheduler produces
stale evidence and an inconclusive episode. A peak elsewhere in an arm does not
qualify. Global KV usage establishes pressure, not which class owns the blocks.

The JSON summary contains per-arm raw episodes, p50/p90/p95/p99 interval bounds,
minimum/maximum bounds, and a full empirical CDF with lower/upper measurement
bounds. It retains counts and raw records for failed, right-censored and
inconclusive, served-before-restoration and not-applicable episodes. Percentiles/CDF are explicitly **conditional on observed
valid episodes**, never an all-request reliability estimate. Censoring is bounded
by the earlier of client observation end and last engine event. The opt-in experiment censors both idle stalls and hard drain limits; ordinary
benchmark drain behavior is unchanged. Started arms that abort before analysis
remain inconclusive entries in the distribution denominator. Completed
requests with missing scheduler evidence are inconclusive, not censored.

Thirty observed MoFlux gaps satisfy the distribution-pilot gate. `proof`
also reports valid episodes (observed, served before restoration, failed and
right-censored: every measurement gate passed) and the served-before count.
This is not a precise p99 characterization: 1,000 valid independent episodes provide only
about ten observations above p99. Report the count and nominal tail observations
next to every percentile. For publication, extend the fixed run plan, replicate
across runs, keep configurations separate, and estimate uncertainty at the
seed/run level rather than treating requests within a seed as independent.
The static arm generally has no restoration transition (`not_applicable`); its admission and
request outcomes are controls, not grant-gap observations. The original five
hypotheses and thresholds remain unchanged; they do not prove this new endpoint.

### Expected MoFlux outcome for the selected request

With the one-slot profile, the first returning request is admitted into the
never-lent interactive slot. Three resident batch requests hold 303–315 of 320
blocks, so an eight-block interactive prompt fits for most of their decode.
In the random-arrival pilot, where pressure had already ended, it was
scheduled 6ms after dispatch, before the ~1s restoration bracket opened. Expect `served_before_restoration`, or an
inconclusive overlap if restoration is unusually fast. That is valid evidence
that the reserve served returning work under pressure without waiting for
restoration, but it is not a post-restoration gap. Latchflo runs with no
admission queue (`maxQueuePerAgent: 0`) and retries are excluded, so demand
beyond the reserve is rejected at arrival rather than left pending at
restoration. A post-restoration latency distribution therefore needs a
preregistered design change, such as a reserve-exceeding request that may
wait at admission. Tuning the burst cannot produce one.

## Lending reopening diagnostic

Each managed arm also retains `evidence.<arm>.lendingReopenings`: reductions of
its interactive floor after the first restoration, with the transition bracket,
time since restoration, demand state, batch borrowed occupancy before/after,
and the latest KV-pressure observation (unknown if older than 500ms).
This tests whether reopening coincides with unsettled admission occupancy; it
does not identify the previous borrowed cohort or establish its KV residency.
The policy is unchanged. Comparing a recovery-aware reopening rule against
utilization and interactive tails is a subsequent intervention, not a conclusion
from this observational diagnostic.

## Evidence and limitations

The run retains scheduler JSONL files (including a hash of the observed scheduler
source), client attempt records, grant sampling intervals, engine metrics and
runtime/model identity. No prompt text, token IDs, credentials or request bodies
are journaled by the observer. File writes add overhead; compare instrumented
and uninstrumented pilots before making performance claims. An incompatible
scheduler or missing hook cannot produce a passing availability measurement.

Version 0.47.0 adds the instrumentation and analysis. Synthetic regressions and
dry-runs validate the harness, not real backend recovery. No new measured
latency distribution is bundled with this change.
