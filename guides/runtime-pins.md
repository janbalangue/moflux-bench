# Runtime pins and comparison limits

Published results span multiple runtime cohorts. Read the
[recorded evidence catalog](../results/CATALOG.md), which distinguishes command
pins from historical runtime metadata and passes from negative results.
New licensed commands use Tyr 0.35.0/Latchflo 0.20.1; existing evidence retains
the versions that produced it. See [documented corrections](../results/CORRECTIONS.md).

All current licensed benchmark commands now default to Tyr 0.35.0 and Latchflo
0.20.1, including adaptive/headroom/coordinator sweeps, class/restoration,
membership, live OpenAI, Ollama, and vLLM. `demo:prepare` migrates standard local
image tags in the generated environment; custom registry references are preserved.
The benchmarked dependency versions are async-bulkhead-llm 3.18.0, which Tyr
0.34.1 adopted, and async-bulkhead-ts 1.0.1. No saved result is relabeled as a
new-runtime run.

Tyr 0.31.0 added attributable upstream transport failures. Tyr 0.32.0 relicensed Tyr
under Apache-2.0 and removed the deprecated `x-korrx-*` response headers and
`source: "korrx"` provenance, which this benchmark never reads. 0.33.0 adds
only a self-serve evaluation. Neither
changes admission policy or configuration.

Tyr 0.34.0 adds opt-in response memory for OpenAI Responses follow-ups, and
0.35.0 adds opt-in stopping of admitted requests. No benchmark config has a
`responsesState` or `stop` block, so neither is active. Tyr 0.35.0 also carries
two fixes that do reach these runs. A streamed request that fails before its
first chunk now gets a `502` or `504` status instead of a closed connection.
The progressive-reconciliation safety margin is now capped at a request's
output reservation, so a request whose output cap is below
`outputSafetyMarginTokens` holds fewer tokens while it runs. The vLLM and
Ollama contention workloads have such requests, so their in-flight, overrun and
refunded token counters are not comparable with Tyr 0.33.0 runs.

Latchflo 0.17.0 renews eligible independent-pool grants before expiry; 0.17.1
applies eligible class-floor lending immediately. Latchflo 0.18.0 extends
pre-expiry renewal to capacity groups, including the demand-aware adaptive
physical 28/4 group. When a reconcile finds the complete group plan unchanged,
it renews every member's lease in one transaction once any lease reaches half
its TTL. Renewal is skipped while a capacity or class handoff is prepared, so
lending and restoration still use the existing handoff/expiry paths. Immediate
class relaxation remains limited to independent pools. All three changes reduce
avoidable fail-closed gaps.

Latchflo 0.19.0 adds cancellation of obsolete prepared capacity-group loans and
restores safely available tokens before the concurrency drain finishes. These
changes make new runs a separate runtime cohort from 0.18.0. Replacement events
(`capacity_group.handoff_replaced`) are not ordinary committed handoffs; existing
proofs must not treat replacement publication alone as agent application or
backend resource reclamation.

Latchflo 0.20.0 prunes grant, handoff and event history, adopts unchanged
leases after a controller restart, and writes one `grant.applied` event per
acknowledgment instead of one per poll. No benchmark command restarts the
controller or reads `grant.applied` events. With fewer of those events, the
newest-1,000 `/v1/events` page reaches further back in time, so handoff
evidence is less likely to fall outside it than under 0.19.0. Runs on Tyr
0.35.0 and Latchflo 0.20.0 are a separate runtime cohort from 0.33.0/0.19.0.

Latchflo 0.19.0's recheck cancels a prepared capacity-group loan when the
lender's protection rises before commit. In `demo:hetero:adaptive` on 0.19.0
and 0.20.0, seed 4 prepared the same interactive-to-batch headroom loan three
times and canceled each one, and committed the batch floor at 36.3 to 36.4 s
against 29.1 to 30.7 s on 0.17.1 and 0.18.0. Neither sweep recorded headroom
lending, so both fail `--require-adaptive-proof`. Latchflo 0.20.1 changes the
cancellation: a plan that also restores a borrower's floor is staged again at
once with the lender held at its full guarantee, so the floor no longer waits
for a later rebalance. The loan is still canceled, so 0.20.1 is not expected to
make the headroom proof pass on this workload. No run has been made on 0.20.1;
its runs are a separate runtime cohort from 0.20.0.

A renewed lease carries a new grant ID, recorded as a `grant.renewed` controller
event. The restoration and headroom proofs follow grant IDs only through handoff
lineage. They are normally observed within seconds of a handoff, well before a
renewal at half the 120-second demand-aware TTL. A proof observed only under a
renewed grant is reported as unproven rather than credited.

Renewal needs sufficient TTL, polling, reconcile, and heartbeat headroom. It also
keeps more lease lifetime outstanding, so restoration that falls back to expiry
can take longer on average. Expect new renewal/relaxation audit events and more
revision activity. Fresh runs are required to measure performance; compare them
as a new runtime cohort against the preserved historical corpus.
Seed sweeps and the coordinator ladder record the MoFlux runtime and refuse to
aggregate seeds or rungs from different Tyr/Latchflo releases, so an older ladder
must be restarted rather than resumed.
