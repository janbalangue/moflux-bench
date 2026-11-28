# moflux-bench

[![CI](https://github.com/janbalangue/moflux-bench/actions/workflows/ci.yml/badge.svg)](https://github.com/janbalangue/moflux-bench/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/janbalangue/moflux-bench.svg)](LICENSE)

A synthetic and budget-capped live-provider benchmark harness for LLM admission control.

It exists to answer one question honestly: **when does reserving capacity before
a request starts actually beat the alternatives, and what does it cost?**

Most claims in this space are mechanism descriptions. A mechanism is a
hypothesis. This harness turns it into a measurement you can argue with.

## What you can and cannot reproduce here

Read this before anything else.

| Arm | Included | Reproducible by you |
|---|---|---|
| 1 — no admission control | yes | yes |
| 2 — static local cap, `envelope / replicas` | yes | yes |
| 3 — static local cap set to the full envelope | yes | yes |
| 4 — Redis shared concurrency + token budget | yes | yes |
| 5 — Tyr, observe mode | **no** | no |
| 6 — Tyr + Latchflo, enforce mode | **no** | no |

Tyr is open source under Apache-2.0 at [janbalangue/tyr-admission-controller](https://github.com/janbalangue/tyr-admission-controller)
and is not vendored here. Latchflo is proprietary and is not redistributed in
this repository. This harness runs arms 5 and 6 only through the
Latchflo-managed presenter, so both require a licensed Latchflo image.

So the honest description of what this repo offers is: you can reproduce every
baseline, verify that the simulator matches its own stated model, and check
whether the MoFlux figures published in `results/` are plausible against the
arm-4 result you ran yourself. That is weaker than full reproducibility. It is
stated here rather than buried.

## Run the public arms

You need Node.js 22 or newer and Docker Compose v2. You do not need Tyr,
Latchflo or an API key, and there are no runtime npm dependencies.

```bash
git clone https://github.com/janbalangue/moflux-bench.git
cd moflux-bench
npm run verify
npm run demo:full
```

`npm run verify` runs the simulator, load-generator and harness self-tests.
`npm run demo:full` starts Prometheus, Grafana, Redis and a telemetry relay,
walks through the public arms, and opens the dashboard.

→ [Public research walkthrough](guides/public-walkthrough.md)

## How it measures

- **A provider simulator with a published model.** Per-stream token rate falls
  as concurrency rises, following the Universal Scalability Law. `npm run sweep`
  checks the simulator against the analytic curve.
  → [The provider simulator](guides/provider-simulator.md)
- **An open-loop load generator.** Arrivals follow a Poisson process and do not
  wait for completions, so overload cannot hide inside the generator. A run
  where `generator_saturated_total` is non-zero must be discarded.
  → [The load generator](guides/load-generator.md)
- **One immutable trace per seed.** Every arm replays the same arrivals, retry
  jitter, target choices and provider samples. Only the admission policy
  changes.
- **Control arms you could build yourself.** A static per-replica cap and a
  Redis reserve run in the same request-path position as MoFlux.
  → [Comparing against the alternatives](guides/control-arms.md)
- **Local rejects and upstream 429s are counted separately.** A local reject
  costs nothing. An upstream 429 was earned after provider capacity had already
  been spent on the request.
  → [Metrics that matter](guides/metrics.md)

## Experiments

The public arms need only Node.js and Docker. Every other experiment runs Tyr,
and most also run Latchflo, which needs a licensed image.

| Experiment | What it asks | Start with | Runs |
|---|---|---|---|
| [Public walkthrough](guides/public-walkthrough.md) | How do no control, static caps and a Redis reserve behave on one workload? | `npm run demo:full` | Public arms |
| [Paired seed sweep](guides/paired-sweep.md) | How does Tyr + Latchflo compare with no control on the same trace, over five seeds? | `npm run demo` | Tyr, Latchflo |
| [Control arms](guides/control-arms.md) | Does MoFlux beat a static cap or a Redis reserve? | `npm run demo:arms` | Tyr, Latchflo |
| [Lending](guides/lending.md) | Does interactive borrow the idle batch floor, and does the floor come back? | `npm run demo:lending` | Tyr, Latchflo |
| [Retry hints and adaptive capacity](guides/adaptive-capacity.md) | What do retry hints and headroom lending each contribute? | `npm run demo:hetero:adaptive` | Tyr, Latchflo |
| [Request sizes](guides/request-sizes.md) | Does the token budget decide anything a concurrency limit would not? | `npm run demo:hetero` | Tyr, Latchflo |
| [Coordinator distance](guides/coordinator-distance.md) | Does per-request coordination cost more as the coordinator moves away, and does lease-based coordination stay flat? | `npm run demo:coordinator` | Tyr, Latchflo |
| [Admission classes](guides/admission-classes.md) | Do class floors hold against a noisy neighbor, and what returns a lent floor? | `npm run demo:classes` | Tyr, Latchflo |
| [Fleet membership](guides/fleet-membership.md) | Does the fleet converge when replicas join, time out and are replaced? | `npm run demo:membership` | Latchflo |
| [Local inference](guides/local-inference.md) | What does Tyr add in front of one Ollama server, and does MoFlux protect interactive work under contention? | `npm run demo:local:dry-run` | Tyr; the contention benchmark adds Latchflo |
| [vLLM contention](guides/vllm-contention.md) | How do FCFS, native priority, a rigid partition and MoFlux lending compare on one GPU-backed server? | `npm run demo:vllm:dry-run` | Tyr, Latchflo, vLLM |
| [Live OpenAI](guides/live-openai.md) | Is Tyr compatible with a real provider, and does it help under provider overload? | `npm run demo:openai:dry-run` | Tyr, an OpenAI API key |

Licensed runs are pinned to Tyr 0.35.0, Latchflo 0.20.1, async-bulkhead-llm
3.18.0 and async-bulkhead-ts 1.0.1.

→ [Runtime pins and comparison limits](guides/runtime-pins.md)

## Reading the evidence

Generated runs land under the ignored `results/runs/`. Reviewed evidence is
committed, and no run writes to it.

- The [evidence catalog](results/CATALOG.md) lists every recorded summary with
  its seed count, proof outcome, runtime and limitations.
- The [results notes](results/README.md) describe each corpus and how far it
  can be quoted.
- The [restoration write-up](results/RESTORATION.md) summarizes what the
  published vLLM Metal runs show about grant restoration. It is a narrative
  summary, not additional evidence.
- The [correction record](results/CORRECTIONS.md) explains the evidence layout
  and the descriptions that were corrected.

Published results span several runtime cohorts, and saved evidence keeps the
versions that produced it. Do not quote a single run: use at least five seeds
and report medians with spread.

## Documentation

| Guide | What's in it |
|---|---|
| [The paired seed sweep](guides/paired-sweep.md) | The canonical licensed presenter: capacity policy, images, routing, commands, what a result records |
| [Runtime pins and comparison limits](guides/runtime-pins.md) | The pinned Tyr and Latchflo releases, what each one changed, which runs can be compared |
| [The provider simulator](guides/provider-simulator.md) | The Universal Scalability Law model and how the simulator is checked against it |
| [The load generator](guides/load-generator.md) | Open-loop arrivals, retry hints, per-request samples |
| [Comparing against the alternatives](guides/control-arms.md) | The static-cap and Redis arms, the paired aggregates, a sample result |
| [The lending benchmark](guides/lending.md) | The evidence required to show that an idle floor was lent and came back |
| [Retry hints and adaptive capacity profiles](guides/adaptive-capacity.md) | The adaptive profiles, the proof gate, the paired headroom comparison |
| [Request size heterogeneity](guides/request-sizes.md) | Lognormal request sizes, and whether a run exercised the token budget |
| [Coordinator distance](guides/coordinator-distance.md) | The latency ladder, its four verdicts, admission-decision cost, rung order |
| [Authenticated admission classes](guides/admission-classes.md) | The four-arm class benchmark and the restoration enforceability ladder |
| [Fleet membership](guides/fleet-membership.md) | Convergence, timeout removal and replacement against Latchflo |
| [Local inference with Ollama](guides/local-inference.md) | The compatibility run and the three-arm contention benchmark |
| [vLLM contention](guides/vllm-contention.md) | The four-arm NVIDIA and Apple Silicon experiment, backend availability, burst recovery |
| [Live OpenAI experiments](guides/live-openai.md) | The compatibility check, overload calibration, the three-arm comparison, the spend guard |
| [Public research walkthrough](guides/public-walkthrough.md) | The narrated public arms, their support services, host processes and ports |
| [Metrics that matter](guides/metrics.md) | The reject split, rejection snapshots, arms that measured nothing |
| [Known limitations](guides/limitations.md) | Where the simulator and the evidence stop |
| [Repository layout](guides/layout.md) | What each file and directory is for |

The experiment protocols stay next to the code they describe:

| Protocol | What's in it |
|---|---|
| [Wiring the Tyr and Latchflo arms](demo/TYR-ARM.md) | The presenter command, where the arms sit in the harness, the metrics to scrape, comparison hygiene |
| [Video demo](demo/VIDEO-DEMO.md) | The recording flow and narration for the paired sweep |
| [Admission-class fairness and lending](demo/TENANT-FAIRNESS.md) | The exact policy, lease semantics, security model and proof contract |
| [Local inference contention](demo/LOCAL-CONTENTION.md) | Arms, phases, acceptance gates and the claim boundary |
| [vLLM contention](demo/VLLM-CONTENTION.md) | The matrix, workload, telemetry contract, acceptance gates and publication path |
| [Grant restoration to backend availability](demo/BACKEND-AVAILABILITY.md) | The opt-in availability experiment on vLLM Metal |
| [Looser admission boundary](demo/ADMISSION-BOUNDARY.md) | The preregistration and its amendments |
| [Protected burst recovery](demo/BURST-RECOVERY.md) | The preregistration, pilots and protocol amendments |

Release-by-release detail lives in the [changelog](CHANGELOG.md), and each
release's checks in the [verification record](VERIFICATION.md).

## What it does not show

- **Absolute performance against a real provider.** The synthetic provider is a
  model. It measures decision quality and coordination.
- **A result from a single run.** The trace is replayed exactly, but the system
  runs on a real clock. Single-run numbers are anecdotes.
- **Reclamation of upstream work.** Restoration is a claim about admission
  grants. No experiment here claims that GPU work, KV cache or provider tokens
  are reclaimed.
- **A fully reproducible MoFlux result.** The arms that use Latchflo need a
  license.

→ [Known limitations](guides/limitations.md)

## Contributing and security

See [`CONTRIBUTING.md`](CONTRIBUTING.md) to contribute and
[`SECURITY.md`](SECURITY.md) to report a vulnerability.

## License

Apache-2.0. See [`LICENSE`](LICENSE).

This license covers the harness only. Tyr is also Apache-2.0, but it is a
separate project ([janbalangue/tyr-admission-controller](https://github.com/janbalangue/tyr-admission-controller)) and is not included
here. Latchflo is proprietary, is not included here, and is licensed separately;
no license in this repository or in Tyr grants rights to it.
