# Published evidence catalog

Generated from recorded evidence by `npm run evidence:catalog`; verify with `npm run verify:catalog`.

Top-level and `curated/` locations have the same reviewed status. Existing paths are preserved for citations; new publications use `published/<experiment>/<profile>/<UTC-run-id>/`. See [organization and corrections](CORRECTIONS.md).

Dates below are the summary's recorded `generatedAt` in UTC, not inferred run start or release dates. Seed counts come from the recorded design. A pass is specific to the named proof contract; it does not remove the listed limitations. Missing metadata stays missing. Metal results establish no MoFlux physical KV/GPU reclamation or CUDA generalization.

## Simulation

| Evidence | UTC date | Seeds | Policy / protocol | Recorded outcome | Limits |
| --- | --- | ---: | --- | --- | --- |
| [video-seed-sweep](video-seed-sweep.json) | 2026-08-26 | 8 | adaptive-28-4 | adaptive mechanism proof pass | Eight-seed adaptive corpus; simulator-only evidence. |
| [headroom workload](curated/video-seed-sweep-v0.40.1-20260923T210051Z.json) | 2026-09-23 | 5 | adaptive-headroom-28-4 | adaptive mechanism proof pass | Separate runtime cohort and headroom policy. |
| [adaptive control](curated/moflux-seed-sweep-v0.44.0-20260924T225251Z-adaptive.json) | 2026-09-24 | 5 | adaptive-28-4 | adaptive mechanism proof pass | Input sweep for the paired headroom comparison. |
| [one-slot headroom](curated/moflux-seed-sweep-v0.44.0-20260924T225251Z-headroom-lend1.json) | 2026-09-24 | 5 | adaptive-headroom-28-4-lend1 | adaptive mechanism proof pass | Input sweep; passing mechanism proof does not establish the paired performance result. |
| [paired headroom comparison](curated/headroom-policy-comparison-v0.44.0-20260924T225251Z-lend1.json) | 2026-09-24 | 5 | adaptive-28-4 vs adaptive-headroom-28-4-lend1 | acceptance fail | Fails batch-payoff and interactive-p95 checks; see curated notes. |
| [historical fragmented batch floor](curated/negative-fragmented-batch-floor/aggregate.json) | 2026-07-31 | 5 | see source configuration | modern verdict not recorded | Historical negative case; no modern proof contract or immutable trace corpus. |

## Hosted provider

| Evidence | UTC date | Seeds | Policy / protocol | Recorded outcome | Limits |
| --- | --- | ---: | --- | --- | --- |
| [hosted compatibility](openai-live-compatibility.json) | 2026-08-28 | not recorded | see source configuration | acceptance pass | Compatibility only; does not establish overload efficacy. |
| [eight-seed overload](openai-live-overload-8-seed.json) | 2026-08-31 | 8 | see source configuration | provider overload conclusive | Provider-pressure workload; does not exercise fleet coordination or token-budget admission. |

## Local admission

| Evidence | UTC date | Seeds | Policy / protocol | Recorded outcome | Limits |
| --- | --- | ---: | --- | --- | --- |
| [local compatibility](local-inference-compatibility.json) | 2026-09-03 | not recorded | see source configuration | acceptance pass | Compatibility only; warm-up/order artifacts prevent proxy-overhead claims. |
| [tenant fairness](tenant-fairness.json) | 2026-09-03 | 5 | see source configuration | recorded pass flag true | Class admission/lending proof, distinct from local inference contention. |
| [contention baseline](local-inference-contention.json) | 2026-09-04 | 5 | see source configuration | local contention proof fail | Negative result: H1 interactive SLO goodput fails. |
| [one-slot reserve (0.35.0)](local-inference-contention-unlent-concurrency.json) | 2026-09-09 | 5 | see source configuration | local contention proof pass | Pre-native reserve follow-up; separate from 0.36.0 enforcement. |
| [native one-slot reserve (0.36.0)](local-inference-contention-unlent-concurrency-v0.36.0.json) | 2026-09-11 | 5 | see source configuration | local contention proof pass | Native reserve follow-up; do not relabel the older corpus. |

## vLLM Metal

| Evidence | UTC date | Seeds | Policy / protocol | Recorded outcome | Limits |
| --- | --- | ---: | --- | --- | --- |
| [balanced workload](vllm-metal-contention.json) | 2026-09-23 | 5 | see source configuration | valid; H1–H5 pass | Unpinned KV corpus; does not establish KV-pressure behavior. |
| [long context, first run](curated/vllm-metal-long-context/20260925T001105Z.json) | 2026-09-25 | 5 | see source configuration | valid; H1–H5 pass | First pass was not reliably reproduced; read with the failed repeat. |
| [long context, repeat](curated/vllm-metal-long-context/20260925T164229Z.json) | 2026-09-25 | 5 | see source configuration | valid; H1–H5 fail | Valid negative H2 result; recorded macOS differs from the first run. |
| [two-slot reserve, first run](vllm-metal-long-context-unlent-concurrency-2.json) | 2026-09-26 | 5 | unlent-concurrency-2 | valid; H1–H5 pass | H2 median sits exactly on its -0.04 req/s margin. |
| [two-slot reserve, repeat](vllm-metal-long-context-unlent-concurrency-2-v0.47.1.json) | 2026-09-27 | 5 | unlent-concurrency-2 | valid; H1–H5 pass | H2 median again sits on its margin; descriptive five-seed checks. |
| [admission boundary 8](vllm-metal-long-context-admission-8-unlent-2.json) | 2026-09-28 | 5 | admission-8-unlent-2 | valid; H1–H5 pass | Queue manipulation passes 5/5; paired boundary-4 baseline is missing. |
| [availability v2 control](curated/vllm-metal-backend-availability/fixed-burst-v2-20260928T041426Z.json) | 2026-09-28 | 5 | fixed-burst-v2 | valid; H1–H5 pass; availability distribution fail; overall passed=false | No observed post-restoration episodes; four served before restoration, one inconclusive. |
| [availability v3](curated/vllm-metal-backend-availability/fixed-burst-v3-20260928T032816Z.json) | 2026-09-28 | 5 | fixed-burst-v3 | valid; H1–H5 fail; availability distribution fail; overall passed=false | Valid negative H2 result; only 5/30 availability observations. |

## Runtime and provenance

Recorded summary metadata is listed here. When a summary lacks runtime metadata but references raw MoFlux arms, their recorded services are shown explicitly as arm-level evidence. Missing harness versions are not inferred from filenames. Older corpora without hash manifests remain historical evidence with that limitation.

| Evidence | Recorded services | Source manifest |
| --- | --- | --- |
| [video-seed-sweep](video-seed-sweep.json) | summary runtime not recorded; 8 raw MoFlux arms: Tyr 0.27.0; Latchflo 0.12.4; async-bulkhead-llm 3.16.0; async-bulkhead-ts 1.0.1 | source hash manifest not recorded |
| [headroom workload](curated/video-seed-sweep-v0.40.1-20260923T210051Z.json) | Tyr 0.31.0; Latchflo 0.17.1; async-bulkhead-llm 3.17.0; async-bulkhead-ts 1.0.1 | source hash manifest not recorded |
| [adaptive control](curated/moflux-seed-sweep-v0.44.0-20260924T225251Z-adaptive.json) | Tyr 0.33.0; Latchflo 0.19.0; async-bulkhead-llm 3.17.0; async-bulkhead-ts 1.0.1 | source hash manifest not recorded |
| [one-slot headroom](curated/moflux-seed-sweep-v0.44.0-20260924T225251Z-headroom-lend1.json) | Tyr 0.33.0; Latchflo 0.19.0; async-bulkhead-llm 3.17.0; async-bulkhead-ts 1.0.1 | source hash manifest not recorded |
| [paired headroom comparison](curated/headroom-policy-comparison-v0.44.0-20260924T225251Z-lend1.json) | not recorded in summary | source hash manifest not recorded |
| [historical fragmented batch floor](curated/negative-fragmented-batch-floor/aggregate.json) | not recorded in summary | source hash manifest not recorded |
| [hosted compatibility](openai-live-compatibility.json) | Tyr 0.28.0 | source hash manifest not recorded |
| [eight-seed overload](openai-live-overload-8-seed.json) | Tyr 0.29.0 | source hash manifest not recorded |
| [local compatibility](local-inference-compatibility.json) | Tyr 0.30.0; Ollama 0.12.3 | source hash manifest not recorded |
| [tenant fairness](tenant-fairness.json) | Tyr 0.30.0; Latchflo 0.15.0; async-bulkhead-llm 3.17.0; async-bulkhead-ts 1.0.1 | source hash manifest not recorded |
| [contention baseline](local-inference-contention.json) | harness 0.34.0; Tyr 0.30.0; Latchflo 0.15.0; Ollama 0.12.3; async-bulkhead-llm 3.17.0; async-bulkhead-ts 1.0.1 | source hash manifest not recorded |
| [one-slot reserve (0.35.0)](local-inference-contention-unlent-concurrency.json) | harness 0.35.0; Tyr 0.30.0; Latchflo 0.15.0; Ollama 0.12.3; async-bulkhead-llm 3.17.0; async-bulkhead-ts 1.0.1 | source hash manifest not recorded |
| [native one-slot reserve (0.36.0)](local-inference-contention-unlent-concurrency-v0.36.0.json) | harness 0.36.0; Tyr 0.30.0; Latchflo 0.16.0; Ollama 0.12.3; async-bulkhead-llm 3.17.0; async-bulkhead-ts 1.0.1 | source hash manifest not recorded |
| [balanced workload](vllm-metal-contention.json) | harness 0.39.0; Tyr 0.31.0; Latchflo 0.17.1; vLLM 0.29.0; vllm-metal 0.29.0 | source hash manifest not recorded |
| [long context, first run](curated/vllm-metal-long-context/20260925T001105Z.json) | harness 0.45.0; Tyr 0.33.0; Latchflo 0.19.0; vLLM 0.29.0; vllm-metal 0.29.0 | [156 source hashes](curated/vllm-metal-long-context/20260925T001105Z/provenance.json) |
| [long context, repeat](curated/vllm-metal-long-context/20260925T164229Z.json) | harness 0.45.1; Tyr 0.33.0; Latchflo 0.19.0; vLLM 0.29.0; vllm-metal 0.29.0 | [156 source hashes](curated/vllm-metal-long-context/20260925T164229Z/provenance.json) |
| [two-slot reserve, first run](vllm-metal-long-context-unlent-concurrency-2.json) | harness 0.46.0; Tyr 0.33.0; Latchflo 0.19.0; vLLM 0.29.0; vllm-metal 0.29.0 | source hash manifest not recorded |
| [two-slot reserve, repeat](vllm-metal-long-context-unlent-concurrency-2-v0.47.1.json) | harness 0.47.1; Tyr 0.33.0; Latchflo 0.19.0; vLLM 0.29.0; vllm-metal 0.29.0 | source hash manifest not recorded |
| [admission boundary 8](vllm-metal-long-context-admission-8-unlent-2.json) | harness 0.49.0; Tyr 0.33.0; Latchflo 0.19.0; vLLM 0.29.0; vllm-metal 0.29.0 | [156 source hashes](vllm-metal-long-context-admission-8-unlent-2/provenance.json) |
| [availability v2 control](curated/vllm-metal-backend-availability/fixed-burst-v2-20260928T041426Z.json) | harness 0.49.0; Tyr 0.33.0; Latchflo 0.19.0; vLLM 0.29.0; vllm-metal 0.29.0 | [177 source hashes](curated/vllm-metal-backend-availability/fixed-burst-v2-20260928T041426Z/provenance.json) |
| [availability v3](curated/vllm-metal-backend-availability/fixed-burst-v3-20260928T032816Z.json) | harness 0.49.0; Tyr 0.33.0; Latchflo 0.19.0; vLLM 0.29.0; vllm-metal 0.29.0 | [177 source hashes](curated/vllm-metal-backend-availability/fixed-burst-v3-20260928T032816Z/provenance.json) |

## Reserved and generated paths

`results/vllm-contention.json` is reserved for reviewed CUDA evidence and is currently absent. Reserved paths are not published results. `results/runs/` and `results/replicates/` contain generated work, not cataloged reviewed claims.
