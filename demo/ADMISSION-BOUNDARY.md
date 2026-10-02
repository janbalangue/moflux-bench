# Looser admission boundary (preregistration)

Preregistered on 2026-09-27, before any run. The implementation was added the
same day, also before any run. Amendments are appended below with a date, and
none may be based on goodput or latency outcomes.

The idea is Yash Karecha's (inference-x): admit enough work that vLLM's own
scheduler takes part in the contention.

## Question

> When admission lets in twice as many requests as vLLM can run, so that
> vLLM's priority queue orders the waiting work, does grant restoration still
> give returning interactive work anything that native priority scheduling
> does not?

## Why

In every published long-context run, admission in front of vLLM kept vLLM's
queue empty or nearly so. Both managed arms admit at most four requests, which
is vLLM's `max_num_seqs`. Across the four published five-seed runs (20
seed-runs), the static arm's sampled `vllm:num_requests_waiting` never rose
above zero, and its KV usage peaked at 38–40%. The MoFlux arm's queue never
exceeded one. Native priority's queue peaked at 3–13. vLLM's priority
scheduler therefore reordered waiting work only in the direct arm. In the
managed arms, admission decided what ran.

Admission is also where the one-slot MoFlux arm loses returning work. Native
priority has no admission layer and rejects nothing. MoFlux has no admission
queue, so a returning interactive request that finds no free slot is rejected
on arrival. Across five seeds, it rejected 24 returning interactive requests
in one published one-slot run and 28 in the other. In the failed repeat,
MoFlux met the SLO for 35 returning requests against native priority's 54, and
H2's median was −0.20 req/s.

Sources: [one-slot pass](../results/curated/vllm-metal-long-context/20260925T001105Z.json),
[one-slot failed repeat](../results/curated/vllm-metal-long-context/20260925T164229Z.json),
and the two `unlent-concurrency-2` runs
([0.46.0](../results/vllm-metal-long-context-unlent-concurrency-2.json),
[0.47.1](../results/vllm-metal-long-context-unlent-concurrency-2-v0.47.1.json)).

## Design

### Manipulation

A new policy profile, `admission-8-unlent-2`, doubles every admission quantity
and leaves the engine unchanged:

| | `unlent-concurrency-1` (published, boundary 4) | `admission-8-unlent-2` (boundary 8) |
| --- | --- | --- |
| vLLM `max_num_seqs` | 4 | 4 |
| Admission concurrency | 4 | 8 |
| Class ceilings | 4 | 8 |
| Static floors, interactive/batch | 3/1 | 6/2 |
| MoFlux interactive slots never lent | 1 | 2 |
| MoFlux interactive slots lendable | 2 | 4 |
| Most batch requests admitted, static/MoFlux | 1/3 | 2/6 |
| Admission queue | none | none |

The ratio of admission concurrency to engine concurrency changes from 1 to 2.
Everything else in the admission policy keeps its proportions: 3:1 class
shares, a third of the interactive floor never lent, and a batch ceiling of
75% of admission under lending. The 65,536-token pool, the protected token
floors and the unlent token slices are unchanged. The existing
`concurrencyAdmissionExercised` gate still invalidates any seed with a
token-budget rejection.

The profile runs only with `metal-long-context-v1`. It writes its own corpus,
`results/runs/vllm-metal-long-context-admission-8-unlent-2/`, which is never
pooled with boundary-4 results.

### Held fixed

- The `metal-long-context-v1` workload and its per-seed random-arrival traces.
  No availability protocol is used.
- The engine: `max_num_seqs=4`, 320 KV blocks of 16 tokens, `max-model-len`
  4,096, prefix caching off, memory setting 0.4, the model revision, and a
  fresh engine for every arm.
- The four arms and their vLLM policies, with interactive priority 0 and batch
  priority 10.
- Rotated arm order, excluded warm-up, one attempt per request, and no
  admission queue.
- The SLO (TTFT at most 5s, end-to-end at most 30s), lease timing, and the
  H1–H5 thresholds.
- Tyr, Latchflo, vLLM and vllm-metal at the versions pinned by the release that
  ships the profile. Both sweeps must record identical versions.

The FCFS and priority arms bypass admission, so the profile does not change
them. They serve as the reference within a sweep and as a drift yardstick
between sweeps.

### Runs

1. **Pilot:** boundary 8, seed 3. It checks instrumentation and the
   manipulation only; see [Validity](#validity).
2. **Paired sweeps on seeds 1–5,** run back to back on the same host, with no
   OS or runtime update between them. Boundary 8 runs first. The published
   `unlent-concurrency-1` profile follows as the boundary-4 baseline. The
   baseline is rerun rather than taken from the corpus: between the two
   identical published one-slot runs, native priority's five-seed total moved
   from 38 to 54 requests.

Run measured commands from an ordinary terminal, as for the other vLLM Metal
experiments:

```sh
npm run demo:vllm:metal:long-context:admission8:dry-run
npm run demo:vllm:metal:long-context:admission8:single  # pilot, seed 3
npm run demo:vllm:metal:long-context:admission8         # boundary 8, seeds 1–5
npm run demo:vllm:metal:long-context                    # boundary 4, seeds 1–5
```

The profile is refused with any other workload and with
`--backend-availability`. Its results go to
`results/runs/vllm-metal-long-context-admission-8-unlent-2/`.

## Outcomes

The unit is the seed. Arms are paired within a sweep, and the two sweeps are
paired by seed. `S(arm)` is the number of interactive requests that met the
SLO in the 25-second contention window, which is the summary's
`classes.interactive.windows.contention.sloGoodputRps` × 25. One request is
0.04 req/s.

### Primary 1: MoFlux against native priority at boundary 8

`D = S(moflux) − S(vllm-priority)` for each seed of the boundary-8 sweep. This
is H2's statistic in requests; H2 passes when the median is at least −1.

| Median of D over seeds 1–5 | Reading |
| --- | --- |
| +2 or more | MoFlux protects returning interactive work beyond native priority, even when vLLM's queue orders waiting work. |
| −1 to +1 | No measurable difference. At this boundary, grant restoration adds nothing measurable to returning interactive SLO goodput. |
| −2 or less | MoFlux does worse than native priority, and H2 fails. |

The mean and five-seed sum are reported beside the median. Between the two
published one-slot runs, the median of the same paired difference moved from
0 to −5 requests.

### Primary 2: change from boundary 4

`DD = D(boundary 8) − D(boundary 4)` for each seed, using the paired baseline
sweep. Subtracting each sweep's own priority arm removes drift that moves all
arms together, but not drift that affects arms differently. A median of +2 or
more means loosening the boundary moved MoFlux toward or past native priority.
A median of −2 or less means it moved MoFlux away. Anything between is no
measurable change. The same statistic is reported for the static arm.

### Where the misses are

This part is descriptive. For every arm, boundary and seed, each interactive
request arriving in the return window (60–85s of the trace) is classified from
the saved trace (`trace-seed-<n>.json`) and the arm's client records
(`<arm>-seed-<n>.json`: completed requests with their TTFT and latency, and
admission rejection snapshots):

- met the SLO;
- completed but missed it (TTFT over 5s or end-to-end over 30s);
- rejected at admission;
- not served for another reason, such as an engine or transport error or drain
  censoring.

The met-SLO count uses the same arrival window and SLO as `S`, so it equals
`S`. The analysis refuses to report if the two disagree. At boundary 4,
MoFlux's misses are mostly admission rejections. Loosening the boundary should
admit some of those requests, and the question is whether they then meet the
SLO.

### Secondary

- TTFT p50 and p95 of successful contention-window interactive requests for
  each arm, always read beside rejections.
- MoFlux against static at boundary 8: the difference in `S`, and H3's batch
  borrow-arrival cohort goodput with its 0.02 req/s threshold unchanged.
- The H1–H5 proof for both sweeps, reported as is. A proof `pass` or `fail`
  does not answer this question on its own.
- vLLM preemptions, and peak queue and KV usage by arm and phase.
- Grant-floor and admission-occupancy restoration latencies from H5's recovery
  records.
- Covariates for each arm: ITL mean (`vllm.histograms.itl`) and page-ins
  (`hostPressure.pagesDuringArm.pageins`).
- Drift yardstick: per-seed differences in the direct arms' `S` between the
  two sweeps.

No statistical significance is claimed. Five-seed medians are descriptive.

All of the above is computed by one command, which reads the two sweeps'
summaries and raw client files and writes a new file. It refuses to overwrite
an existing file or write into reviewed evidence:

```sh
npm run demo:vllm:metal:long-context:admission8:analyze -- \
  <boundary-8 run>/summary.json <boundary-4 run>/summary.json <new-file>.json
```

## Validity

All existing gates apply unchanged. They include `kvPoolPinned`,
`kvPressureExercised` (peak KV usage of at least 0.9 in a direct arm),
`concurrencyAdmissionExercised`, `managedGrantContinuity`,
`hostMemoryHeadroom`, and the engine and transport error gate. With two
never-lent slots, `nativeUnlentFloor` and `allocatorUnlentReserve` require two,
as they do for `unlent-concurrency-2`. Seeds are not replaced. A seed that
fails a gate stays in the denominator as inconclusive.

**Manipulation check.** The question is answered only if the MoFlux arm at
boundary 8 reaches a sampled vLLM queue of at least two during the contention
phase (`vllm.phases.contention.waiting.max` ≥ 2) in at least three of five
seeds. The summary reports it as `admissionBoundary`, and the runner prints it
at the end. A queue of two needs more admitted requests than vLLM can hold, which
boundary 4 rarely allows: the published MoFlux arm's queue never exceeded one
in 20 seed-runs. If the check fails, vLLM's scheduler did not take part and the
result is inconclusive for this question. The H1–H5 proof is still reported.
The static arm's queue is reported but not gated.

**Pilot.** The seed-3 pilot passes if every validity gate passes and the MoFlux
arm's contention-phase queue reaches two. Its goodput and latency are not used
to change the design. If it fails, the design is revised from traces, engine
gauges and admission records, and a dated amendment is added here before any
sweep.

## Expected mechanism

This section was written before any implementation or run. It predicts the
mechanism, not the sign of Primary 1 or Primary 2.

- **Borrow phase.** MoFlux admits up to six batch requests. KV holds three
  (315 of 320 blocks), so the rest wait in vLLM's queue. Seeds 1–5 each place
  3–6 batch arrivals in the 20s before demand returns, so most seeds should
  have a batch backlog at the return. Static admits two batch requests, about
  210 blocks, and should not queue batch work. Its KV usage should peak near
  70%.
- **Return.** The grant is restored, but admitted batch requests keep their
  admission slots until they finish, so returning interactive work starts with
  the two never-lent slots. vLLM orders waiting requests by priority, so an
  admitted interactive request goes ahead of every waiting batch request. It
  still cannot run until a running request finishes or its prompt fits in the
  free blocks, because the installed scheduler never preempts running work to
  place a waiting request. An interactive request that fits beside three
  resident batch requests leaves little room for decode. When a running
  request then runs out of blocks, vLLM preempts the lowest-priority running
  request, a batch request, which must recompute its prompt.
- **Settling.** After the resident requests finish, a queued batch request
  starts whenever no interactive request is waiting. It then holds about 105
  blocks for roughly 20s. Restoration stops new batch admissions, not batch
  work already admitted, so KV pressure should last longer after demand
  returns than at boundary 4.

Expected observables for MoFlux at boundary 8, compared with boundary 4:

- more vLLM preemptions (the published one-slot arm had 0–1 per seed);
- longer admission-occupancy restoration;
- higher batch borrow-arrival cohort goodput.

Static should reject fewer interactive requests, with six interactive slots
instead of three. For MoFlux, the direction depends on how long admitted
interactive requests wait inside the engine.

Two effects pull Primary 1 and Primary 2 in opposite directions. Returning work
gets more admission slots and priority in vLLM's queue. The admitted batch
backlog keeps the KV pool full for longer. Which effect dominates is what the
experiment measures.

## What this cannot show

- **Restoration in isolation.** No arm lends without restoring, so the
  MoFlux–priority difference combines restoration, the admission cap and the
  partition.
- **Which of two changes matters.** Relative to boundary 4, two things change
  at once: vLLM receives more work than it can run, and returning interactive
  work gets two never-lent slots instead of one. The within-sweep comparison
  does not depend on this, but the difference in differences cannot separate
  the two. A boundary-8 profile with one never-lent slot could, and it is not
  preregistered here.
- **Which class waited.** vLLM's queue gauge and queue-time histogram are
  engine-wide. Request-level scheduler timing exists only in the observer of
  the [availability experiment](BACKEND-AVAILABILITY.md), which this experiment
  does not enable.
- **Generality.** The results cover one M1 host, one model revision, one
  workload and five seeds. MoFlux controls admission; vLLM controls
  scheduling, KV allocation and preemption. The
  [interpretation boundary](VLLM-CONTENTION.md#interpretation-boundary) of the
  contention experiment applies.

## Implementation

- `admission-8-unlent-2` is registered in `VLLM_POLICY_PROFILES`
  ([vllm-contention-lib.mjs](vllm-contention-lib.mjs)) for
  `metal-long-context-v1` only. Its `admissionScale` of 2 multiplies the
  published admission concurrency, floors and class ceilings. The engine
  arguments, token budget and floors, unlent token slices and lease timing come
  from the published policy unchanged.
- Arm descriptions and gate wording name the policy's own partition, so the
  published profile's text is unchanged.
- The plan prints the admission concurrency and floors. The summary's
  `admissionBoundary` field reports the manipulation check for each seed,
  including the static arm's queue.
- `results/vllm-metal-long-context-admission-8-unlent-2` is protected as
  reviewed evidence before any run.
- [admission-boundary-analysis.mjs](admission-boundary-analysis.mjs) computes
  Primary 1, Primary 2, the miss classification, the secondary measures and the
  drift yardstick. It requires identical traces for every paired seed and arm.

### Analysis validation

The analyzer requires identical planned seed sets and exactly one result row
per planned seed in each sweep. Incomplete sweeps are refused as inconclusive;
surviving pairs are never substituted for the planned sample. The five-seed
interpretations require seeds 1–5, valid sweeps, a passed manipulation check,
and matching recorded runtime controls. Otherwise descriptive counts and
statistics remain available, but readings are marked `inconclusive` with reasons.
A failed H1–H5 hypothesis does not itself invalidate those readings.

Runtime controls include the benchmark and service versions, model revision,
backend, macOS version, chip, architecture, system memory and pinned engine
configuration. Missing controls are unverified, even when missing from both
summaries. Matching recorded controls cannot establish a physical host identity
that the run did not record.
