# Admission boundary 8: standalone five-seed result

[Published summary](../vllm-metal-long-context-admission-8-unlent-2.json)
from run `20260928T062711Z` (UTC), generated on 2026-09-28. Seeds 1–5
replay one immutable trace per seed through FCFS, native priority, static
protected admission, and MoFlux lending. All validity gates and H1–H5 pass.
The engine-queue manipulation check passes in 5/5 seeds: MoFlux's sampled
contention queue peaks at 4, 4, 2, 4, and 3, against a threshold of two.

Admission allows eight requests against four engine slots. Static uses a
6/2 interactive/batch partition; MoFlux uses the same partition and keeps
two interactive slots never lent. This is a separate policy cohort from
the published boundary-4 experiments.

| Paired metric, req/s | Median | Min | Max |
| --- | ---: | ---: | ---: |
| Priority minus FCFS interactive SLO goodput | 0.36 | 0.00 | 0.64 |
| MoFlux minus priority interactive SLO goodput | 0.00 | -0.16 | 0.12 |
| MoFlux minus static batch arrival-cohort goodput | 0.086 | 0.028 | 0.114 |

Of 67 returning interactive requests across five seeds, native priority
serves 62 within SLO, static 66, MoFlux 61, and FCFS 18. MoFlux rejects
four at admission and completes two beyond the SLO. Static rejects none
and completes one beyond the SLO. SLO means TTFT at most 5s and end-to-end
latency at most 30s for requests arriving in the 60–85s return window.
Rejections contribute zero SLO goodput.

The preregistered Primary 1 median is zero requests: **no measurable
difference against native priority under this descriptive five-seed rule**.
Passing H2 is a median threshold check, not a statistical non-inferiority
test. The paired boundary-4 sweep required by
[the preregistration](../../demo/ADMISSION-BOUNDARY.md) is absent. Primary 2
and any claim that loosening admission improves outcomes remain unestablished.
Historical runs cannot substitute for the required back-to-back baseline.

Sampled grant-floor restoration takes 0–1.011s; admission occupancy recovery
takes 1.007–17.144s, exceeding 15s in two seeds. A zero grant latency means
the floor was already present at the sampled demand mark. Neither measure
establishes physical KV reclamation or preemption by MoFlux. Batch goodput
attributes eventual completions to borrow-phase arrivals; it is not throughput
of completions timestamped within that phase.

Runtime: harness 0.49.0, Tyr 0.33.0, Latchflo 0.19.0, vLLM/vllm-metal
0.29.0, Apple M1 with 16 GiB on macOS 27.0, Qwen2.5-1.5B-Instruct revision
`989aa7980e4cf806f80c7fef2b1adb7bc71aa306`. The engine uses 320 KV blocks
of 16 tokens, max_num_seqs 4, max_model_len 4096, memory setting 0.4,
and prefix caching off. No generalization beyond this host, model and workload
is established.

`original-summary.json` preserves the source summary bytes; `provenance.json`
hashes all 156 original JSON files. Raw traces, client outcomes, telemetry
and diagnostics are retained byte-for-byte. Text process logs are omitted.
The top-level published summary adds promotion metadata without relabeling
the runtime or outcomes.
