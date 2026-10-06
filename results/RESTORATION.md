# Restoring a grant is not restoring capacity

*Jay Balangue, October 2026. Covers published moflux-bench evidence through 2026-09-28.*

MoFlux is an admission-control layer that sits in front of an inference engine. It protects capacity for interactive traffic and lends that capacity to batch work while interactive demand is idle. This write-up is about what happens when interactive demand comes back: how long is it until the protected capacity is usable again?

On my setup, "restored" turned out to name three different events that happen at different times.

1. **The grant comes back.** The admission controller is again allowed to admit the protected number of interactive requests. This took about one second or less in every run.
2. **Borrowed occupancy settles.** Batch requests admitted on lent capacity finish, so batch is back inside its own allowance. This took up to 4 seconds with short batch requests and up to 20 seconds with long ones.
3. **The engine schedules the returning request.** In the one design that forces a returning request to wait inside the engine, vLLM scheduled it 3.6 to 4.0 seconds after the grant came back. That is five observations.

None of this shows MoFlux reclaiming GPU or KV-cache capacity. MoFlux stops admitting new borrowed work and waits for running work to finish. It does not preempt anything.

Everything below comes from eight published five-seed runs in [moflux-bench](https://github.com/janbalangue/moflux-bench/blob/v0.52.0/results/CATALOG.md). Two of the eight failed their interactive check, and both are included.

## Setup

- **Host and engine:** one Apple M1 with 16 GiB, vLLM 0.29.0 with vllm-metal, Qwen2.5-1.5B-Instruct, four concurrent sequences.
- **MoFlux:** Tyr is the admission controller and Latchflo is the control plane that issues its grants.
- **Arms:** each seed replays one identical request trace through four arms.
  - *FCFS:* direct vLLM with its default scheduler.
  - *Priority:* direct vLLM with priority scheduling.
  - *Static:* a fixed admission partition (three interactive slots, one batch) in front of priority scheduling.
  - *MoFlux:* the same partition, with idle interactive slots lendable to batch and at least one slot that is never lent.
- **Trace:** interactive traffic for 25 seconds, then batch only, then interactive returns at 60 seconds for 25 seconds while batch continues. Across five seeds, 67 interactive requests arrive in that return window.
- **On time:** first token within 5 seconds and completion within 30. A rejected request is not on time. Each request gets one attempt.

There are two workloads. The balanced one uses short batch requests and barely touches the KV cache. The long-context one uses 7,100-character batch prompts and pins the scheduler's KV pool at 5,120 tokens, so three batch requests nearly fill it.

| Run | Workload and policy | Configured checks |
| --- | --- | --- |
| A | Balanced, one slot never lent | Pass |
| B | Long-context, one slot never lent | Pass |
| C | Repeat of B | Fail on the interactive check |
| D | Long-context, two slots never lent | Pass, exactly on the margin |
| E | Repeat of D | Pass, exactly on the margin |
| F | Long-context, eight admitted against four engine slots (six interactive, two batch), two never lent | Pass |
| G | Availability control, ordinary returning request | Pass, but too few availability observations |
| H | Availability, enlarged returning request | Fail on the interactive check, and too few availability observations |

## The grant comes back in about a second

Restoration was needed in 36 of the 40 seed-runs. In all 36, the sampled grant floor was back within 1.015 seconds of interactive demand being detected.

Grant state was sampled every second in runs A to F and every 250 ms in G and H, so these figures are at sample resolution. A zero means the floor was already in place at the first sample after demand returned.

## Borrowed occupancy takes much longer

| Run | Grant floor restored (s) | Borrowed occupancy settled (s) | Peak KV usage |
| --- | --- | --- | --- |
| A | 0 to 1.0 | 0 to 4.1 | 1.3 to 2.3% |
| B | 1.0 | 0 to 18.1 | 97.5 to 99.7% |
| C | 0 to 1.0 | 1.0 to 20.1 | 97.5 to 100% |
| D | 0 to 1.0 | 0 to 17.2 | 65.5 to 70.9% |
| E | 0 to 1.0 | 0 to 12.1 | 65.2 to 70.9% |
| F | 0 to 1.0 | 1.0 to 17.1 | 98.8 to 99.7% |
| G | 0 to 0.8 | 7.2 to 7.7 | 99.4 to 99.7% |
| H | 0.3 to 0.5 | 4.9 to 5.2 | 98.8% |

Settling took more than 15 seconds in eight seed-runs, all of them long-context. A full KV pool was not required: run D reached 17 seconds with KV usage peaking at 71%. What the slow runs share is long batch requests, which is consistent with settling time following how long the borrowed work still has to run.

Slow settling lined up with worse interactive outcomes. In the four runs that use the standard four-slot boundary (B to E, 20 seed-runs):

| Occupancy settling | Seed-runs | Interactive completions, MoFlux minus static |
| --- | --- | --- |
| Over 15 s | 6 | −2, −3, −4, −4, −5, −7 |
| 15 s or under, or no restoration needed | 14 | +3, +1, +1, five at 0, five at −1, and one −4 |

This is an association in admission-side data, and it has three weaknesses.

- **It is partly one trace.** Seed 2 supplies three of the six slow cases.
- **Run F is weaker.** Its two slow seeds were the only ones where MoFlux trailed static, but by 1 and 3 requests.
- **The reverse does not hold.** In runs G and H occupancy settled in under 8 seconds, and MoFlux still finished 2 to 4 interactive requests behind static in four of ten seed-runs.

Yash Karecha suggested a mechanism that would produce this pattern. If lending reopens as soon as interactive demand goes idle, while earlier borrowed work is still running, the system may never fully recover before the next loan. Restoring the grant and deciding when lending may reopen would then need separate conditions. These runs do not demonstrate that cycle.

## The engine schedules on its own clock

Runs G and H were designed to measure the third event: the time from grant restoration to vLLM actually scheduling a returning interactive request.

In G, the returning request was an ordinary 400-character prompt. Four of the five were served through the never-lent slot before the grant was restored at all, and one was inconclusive. There was no wait to measure, which is the never-lent slot doing its job.

In H, the returning request was enlarged to 2,000 characters. It needs about 30 KV blocks, and three resident batch requests leave at most 17 free. In all five seeds:

- it was admitted through the never-lent slot about half a second before the grant came back;
- it then waited in vLLM's queue for 4.0 to 4.1 seconds in total;
- vLLM scheduled it 3.6 to 4.0 seconds after the grant was restored;
- its first token reached the client 4.6 to 4.8 seconds after the grant was restored.

vLLM's scheduler places a waiting request only once its whole prompt fits, and it does not preempt running work to make room. So that wait ended when the engine had room, which the admission layer does not control.

This is five observations, and the design requires 30 before it says anything about the distribution. H also ran before G, so host drift between the two is possible. Details are in the [availability notes](https://github.com/janbalangue/moflux-bench/blob/v0.52.0/results/curated/vllm-metal-backend-availability/README.md).

## What lending bought and what it cost

Batch counts are completions across five seeds. Interactive counts are requests served on time out of the 67 that arrive in the return window. The last column is the five-seed median of the paired difference between MoFlux and priority, in requests per return window; the check allows −1.

| Run | Batch completed, static → MoFlux | On time: FCFS / priority / static / MoFlux | Median, MoFlux minus priority |
| --- | --- | --- | --- |
| A | 72 → 110 of 236 | 21 / 63 / 58 / 61 | 0 |
| B | 21 → 29 of 60 | 3 / 38 / 47 / 39 | 0 |
| C | 21 → 28 of 60 | 3 / 54 / 53 / 35 | −5 (fail) |
| D | 20 → 26 of 60 | 2 / 52 / 53 / 37 | −1 |
| E | 23 → 27 of 60 | 18 / 64 / 59 / 59 | −1 |
| F | 31 → 41 of 60 | 18 / 62 / 66 / 61 | 0 |
| G | 19 → 26 of 42 | 45 / 60 / 60 / 51 | 0 |
| H | 19 → 28 of 42 | 34 / 60 / 57 / 48 | −3 (fail) |

**Lending finished more batch work than the fixed partition in all eight runs.** The gain is in eventual completions of requests admitted while capacity was lent. Completions inside the idle window itself barely moved: MoFlux 12 and static 12 in run B, then 12 and 11 in run C.

**It usually cost on-time interactive service.** MoFlux served fewer interactive requests on time than the fixed partition in six of eight runs, the same number in one, and more in one.

**Against native priority the median held in six runs and failed in two.** The median also hides the tails. In run D the median seed was one request behind priority, which passes, while the five-seed total was 15 behind, almost all of it in two seeds.

**Direct vLLM completed everything.** The FCFS and priority arms finished all 99 interactive requests and every batch request in every run, because they queue what the admission arms reject. FCFS finished them late. Priority finished them on time about as often as the fixed partition did, and it completed far more batch work. So these runs measure what an admission partition costs in front of a single engine that has time to drain. They do not test a case where the engine cannot be allowed to queue everything.

**The results move between repeats.** Runs B and C use the same traces and the same versions: B passed and C failed. Between D and E, interactive completions for static and MoFlux went from 85 and 74 to 90 and 91. Native priority's on-time total ranged from 38 to 64 across runs B to F on identical traces. The operating system changed between B and C. I treat each five-seed run as one draw, and the medians as descriptive.

A separate simulator experiment tested lending while interactive traffic was still busy. It failed: median interactive p95 rose 11.5% with no reliable gain in batch completions.

## Still open

Both open questions came from Yash Karecha.

**When should lending reopen?** A [preregistered experiment](https://github.com/janbalangue/moflux-bench/blob/v0.52.0/demo/BURST-RECOVERY.md) holds one slot unlent, fills two borrowed slots with batch work, returns two protected requests together, and changes only how long the two borrowers still have to run. It has no published result. One pilot pair has passed every validity check:

- the borrowers' remaining lifetimes were 13.8 and 43.7 seconds;
- neither variant admitted new borrowed work after protected traffic returned;
- borrowed occupancy cleared by 13.9 seconds with the short borrowers and was still held when the 40-second window closed with the long ones;
- both variants completed 14 of 41 interactive requests, with 12 and 14 on time.

That is one pair, so it says nothing about goodput. Every pilot on a longer 90-second window has been invalid so far, first on clock drift and then on host memory pressure.

**Does the admission boundary change what the engine gets to see?** A tight boundary keeps vLLM's own queue nearly empty, so its priority scheduler never takes part in the contention. Run F admits eight requests against four engine slots, and the engine queue did form in all five seeds. MoFlux matched native priority at the median. The [preregistered](https://github.com/janbalangue/moflux-bench/blob/v0.52.0/demo/ADMISSION-BOUNDARY.md) back-to-back four-slot baseline has not been run, so nothing yet shows that loosening the boundary changes outcomes.

## Limits

- One host, one small model, and Metal, not CUDA. Nothing here generalizes beyond that.
- Five seeds per run. The checks are median thresholds, not statistical tests.
- Grant and occupancy figures are sampled admission state. Zero borrowed occupancy at the admission layer does not show that the engine has released anything.
- No run shows MoFlux reclaiming KV blocks or preempting inference.

## Acknowledgments

Thanks to Yash Karecha (inference-x) for suggesting that reopening lending should consider whether earlier borrowed work has settled, and for pointing out that the admission boundary changes what vLLM's scheduler gets to see.

## Evidence

Every number above comes from a published summary listed in the [evidence catalog](https://github.com/janbalangue/moflux-bench/blob/v0.52.0/results/CATALOG.md). Run-level notes cover the [long-context pass and failed repeat](https://github.com/janbalangue/moflux-bench/blob/v0.52.0/results/curated/vllm-metal-long-context/README.md), the [admission boundary run](https://github.com/janbalangue/moflux-bench/blob/v0.52.0/results/vllm-metal-long-context-admission-8-unlent-2/README.md) and the [availability runs](https://github.com/janbalangue/moflux-bench/blob/v0.52.0/results/curated/vllm-metal-backend-availability/README.md).
