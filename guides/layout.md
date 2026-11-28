# Repository layout

```
sim/provider-sim.mjs   simulated provider with the parameterized curve
sim/verify-sim.mjs     self-test: curve fidelity, backpressure, output distribution
load/verify-loadgen.mjs regression: dropped SSE stream is retried without crashing
demo/verify-telemetry-relay.mjs verifies retained baseline/MoFlux p99 and TTFT
sim/sweep.mjs          sweeps σ and κ, fails if any point leaves tolerance
arms/replica.mjs       one replica; --arm selects the admission policy
arms/redis-client.mjs  dependency-free RESP client
load/loadgen.mjs       open-loop multi-class generator
load/rejection-lib.mjs classifies zero-capacity-envelope (no live grant) refusals
load/diagnostics-lib.mjs credential redaction for retained diagnostics
demo/seed-sweep.mjs    canonical paired multi-seed presenter (Tyr + licensed Latchflo)
demo/seed-sweep-lib.mjs pure aggregation helpers
demo/present.mjs       verified single-pair presenter used by the sweep
demo/run-demo.mjs      full narrated public research walkthrough
demo/tenant-fairness.mjs authenticated admission-class arms and the restoration ladder
demo/local-inference.mjs unmetered self-hosted benchmark against a local Ollama server
demo/local-inference-lib.mjs locality guard, Ollama request body, per-arm aggregation
demo/local-contention.mjs unmetered workload-isolation benchmark under local contention
demo/local-contention-lib.mjs arm partitions, capacity invariants, localContentionProof
demo/LOCAL-CONTENTION.md contention benchmark: arms, phases, acceptance, claim boundary
demo/vllm-contention.mjs four-arm vLLM contention benchmark on CUDA or native Metal
demo/vllm-contention-lib.mjs vLLM policies, workload profiles, vllmSeedProof
demo/VLLM-CONTENTION.md vLLM benchmark: arms, validity gates, claim boundary
demo/vllm/            vLLM CUDA and Metal stacks with Latchflo and two Tyr arms
demo/diagnostics-lib.mjs saves logs, grants, events and Tyr stats before cleanup
demo/ollama/          local inference stacks: compatibility, and contention with Latchflo
demo/openai/          live OpenAI stacks for the compatibility and overload paths
demo/restoration-contract-lib.mjs Latchflo 0.20.1 per-resource restoration contracts
demo/restoration-enforceability-lib.mjs what a restoration mechanism guarantees, and its bill
demo/version-lib.mjs   shared runtime capability gating
demo/compose.yaml      telemetry relay + Prometheus + Grafana + Redis
demo/prometheus/       Prometheus scrape configuration
demo/grafana/          provisioned datasource and dashboard
scripts/replicate.sh   multi-seed runs
scripts/aggregate.mjs  medians and spread across seeds
guides/                topical documentation
results/               generated and curated run data
.github/workflows/     Node 22/24 verification in CI
```
