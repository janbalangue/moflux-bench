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

`--availability-protocol` selects the trace protocol: `fixed-burst-v3`, the
default, or `fixed-burst-v2` as a paired control. v2 has the same burst with a
class-size return request, and seed 3 replays the v2 pilot's recorded trace
hash. Run it on the same seeds as a v3 yield check, close in time, because
two identical `unlent-concurrency-2` sweeps differed by several requests on the
same seed:

```sh
node demo/vllm-contention.mjs --backend=metal --workload=metal-long-context-v1 \
  --backend-availability --availability-protocol=fixed-burst-v2 --seeds=1-5
```

A v2 return request fits beside the resident batch requests, so it is not a
gap measurement, and its distribution gate is not expected to pass. Its own
arrival triggers restoration, so most v2 episodes are `inconclusive` because
their schedule time falls inside the grant bracket; that label says the order
against restoration is unresolved, not that the request waited. Read v2 through
`engineQueueMs`, `dispatchToScheduleMs` and the count of seeds served without
waiting.

The sweep retains the four counterbalanced FCFS, priority, static and MoFlux
arms, fresh engines, immutable model revision, excluded warmup, and the `metal-long-context-v1` request sizes: long batch requests, 320 scheduler KV blocks
of 16 tokens, prefix caching disabled. Results have a separate
`-backend-availability-fixed-burst-v3` namespace under `results/runs/`. The two-slot reserve
can be tested with `--policy-profile=unlent-concurrency-2`, kept in its own
corpus, but it cannot pass the pressure gate with this workload: with two slots
never lent, MoFlux admits at most two long batch requests, about 64% of the
pool. Both five-seed `unlent-concurrency-2` sweeps peaked at 65–71% KV usage in
the MoFlux arm. This is an intervention on the scheduler pool, not host memory
pressure.

The `fixed-burst-v3` availability protocol replaces pre-return random batch
arrivals with a priming request at 25 seconds (to establish batch demand),
then three requests at 48.0, 48.1 and 48.2 seconds, and fixes the first
returning interactive arrival at 60 seconds with a 2,000-character prompt.
Later arrivals, including the other returning interactive requests, retain the
seeded trace and the 400-character class size. All arms replay the same trace and its recomputed hash. This creates a
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

The larger return prompt is what v3 adds, and it comes from the `fixed-burst-v2`
seed-3 pilot's request sizes and scheduler events, not its latency. That pilot
reached the pressure gate (nine samples at 96–97%), but its selected request
needed only 8 blocks, fit beside the three resident batch requests, and was
scheduled 0.28ms after enqueue. With no request waiting when the grant came
back, the episode was inconclusive (gap −234…+39ms), and every seed would
behave the same way. vLLM reported 118 prompt tokens for the 400-character
interactive prompt and 1,607 for the 7,100-character batch prompt: about 29
template tokens plus 0.222 per character. Three resident batch requests hold
101–105 blocks each, so at most 17 of the 320 blocks are free. A 2,000-character
prompt is about 474 tokens, or 30 blocks. The installed vLLM scheduler admits a
waiting request only when its full prompt fits (`scheduler_reserve_full_isl`)
and never preempts running work to place a waiting request, so the selected
request stays in the engine queue until a resident request finishes. The v2
pilot stays in its own namespace. v2 is no longer the default but remains
selectable as the paired control described under Run.

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
   `freeBlocksBeforeEnqueue` reports free KV blocks at the last scheduler
   pressure sample before enqueue, with its age and waiting-queue length. It is
   a diagnostic, not a gate.
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

This prediction for `fixed-burst-v3` was written before any v3 run. With the
one-slot profile the selected request is admitted into the never-lent
interactive slot, as in v2, and reaches the engine within about 100ms. Its 30
blocks do not fit beside three resident batch requests, so it waits in the
engine queue until one of them finishes. On the pilot host's step timing that
is roughly 3–4 seconds after the grant bracket, which v2 placed at 60.0–60.3s.
Expect `observed` episodes with positive gaps of that order, `engineQueueMs`
close to the gap, and `freeBlocksBeforeEnqueue` below 30. The request's own
arrival signals returning demand, so it reaches the engine close to the grant
bracket, and `pendingInEngineAtRestoration` can go either way.

The gap is the time from grant restoration until the backend had KV capacity
for this request. It is mostly the remaining decode of the resident batch
requests, which the burst timing sets, so it is a measurement under this
protocol rather than a general recovery time. It does not identify which
request released blocks, and it is not physical memory reclamation.

Outcomes that contradict the prediction are reported, not tuned away.
`served_before_restoration` or an inconclusive overlap means the request fit or
restoration came late. An increase in the arm's vLLM preemption counter with an
engine wait near zero means the scheduler preempted batch work rather than
leaving the request waiting.

Latchflo still runs with no admission queue (`maxQueuePerAgent: 0`) and retries
are excluded, so later returning requests beyond the reserve are rejected at
arrival. v3 measures waiting in the engine, not at admission. The static arm
runs one batch request at a time, so the selected request fits there and static
remains `not_applicable`. The direct vLLM arms also leave it waiting on KV, but
they have no grant transition; their records are controls.

Seeds 1–30 pass the distribution gate only if every seed yields an observed
episode. After the one-seed pilot, check the yield on three to five seeds and
extend the preregistered seed range if it is below 100%.

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
