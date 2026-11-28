# The lending benchmark

A static split gives batch a permanent floor. While batch is idle that floor is
dead capacity: interactive cannot touch it and the provider runs below its
envelope for no reason. Two API keys with separate quotas have exactly this
shape and cost nothing to operate — so a capacity control plane that only
reproduces a static split is not worth deploying.

Lending is the claim that justifies one: while batch has no active work,
interactive borrows batch's reserved slots; when batch arrives, the floor comes
back. That is a temporal property, and **no cumulative counter can show it**. A
run-long peak-occupancy high-water mark of 32/32 is equally consistent with
"borrowed all four idle batch slots" and "sat at 28 until batch arrived, then
hit 32 together". Both policies produce the same headline number.

## Commands

```bash
npm run demo:lending           # focused demand-aware vs static 28/4 proof
npm run demo:handoff           # five-seed exact handoff proof
npm run demo:hetero:adaptive   # mixed-size, all-arm headroom-aware adaptive policy
npm run demo:hetero:headroom   # compatibility alias for the same headroom-aware workload
npm run demo:headroom:compare  # paired 28/4 policy comparison
npm run demo:headroom:compare:lend1  # the same comparison with a one-slot lend
```

`demo:handoff` is the shortest release-level proof for the current Latchflo 0.20.1 /
Tyr 0.35.0 physical-capacity handoff: five lognormal seeds, the exact classic `adaptive-28-4` profile,
and the full adaptive safety gate without spending time on the extra control
arms. Demand-aware runs use a 120-second steady-state grant TTL and do not start
load until the fleet has at least 55 seconds of grant runway remaining for the
default 45-second phase. The acknowledged drain + fresh occupancy + commit path therefore has ample
time to complete by attrition. Before every restrictive drain is ACKed, the
predecessor lease remains authoritative; after that ACK barrier, Latchflo 0.20.1
uses the prepared successor-grant expiry as the safety deadline. Natural source
lease expiry after the ACK barrier no longer invalidates restoration. This
removes the old 11-second lease-cycle timing dependency without weakening the
no-double-allocation proof.
`demo:hetero:adaptive` uses the headroom-aware `adaptive-headroom-28-4` variant
with the same 28/4 protected entitlements and proof gate while adding all control arms.
Its summary carries a top-level `headroomPolicy` object with the exact configured
thresholds/caps and exercised-seed evidence. Conflicting envelope, concurrency, or
token settings are rejected. `demo:lending` remains the focused static-partition scene.

## The workload

`--lending` widens the idle window from 35% to 60% of the phase so Tyr 0.35.0
can report an idle batch pool and Latchflo 0.20.1 can safely lend its protected
floor. The presenter creates a demand-aware capacity group with 28/4 protected
concurrency and 24,000/40,000-token guarantees, while both pools may borrow up
to the shared 32-slot/64,000-token envelope. The larger token envelope is
required because four current batch requests can reserve up to 39,768 tokens;
a 40,000-token group would make the four-slot floor nominal rather than usable.
The run is split at the configured batch arrival, not the observed first request, because an observed boundary
lands differently in each arm and makes the windows incomparable.

## Required evidence

The reference is a dedicated local `static-partition` arm with per-replica
interactive caps of 7/7/7/7 and a four-slot batch cap. It cannot exceed 28
interactive requests before batch arrives. The MoFlux arm is judged with controller events, independently sampled Tyr
admission/capacity state, provider-dispatch timestamps, and client-visible
response timing:

| Question | Required evidence |
|---|---|
| Did interactive borrow? | Idle-window occupancy above 28 **and** a Latchflo `capacity_group.lending_observed` event |
| Did the floor come back? | A Latchflo 0.20.1 restoration handoff commits **and** a post-lending Tyr `/stats` sample shows the full 4-slot / 40,000-token batch floor applied |
| Was transfer ordered safely? | `handoff_prepared` → the **first** `applied` ACK for every unique drain grant → `handoff_committed`; later duplicate ACKs are diagnostic only |
| Did the commit actually precede batch admission? | Tyr 0.35.0 exact admission provenance is scoped to the causal restoration handoff: only admissions at or after that handoff's `handoff_prepared` event and belonging to its predecessor/successor grant lineage are considered. The first relevant batch admission must use a staged successor grant ID. A lineage-matched predecessor admission is a proved violation; unrelated or pre-handoff admissions are ignored; dropped/capture-failed provenance is inconclusive. |
| Did handoff stay within its safety authority? | Before drain ACKs, the predecessor lease is authoritative; after every restrictive drain is ACKed, commit must occur before the prepared successor-grant deadline |
| Was capacity ever double allocated? | 500 ms Tyr `/stats` samples never exceed the 32-slot / 64,000-token physical envelope |
| How long did each stage take? | Reliable demand timing when available, drain → first complete unique-ACK barrier → commit → first data-plane-restored sample. The sampled first-admission interval remains a latency diagnostic; exact grant provenance supplies the ordering proof. Client response headers and completion are reported separately. |

Configuration is not proof. A run-long 32/32 peak can occur under a static
28/4 split after batch starts, and occupancy without a matching controller
event can be a measurement artifact. The exact-proof gate introduced in MoFlux Bench 0.23.0 therefore fails the
adaptive proof if the restoration handoff is missing, the unique drain-ACK
barrier is unordered, the full concurrency **and token** floor is not observed
at Tyr after lending, exact Tyr provenance is incomplete, the first measured
batch admission is not proven to use a staged successor grant, the handoff
reaches its safety deadline, or applied-capacity sampling cannot prove that the
envelope was never double allocated. The older sampled admission interval is
retained for latency analysis but is no longer the safety-ordering authority. A
policy that borrows but never restores the batch guarantee is starvation, not
lending.

## Admission timing and provenance

Version 0.21.0 corrects an important measurement error in earlier releases.
The load generator's first 2xx is **not** an admission timestamp: Tyr cannot
send those response headers until the provider has completed prefill and sent
its own headers. Client timing is therefore named `firstResponseHeadersAtMs`
and `responseHeadersGapMs`. MoFlux admission timing is reported as a bounded
interval using Tyr's sampled monotonic admitted counter and the provider's
model-scoped first request receipt. Seed aggregates expose
`batchFloorAdmissionGapMinMs` / `batchFloorAdmissionGapMaxMs` separately from
`batchFloorResponseHeadersGapMs`; completion remains
`batchFloorFirstSuccessGapMs`. The load generator also emits
`startedAtEpochMs`, allowing relative client timestamps to share the same
wall-clock timeline as Latchflo events.

Tyr 0.30.0 introduced the provenance that removes that ordering ambiguity for the safety gate. MoFlux Bench
0.23.0 establishes a per-replica admission-provenance sequence baseline before
load starts and retains each newly measured provenance event once. For a
restoration handoff, the benchmark first binds the proof to the handoff that
precedes the first data-plane-observed restoration of the protected batch
floor. It then reads that handoff's predecessor/successor grant lineage and
considers only lineage-matched admissions at or after `handoff_prepared`. This
prevents a later post-workload handoff from retroactively reclassifying earlier
valid batch admissions. The first relevant admission must name a staged
successor grant. `dropped` or `captureFailures` deltas make the proof
incomplete; they are never silently treated as success. The old 500 ms admitted
counter/provider-dispatch window remains in the result only as a timing bound.

## What a run writes

Each run is written below `results/runs/<sweep>/<run-id>/`; the seed summary
aggregates borrowed slots, controller proof, the complete handoff timeline,
lease time avoided, sampled applied-capacity safety, bounded batch admission,
response-header/completion gaps, batch service, and an explicit adaptive
pass/fail record. Reviewed
evidence is not overwritten. A failed `--require-adaptive-proof` run keeps its
summary and per-seed files but does not update the latest successful pointer.
Two implementation notes are load-bearing:

- Phase windows and each class's `latencyMs` and `ttftMs` percentiles are
  computed by the load generator from a record that is never pruned. The
  rolling `samples` array exists only for the Prometheus gauges and is trimmed
  to `windowMs` on every scrape. Deriving windows from it would lose the entire
  idle window on any run longer than 30 seconds and report zero idle goodput
  instead of failing. Until the summary declared `percentileScope: "run"`, the
  class percentiles did come from it: a 45-second sweep reported the p95 of
  its last 30 seconds before the final scrape, which excluded the idle phase
  and varied with scrape timing. On the blind adaptive sweep that exposed it,
  the reported interactive p95 was 3-35% above the whole-run value, and the
  median paired MoFlux-versus-baseline p95 change was -17.9% where the whole
  run gives -5.1%. Results without the field keep that basis. A sweep reports
  the scope it pooled, and a sweep or coordinator ladder refuses to mix the
  two.
- `idle + contended + drainCompleted` equals the class's total successes.
  Requests admitted before the offered-load window closes can complete after
  it; counting those in the contended window would inflate its goodput with
  work the window never offered, so they are reported separately and the split
  can be checked rather than trusted.

[Retry hints and adaptive capacity profiles](adaptive-capacity.md) covers
the profiles, the proof gate and the paired headroom comparison.
