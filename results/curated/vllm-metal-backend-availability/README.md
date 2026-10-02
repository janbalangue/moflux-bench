# Backend availability: v2 control and v3 negative result

Two five-seed protocols from 2026-09-28 are retained separately:

| Protocol | Summary | Contention validity | H1–H5 verdict | Availability observations |
| --- | --- | --- | --- | --- |
| v2, ordinary return prompt | [20260928T041426Z](fixed-burst-v2-20260928T041426Z.json) | 5/5 valid | Pass | 0/30 required |
| v3, enlarged return prompt | [20260928T032816Z](fixed-burst-v3-20260928T032816Z.json) | 5/5 valid | Fail: H2 | 5/30 required |

Both run seeds 1–5 with counterbalanced FCFS, native priority, static
protected admission and MoFlux lending arms. Within each protocol every
arm replays the same immutable per-seed trace. v2 uses a 400-character
selected return prompt; v3 changes only that selected prompt to 2,000
characters, requiring more free KV blocks. The protocols are not pooled.
v3 ran before the five-seed v2 control, so sequential host drift remains
a possible explanation for differences between protocols.

| Paired median, req/s | v2 | v3 |
| --- | ---: | ---: |
| Priority minus FCFS interactive SLO goodput | 0.04 | 0.16 |
| MoFlux minus priority interactive SLO goodput | 0.00 | -0.12 |
| MoFlux minus static batch arrival-cohort goodput | 0.057 | 0.057 |

v3's MoFlux-minus-priority differences by seed are -0.12, -0.16, -0.04,
-0.04 and -0.12 req/s. Its median fails the unchanged H2 margin of
at least -0.04 req/s. This is a valid negative contention result. v2's
median passes, but its differences range from -0.24 to +0.04 req/s;
five-seed median gates are descriptive, not confidence-bound tests.
Interactive SLO goodput includes admission rejections as zero useful work.
Batch goodput measures eventual completion yield of borrow-phase arrivals,
not completions timestamped within the borrow phase.

The availability endpoint is the first engine scheduler step allocating KV
capacity and scheduling tokens for the preregistered return request. In v2,
four MoFlux requests are served before grant restoration and one episode
is inconclusive. There are no observed post-restoration episodes. In v3,
all five requests are pending in the engine at grant restoration and all
five episodes are observed. Their grant-to-scheduler measurement bounds
span 3.552–4.004s; the conditional median has bounds 3.651–3.923s.
These are measurement bounds, not confidence intervals.

**Neither protocol passes the separate 30-observation availability
distribution gate.** Five observations do not establish p99 or an improvement
over controls. Static's five episodes per protocol are not applicable to
the restoration endpoint. A fast Tyr grant transition does not establish
physical backend availability. MoFlux does not reclaim vLLM KV blocks or
preempt running inference. See
[the protocol and limitations](../../../demo/BACKEND-AVAILABILITY.md).

Runtime: harness 0.49.0, Tyr 0.33.0, Latchflo 0.19.0, vLLM/vllm-metal
0.29.0, Apple M1 with 16 GiB on macOS 27.0, Qwen2.5-1.5B-Instruct revision
`989aa7980e4cf806f80c7fef2b1adb7bc71aa306`. This is local Metal evidence,
with no CUDA or production-scale generalization.

Each companion directory preserves `original-summary.json`, immutable traces,
raw client and telemetry JSON, diagnostic JSON, and all 21 original scheduler
JSONL files, including startup/warm-up capture. `provenance.json` records
SHA-256 hashes for all 177 source JSON/JSONL files per run. All retained raw
files are byte-identical to their sources. Text process logs are omitted.
Top-level summaries add promotion metadata and retain recorded runtime,
gates, outcomes, censoring and inconclusive episodes.
