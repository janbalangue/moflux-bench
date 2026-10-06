# Protected burst recovery experiment

Preregistered 2026-10-02. Revised 2026-10-03 for MoFlux Bench 0.51.0.
Amended 2026-10-04 with `burst-recovery-v4`, the current protocol, released in
MoFlux Bench 0.52.0;
`burst-recovery-v1`, `burst-recovery-v2` and `burst-recovery-v3` are retained
for historical raw-file reanalysis. This is an instrumentation
pilot followed by a paired workload experiment on current MoFlux. No second
admission policy or competitor is introduced. Historical workloads and results
remain separate.

The motivating idea is Yash Karecha's (inference-x): reopening lending should
consider whether earlier borrowed occupancy has settled, not only whether
interactive demand has gone idle. No reopening rule is tested here.

## Question and treatment

When two protected requests return together while batch holds two borrowed
slots, does current MoFlux stop new borrowing, and how does remaining borrower
work affect protected service recovery?

Use the pinned Metal long-context engine and `unlent-concurrency-1`: four slots,
interactive/batch nominal floors 3/1, one never-lent interactive slot. Keep model,
revision, prompts, engine limits, warm-up, controller settings, seeds and arrival
schedule matched. Keep the first, batch-owned setup request at 64 tokens.
Change only setup requests 2 and 3: 64 tokens (`short`) versus 192 (`long`),
with forced output length. Exact admission records must confirm these two
requests borrowed concurrency and request 1 used its own slot. These labels
are assigned treatments; actual remaining work is measured, never assumed.

The 155s trace has ordinary seeded interactive traffic from 0–25s, one 400-character, forced-one-token batch
prime at 41s, three setup batch requests at 42, 44 and 46s, then two identical
400-character/16-token interactive requests at exactly 60s. From 61–150s send
one interactive request per second and from 62–150s one batch request every two
seconds, with seeded jitter bounded to ±100ms. Post-return batch requests stay
at 64 tokens in both variants. One attempt per request; no hidden retries or
queue added. A rejection in the first burst is an outcome, not a validity failure.

## Revision from the first pilot

The retained v1 seed-3 pilot `20261003T061135Z` failed both variants: all three
setup admissions borrowed concurrency because batch's applied protected floor
was zero at admission, and no scheduler pressure snapshot qualified within
500ms before return. It has zero valid matched pairs and establishes no lifetime
effect. Its original files and protocol identity remain unchanged.

V2 replaces the early long-context prime with a short prime immediately before
setup, and staggers setup earlier to allow prefill before the fixed 60s return.
The short prime must finish before setup request 1 is sent. A Tyr sample within
500ms before request 1's admission must show no active batch request and a
restored batch protected floor of one; request 1's exact admission grant must
also show that floor. Exact ownership and pre-return scheduler overlap gates
remain mandatory. These schedule and priming changes are identical in both
variants and are chosen from setup failures, without optimizing goodput.
The new pilot must validate them before collecting a v2 sweep. A missed setup
condition makes a trial invalid; arrivals do not wait, retry or move in response
to telemetry. V1 and v2 trials cannot be combined into matched pairs.

## V2 instrumentation pilot outcome

The retained seed-3 pilot `20261003T063429Z` ran on 2026-10-02 Pacific time.
The short trial passed all 18 validity gates. The long trial passed every gate
except `clockStable`: managed telemetry's clock-error range was 5.815ms,
above the 5ms limit. Its range through the offered-demand horizon was 3.794ms;
later retained samples caused the failure. The gate still covers the complete
capture, including those later samples. The pair has zero valid matches and
establishes no paired lifetime or goodput effect. Original artifacts are retained
locally under `results/runs/`; this record does not promote them to published evidence.

Descriptively, both trials recorded zero fresh borrowed admissions after return.
Borrowers' median remaining stream lifetimes were 19.092s (short) and 49.679s
(long). Short sustained zero borrowed occupancy by 18.577s; long did not reach it
within the 40s return window. Interactive SLO counts were 11/41 and 10/41.
The long observations remain invalid for the paired analysis; sampled admission
occupancy does not establish physical engine reclamation.

Repeat the instrumentation pilot before the five-pair sweep. Clock diagnostics
now report each source's sample count, non-finite count, error minimum/maximum,
range and threshold, and identify failing sources. Managed and backend streams
retain the existing 5ms range rule; the load generator retains its 5ms absolute
backend-clock-error rule. No threshold, capture scope, workload or protocol
identity was changed in response to this pilot.

## Successful v2 pilot and v3 amendment

The repeat v2 seed-3 pilot `20261003T070225Z` passed all 18 validity gates
in both variants, with stable runtime and matched normalized traces. Borrowers'
median remaining stream lifetimes were 13.790s (short) and 43.680s (long),
a 29.890s separation. Neither variant recorded fresh borrowed batch admissions
after return. Short sustained zero borrowed occupancy by 13.891s; long remained
right-censored at the 40s observation horizon. Both completed 14/41 interactive
requests and rejected 27/41; SLO successes were 12/41 and 14/41. This one-pair
pilot supports no general claim that longer borrowers degrade SLO goodput.
It remains local pilot evidence; no result is promoted by this amendment.

V3 extends sustained arrivals and the observation horizon identically in both
variants from 40s to 90s after return, with a 155s trace. This provides time to
observe the roughly 44s long-borrower lifetime seen in the pilot while keeping
interactive and batch demand active. Longer runs can still be right-censored;
no favorable outcome is required. Setup, return time, output caps, arrival rates,
clock thresholds and SLO thresholds are unchanged. The SLO-goodput denominator
is now 90s, so v2 and v3 aggregate rates must not be pooled. Preserve original
v1/v2 artifacts and dispatch their reanalysis to their original horizons.

Report protected-limit restoration brackets, sustained borrower-drain brackets,
and interactive SLO outcomes separately. Neither restoration nor zero admission
occupancy proves physical engine reclamation or a return to a service baseline.
No service-recovery timestamp is defined by this protocol.

Run a v3 instrumentation pilot before its default alternating five-pair sweep.
V1, v2 and v3 trials cannot be combined into matched pairs. Non-pilot invocations
with fewer than five seeds are rejected before creating output or starting engines.

## V3 instrumentation pilot outcome and reporting amendment

The retained v3 seed-3 pilot `20261003T073341Z` ran on 2026-10-03
Pacific time, short first and long second. Both trials passed 17 of 18
validity gates and failed only `clockStable`. Runtime identity was stable,
but there are zero valid matched pairs. The run remains an invalid exploratory
pilot, with `passed=false`; formal paired deltas and the manipulation median
remain null. This amendment records the outcome without changing raw files,
clock thresholds, capture scope, workload, or protocol identity.

| Clock diagnostic (ms) | Short | Long | Limit |
| --- | ---: | ---: | ---: |
| Managed error range | 5.533 | 5.541 | 5 |
| Backend error range | 5.121 | 5.060 | 5 |
| Load-generator absolute backend clock error | 5.436 | 5.136 | 5 |

All three clock sources failed in both trials. These overruns invalidate
the paired timing analysis even though they are small compared with the
descriptive differences below. Their cause has not been established.

| Descriptive observation | Short | Long |
| --- | ---: | ---: |
| Protected-limit restoration bracket after return | 0.404–0.668s | 0.661–0.924s |
| Fresh borrowed batch admissions after return | 0 | 0 |
| Sustained zero borrowed occupancy bracket after return | 19.995–20.258s | 48.491–48.755s |
| Median remaining borrowed-stream lifetime | 20.665s | 49.173s |
| Initial burst completed / rejected | 1 / 1 | 1 / 1 |
| Return cohort completed / offered | 34 / 91 | 32 / 91 |
| Return cohort concurrency-limit rejections | 57 | 59 |
| Return cohort SLO successes / offered | 31 / 91 | 30 / 91 |
| SLO goodput per 90s arrival window | 0.344 requests/s | 0.333 requests/s |

The unvalidated long-minus-short differences are 28.508s in median remaining
stream lifetime and 28.497s in the upper bound for sustained zero borrowed
occupancy. Their agreement is consistent with existing borrowers draining
after protected limits return. It does not establish a causal lifetime effect,
physical engine reclamation, a service-recovery timestamp, or a general SLO
goodput effect. The 90s window captured sustained zero borrowed occupancy in
both trials, but that observation does not override failed validity gates.

Diagnose clock measurement overruns and repeat the v3 instrumentation pilot
before collecting the alternating five-pair sweep. Preserve failed pilots and
the existing 5ms rules; do not relax a threshold merely to accept this run.
Any measurement-method change must be documented before new collection and
must not retroactively validate these artifacts. No result is promoted to
published evidence by this amendment.

## Latest v3 pilot and descriptive diagnostics

The retained seed-3 v3 pilot `20261003T201440Z` ran on 2026-10-03
Pacific time, short first and long second. Short fails `clockStable`; long
fails both `clockStable` and `samplerIntegrity`. Admission provenance is
continuous in both trials, runtime identity is stable, and normalized traces
match. The pair is invalid, with zero valid matched pairs, `passed=false`, and
null formal paired estimates. These outcomes supplement the earlier pilot
records; they do not replace or validate them.

| Clock diagnostic | Short | Long | Existing limit |
| --- | ---: | ---: | ---: |
| Managed raw error range | 5.636ms | 5.601ms | 5ms |
| Backend raw error range | 5.108ms | 5.131ms | 5ms |
| Load-generator absolute backend clock error | 4.692ms | 4.498ms | 5ms |
| Managed fitted drift | 30.277ppm | 30.113ppm | Descriptive |
| Backend fitted drift | 29.998ppm | 29.998ppm | Descriptive |
| Managed residual range after linear fit | 1.031ms | 1.004ms | Descriptive |
| Backend residual range after linear fit | 0.004ms | 0.004ms | Descriptive |

Backend capture lasts 170.289s and 171.059s. A 30ppm drift accumulates about
5.1ms over 170s, so these fitted slopes suggest that the current full-capture
5ms raw-range gate will be close to systematically failing at this duration,
even without an abrupt clock step. A small residual does not prove timestamp
accuracy and does not substitute for the preregistered raw-range rule. Long
also has managed-telemetry gaps of 1.108s and 1.134s during the return window,
exceeding the unchanged 750ms coverage limit despite no recorded sampler
fetch errors. Its sustained-zero and post-zero diagnostics therefore lack
validated telemetry coverage.

| Descriptive observation | Short | Long |
| --- | ---: | ---: |
| Protected-limit restoration bracket after return | 0.439–0.703s | 0.539–0.842s |
| Fresh borrowed batch admissions after return | 0 | 0 |
| Accounting-zero bracket after return | 14.606–14.867s | 52.482–52.788s |
| Median remaining borrowed-stream lifetime | 16.424s | 52.870s |
| Last original borrower completes after return | 18.038s | 53.175s |
| Last original borrower completes after accounting zero | 3.171s | 0.387s |
| Initial burst completed / rejected | 1 / 1 | 1 / 1 |
| Return cohort completed / offered | 38 / 91 | 31 / 91 |
| Return cohort concurrency-limit rejections | 53 | 60 |
| Return cohort SLO successes / offered | 30 / 91 | 29 / 91 |
| Completed requests missing the SLO through TTFT | 8 | 2 |
| SLO goodput per 90s arrival window | 0.333 requests/s | 0.322 requests/s |

The long-minus-short lifetime difference is descriptively 36.446s; the
accounting-zero upper-bound difference is 37.921s. The long accounting-zero
bracket is an observed sample bracket, with sustained coverage invalidated by
the telemetry gaps. Neither difference is a formal paired estimate. The SLO
remains TTFT at most 5s and total latency at most 30s, with all 91 offered
requests in each denominator. No failed, missing or censored return-cohort
requests were observed in this pilot.

Short still rejects 40 of 75 interactive requests actually sent after its
sampled accounting-zero upper bound; 28 meet the SLO. The last original
borrower finishes 3.171s after that upper bound. These observations directly
separate accounting from continuing original-borrower work and protected
service. Of the 72 interactive requests sent after both original borrowers
finish, 39 are still rejected. Long's post-accounting-zero outcome diagnostic
is inconclusive because sampler integrity fails.

Each trial has one return-window pressure sample at the KV-usage saturation
threshold of 1, one increase in the engine preemption counter, and one observed
running-to-waiting then waiting-to-running transition for setup borrower 3.
The transition brackets retain sampling uncertainty. These engine observations
do not establish GPU preemption, physical KV reclamation, or a service-recovery
timestamp. Sustained batch demand continues within its protected allocation.

The diagnostics preserve raw errors, fitted drift, residual ranges, missing
data and request outcomes. They do not alter validity gates or retroactively
validate existing artifacts. Before new collection, any change to clock
measurement, sampling, capture scope or a validity rule must be preregistered,
documented and given a new protocol version. Preserve all failed pilots under
their original protocol. A valid pilot under the frozen measurement method
and the alternating five-pair sweep remain pending; no result from this
experiment has been published.

## Final v3 pilot and v4 amendment

The retained seed-3 v3 pilot `20261004T173611Z` ran on 2026-10-04 Pacific
time, short first and long second. Short fails 7 of 18 validity gates; long
fails only `clockStable`. There are zero valid matched pairs, `passed=false`,
and null formal paired estimates. Its files and protocol identity are unchanged.

| Observation | Short | Long | Rule |
| --- | ---: | ---: | ---: |
| Prime duration | 8.204s | 0.418s | Complete before setup 1 at +1s |
| Setup request 3 | 429 `concurrency_limit` | Admitted | Admitted, borrowed |
| Host pressure samples at `warn` | 27 of 33 | 10 of 32 | No `critical` |
| Swap-out during the arm | 387.5 MiB | 0 MiB | 256 MiB |
| Managed raw clock-error range | 5.845ms | 5.423ms | 5ms |
| Backend raw clock-error range | 5.381ms | 5.155ms | 5ms |
| Managed / backend fitted drift | 30.158 / 29.998ppm | 30.170 / 29.998ppm | Descriptive |

Short's prime was still streaming when setup request 1 was sent, so the prime
and two setup requests held batch's three slots and setup request 3 was
rejected. The intended pre-return state never formed; short also fails the
unchanged swap-out limit. The nine other retained v2/v3 trials completed the
prime in 362–438ms.

Three v3 pilots now fail `clockStable` in every trial with fitted drift near
30ppm and no discontinuity. Two read-only clock checks on 2026-10-04, outside
any trial, confirm the cause. A 180s host capture drifted 42.7ppm: 8.5ms of raw
range with no consecutive-reading change above 1ms. A 150s capture against an
idle container recorded a host clock correction of 9.4ms inside 90s with no
jump; the container clock stepped 5.6ms to follow, and its bracketed distance
from the host stayed within 9ms. The raw 5ms range rule measures gradual drift
over the capture length, so at this duration on this host it fails without any
clock fault. It is not relaxed: v3 keeps it, and every v3 pilot remains invalid.

`burst-recovery-v4` is documented here before any v4 collection. It changes
start conditions, clock measurement and the setup readiness measurement only.
The trace is byte-identical to v3: the same prime, setup, return time, output
caps, arrival rates, 90s return window and SLO thresholds. Arrivals stay fixed.
Provenance continuity, the 750ms sampler coverage rule, the pre-return overlap
gates and the during-run host gate are unchanged. V1–v4 trials cannot be
combined into matched pairs. All rules apply identically to both variants.

### Start conditions

After excluded warm-up and before any trace request, each trial runs two
read-only preflights and writes their raw rows to `burst-preflight-seed-N.json`.
Failing either one means the trial is not started; it is retained as invalid.

1. Clock preflight: 180s of the paired readings and container probes defined
   below, judged by the same rules as a trial capture.
2. Host preflight: one sample per second of memory pressure and the swap-out
   counter. It requires ten consecutive seconds at `normal` pressure with no
   swap-out increase, no read error and no sample gap above 1.5s, found within
   60s. It mutates nothing; closing other workloads is the operator's task.

A clean preflight does not guarantee a clean trial. The during-run gate stays:
no `critical` pressure sample, complete host and engine telemetry, and at most
256 MiB of swap-out. Validity recomputes both preflights from their raw rows.

The preflights last at least 190s, far beyond lending's 2s idle threshold. A
v4 trace therefore starts from the idle lending state, with the interactive
floor at its never-lent one, where v3 started on freshly warmed interactive
demand at three. The trace's own 0–25s interactive traffic restores the floor
as before, and the idle period before the prime is unchanged. No outcome is
measured before the return.

### Timing method

A paired reading is one wall-clock read bracketed by two monotonic reads. A
reading whose bracket exceeds 1ms is not clock evidence and counts as missing;
a malformed row fails. The runner and the load generator take one every 250ms.
The scheduler probe (schema 4) pairs every event row and adds a 250ms heartbeat.

The runner, load generator and scheduler probe read one host wall clock. Each
of these series must show no backward clock; no change in wall-minus-monotonic
between consecutive usable readings above 2ms plus 100ppm of the elapsed time
(an abrupt jump); a fitted slew within 100ppm, plus two timestamp resolutions
over the capture; and, within any 90s, a wall-minus-monotonic change of at most
10ms. Runner and load-generator readings must be at most 1s apart. Scheduler
gaps are reported, not gated: every scheduler timestamp is itself a paired
reading, so nothing is timestamped between two rows. Each series must cover,
within 1s, the timestamps its source contributes: from the load generator's
start through its last request end, and for the other sources through the
later of that end and the horizon.

Tyr and Latchflo read the container clock. A persistent read-only probe in
each container answers every 250ms with its own paired reading, bracketed by
host readings at send and receive. The container-minus-host offset therefore
lies between (container − receive) and (container − send), each widened by the
1ms read resolution, with no symmetric-latency assumption. A probe proves
alignment when the larger endpoint distance plus 1ms is at most 10ms. A probe
whose whole interval lies beyond 10ms proves misalignment and fails the trial.
A slow, failed or timed-out probe proves neither and counts as missing. Usable
probes must be at most 2s apart and cover the same window. A container clock
is disciplined toward the host, so its own steps and rate are reported and its
measured alignment is gated.

No offset is fitted or subtracted, and no timestamp is corrected. The fitted
slew describes the drift rate; a small fitted residual does not establish
synchronization. The 10ms budget is carried into the analysis instead:

- Recognition, restoration, sustained-zero and scheduler-exit brackets are
  widened by 10ms on each side. Observed endpoints are retained beside them.
- A borrowed admission inside a widened bracket is reported as within it. One
  within 10ms of the return or the horizon is counted inside the window.
- Durations are differences of wall readings and are not corrected. The rules
  above bound their error at 10ms per 90s.

These gates bound each probe and each pair of consecutive readings. They do not
prove alignment at every instant between probes, and they do not establish
physical engine timing.

### Setup readiness

Before setup request 1 the prime must have completed with its one reported
token, no batch request may be in flight, and the batch protected floor must be
one. V2 and v3 inferred this from the 250ms sampler. V4 observes it explicitly:
from the prime's planned send until setup request 1 has been sent, the load
generator reads Tyr's batch state through the runner about every 100ms. The
deciding observation is the last answer received before the actual send. It
must have begun after the prime's stream ended and at most 500ms before the
send, and show zero batch requests in flight and a floor of one. Request 1's
exact admission grant must also show that floor, and the live report must agree.
These reads add about ten pool-state requests per trial in both variants.

The checkpoint only observes. A missed condition makes the trial invalid, and
the verdict and its reasons are printed as soon as setup request 1 has been
sent; arrivals do not wait, retry or move, and the trace continues unchanged.
A bounded readiness wait is not adopted: the fixed schedule has not been
unreliable on a quiet host, and the one miss occurred on a host at `warn`
pressure from its first sample, a start condition the host preflight now
rejects. Adopt one only under a new protocol version.
Historical v2/v3 analyses now also list why their sampler-based gate failed.

### Validation and status

Regression fixtures cover gradual drift at 30, 43, 85 and 99ppm (valid) and at
125 and 150ppm (invalid as drift, not as a jump); jumps of 3–50ms in either
direction, reversed jumps, backward clocks and a fast slew that no single
reading shows; one-millisecond resolution ticks; bounded and excessive sample
loss, slow reads, malformed rows and incomplete coverage; aligned, misaligned,
slow and lost probes; and a container step that keeps alignment. Synthetic
passes establish only that the rules classify these cases as stated.

A v4 instrumentation pilot must pass every gate in both trials before the
alternating five-pair sweep. No result from this experiment has been published.

## V4 instrumentation pilot outcome

The retained seed-3 v4 pilot `20261004T185842Z` ran on 2026-10-04 Pacific
time, short first and long second. Short was not started and long is invalid.
There are zero valid matched pairs, `passed=false`, and null formal paired
estimates. No rule, threshold or protocol identity was changed in response.

Short passed the clock preflight: 30.0ppm of host slew and container alignment
proven within 9ms, with 3 of 711 probes per container too slow to count. Its
host preflight then read `warn` memory pressure in all 59 samples across 60s,
with the swap-out counter flat. No trace request was sent.

Long passed both preflights, then failed 8 of 19 gates on a host that began
swapping about 25s into the trace.

| Observation | Long | Rule |
| --- | ---: | ---: |
| Swap-out during the arm | 1353.4 MiB, all by 45s | 256 MiB |
| Host pressure samples at `warn` | 6 of 34 | No `critical` |
| Prime duration | 6.942s | Complete before setup 1 |
| Setup readiness verdict | Missed, reported at +42.005s | Ready |
| Setup request 3 | 429 `concurrency_limit` | Admitted, borrowed |
| Largest managed-telemetry gap in the return window | 752ms | 750ms |
| Runner / load generator / scheduler fitted slew | 28.2 / 28.1 / 28.1ppm | 100ppm |
| Their largest wall-minus-monotonic change in 90s | 3.5 / 3.4 / 2.6ms | 10ms |
| Their raw residual range over the capture | 5.5 / 5.4 / 4.6ms | Descriptive |
| Jumps between consecutive readings | 0 | 0 |
| Tyr / Latchflo largest gap between usable probes | 1.769s / 2.288s | 2s |

The checkpoint named the missed readiness as setup request 1 was sent: the
prime was still streaming and one batch request was in flight. The prime and
two setup requests then held batch's three slots, so the pre-return overlap,
attribution and completion gates fail with it. The miss fell inside the
swap-out burst. It is not evidence that the fixed schedule is unreliable on a
quiet host, and the bounded readiness wait remains unadopted.

`clockStable` fails only on Latchflo's probe gap. Each container had 26 of 647
probes too slow to prove alignment. Every one of them took at least 13ms and
they cluster with the swap-out bursts; among fast probes the container stayed
between 4ms behind and level with the host. The three host series pass with
gradual drift and no jump, at raw ranges the v3 rule would have rejected in
two of them. This is one invalid trial, not a validation of the timing method
under a clean run.

Repeat the v4 pilot on a host with memory headroom before the sweep.

## Pilot, freeze and sweep

Run a seed-3 pair first to check capture, overlap and dispatch. Retain failed
pilots. If overlap or lifetime separation is inadequate, revise this protocol
and name/version the revision before collecting the main sweep; do not tune
against goodput. The default sweep uses seeds 1–5, alternating which variant
runs first by seed position (three short-first, two long-first). Each trial
recreates the engine and excludes warm-up. Five pairs are exploratory, not a
p99 estimate or a comparative non-inferiority claim.

## Measurements and validity

Record planned and actual sends, HTTP outcomes, exact Tyr admission IDs,
admission timestamps/resources/grants, scheduler enqueue and first scheduling,
running/waiting request IDs, client first token and stream end, sampled applied
grants, controller demand and borrowed occupancy. Admission-ring sequences must
be continuous from a synchronous pre-load baseline through a final sample;
missing attribution, retention loss, clock steps or sampler errors make the
mechanistic claim inconclusive. Ring counters alone do not prove continuity.

A trial requires both burst attempts within 25ms, all three setup batch requests
running in a scheduler snapshot no more than 500ms before the first return,
and a nearby Tyr sample with exactly three active batch requests, two borrowed
slots, no interactive request and an interactive floor of one. Correlate each
setup request's admission ID to exact Tyr resources: two borrowed, one owned.
All setup streams must complete with their assigned output cap for the remaining
lifetime contrast. Keep rejected, failed, censored and invalid trials in output.
Do not require a favorable recovery outcome for validity.

For matched complete pairs, report long-minus-short differences and the median
remaining lifetime of the two borrowed setup streams at the first actual return. A
five-pair contrast requires all planned pairs valid, stable runtime identity,
identical normalized traces, and median long-minus-short remaining lifetime at
least 5s. Failure of this manipulation gate is inconclusive, not evidence that
borrower lifetime has no effect.

## Primary outcomes and interpretation

Count exact new batch admissions attributed to borrowed concurrency after
actual return, after first sampled controller recognition, and after first
sampled restoration of the nominal interactive grant. Report admissions whose
times fall inside an observation bracket separately: sampled recognition and
application are intervals, not exact transition times. Report the first sampled
zero borrowed occupancy that remains zero through the final sustained-arrival
sample, its preceding-sample bracket, and censor it if zero is never sustained.

Report initial-burst outcomes separately from the sustained return cohort:
SLO goodput per 90s return arrival window (TTFT ≤5s and total latency ≤30s),
rejections, failures, censoring, and per-request timelines. Retain all offered
requests in the denominator. Report each setup stream's remaining lifetime and
scheduler-running exit brackets; stream end and occupancy brackets are not an
exact physical-slot release timestamp.

Fresh borrowing after grant restoration indicates an admission-policy problem.
Borrowing only before observed application points toward detection/propagation.
No refill with recovery following borrowers points toward reserve sizing or
borrower lifetime. Restored admission floors do not establish engine service,
KV reclamation or GPU preemption. A bounded-borrowing implementation is a later
intervention only if these observations show a distinct behavior to change.

## Commands and artifacts

```sh
npm run demo:vllm:metal:burst-recovery:dry-run
npm run demo:vllm:metal:burst-recovery:pilot
npm run demo:vllm:metal:burst-recovery
npm run demo:vllm:metal:burst-recovery:analyze -- --run=results/runs/vllm-metal-burst-recovery/<run-id>
```

Runs are ignored, fresh directories under `results/runs/vllm-metal-burst-recovery/`.
Every trial retains its raw loadgen, trace, telemetry, scheduler JSONL,
preflight rows, diagnostics and summary. The pair summary contains relative
pointers. No published evidence is replaced. Publish reviewed results with the established
`evidence:publish --experiment=protected-burst-recovery --profile=burst-recovery-v4`
workflow only after examining validity and documenting any protocol revision.

Interrupting the runner forwards cancellation to the active trial and waits
for its cleanup before writing an invalid partial aggregate. It starts no
further trial. Available diagnostics and sampled telemetry are retained;
interrupted telemetry is explicitly marked incomplete. Owned host processes
are stopped, and default stack cleanup still runs before exit.
