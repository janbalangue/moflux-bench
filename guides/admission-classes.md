# Authenticated admission classes

The four-arm admission-class benchmark introduced in MoFlux Bench 0.16.0 and
upgraded in 0.18.0 now runs against **Tyr 0.35.0** and **Latchflo 0.20.1**. Every seed replays the same immutable
trace through equal 32-request / 64,000-token physical pools:

- `sim-shared` applies only the fleet-wide pool envelope.
- `sim-ceilings` classifies traffic and applies 8/24 premium/noisy concurrency
  ceilings, but reserves no class capacity.
- `sim-protected` keeps those ceilings and adds static fleet-wide floors: premium
  gets 4 concurrent / 8,000 tokens; noisy gets 4 concurrent / 36,000 tokens.
- `sim-adaptive` uses the same nominal floors and ceilings but enables Latchflo
  0.11.0 demand-aware class-floor lending from Tyr 0.35.0 per-class heartbeats.

Noisy traffic starts five seconds after premium traffic. All four arms now use
the same 240-second steady lease. Each seed starts from a fresh Latchflo/Tyr
control-plane state so a restored 240-second grant from an earlier seed cannot
prevent the next seed from exercising idle-floor lending. Before the adaptive
trace begins, the runner explicitly waits until the quiet noisy floor is proven
lent. The adaptive arm keeps a 1-second idle threshold and relies on Tyr 0.35.0
plus Latchflo 0.20.1's acknowledged class handoff to restore that floor before
the lent lease expires. (The 0.12.0 successor-authority change applies to physical
capacity-group handoffs; class-only handoffs retain their predecessor-lease proof.) After workload sampling ends, the runner keeps a bounded
15-second synchronization window and actively reconciles until Tyr has actually
applied the restored floor; a Latchflo handoff commit alone is not treated as
data-plane restoration. The benchmark no longer shortens the adaptive TTL to
make restoration observable.

Two ephemeral RS256 identities drive the workloads. Tyr maps the premium tenant
to `premium`; the noisy worker uses the fixed default class. Latchflo receives
only bounded class demand and numeric limits for fixed class IDs, not caller
identity. Generated keys, JWTs, and the local CA are deleted after the run.

```bash
npm run demo:classes         # five four-arm seeds with the proof gate
npm run demo:classes:single  # one diagnostic seed
npm run demo:classes:doctor  # prerequisites only
```

The proof gate requires matching trace hashes, zero provider 429s, correct class
attribution, bounded shedding, premium and noisy service under contention, and
at least four noisy completions in the adaptive arm. It also samples both
Latchflo and Tyr during the adaptive arm and requires: the noisy nominal floor
was actually lent, its 24-concurrent / 64,000-token hard ceilings stayed intact,
noisy demand appeared after lending, Tyr later applied the restored
4-concurrent / 36,000-token floor, and Latchflo recorded a class handoff whose
drain grants were acknowledged and committed before the source lease expired.

Success rate, goodput, TTFT, and restoration latency are reported outcomes, not
acceptance thresholds. The benchmark therefore tests whether adaptive floors are
work-conserving without assuming in advance that they must beat static floors on
every performance metric. See [`demo/TENANT-FAIRNESS.md`](../demo/TENANT-FAIRNESS.md) for the exact policy,
lease semantics, security model, proof contract, and schema-version-4 output.

## Restoration enforceability ladder

Every capacity control plane in this space says "protected floor". The question
that decides whether one is worth deploying is what happens at the moment the
floor is demanded back while a borrower is still holding it. MoFlux Bench 0.31.0
adds two arms that make the three possible answers distinguishable, using
Latchflo 0.20.1's per-resource restoration contracts and Tyr 0.35.0's bounded
borrowed-slot deadline:

```bash
npm run demo:restoration          # five seeds, ladder arms plus the existing four
npm run demo:restoration:single   # one seed
```

The arms replay the same trace as `sim-adaptive` through pools whose numeric
floors are identical, so the release mechanism is the only variable:

| Arm | Admission slots | Upstream tokens | What it can honestly claim |
|---|---|---|---|
| `sim-adaptive` | `lease_safe_handoff` | `non_preemptive` | Both are wall-clock objectives. The floor returns when the borrower finishes. |
| `sim-unlent` | `lease_safe_handoff` | `unlent_floor` | Half of each protected token floor is allocation-enforced: Latchflo never lends it, so it needs no reclamation. |
| `sim-deadline` | `deadline_abandonment` | `unlent_floor` | The above, plus Tyr bounds how long any borrowed slot may be held at all. |

Three things this benchmark is careful about, because each is easy to overstate:

**The deadline is unconditional.** Measured directly against
`tyr-admission-controller:0.31.0` (0.32.0 and 0.33.0 made no admission change; not remeasured on 0.35.0):
a borrowed request is abandoned `deadlineMs`
after admission even with zero contention and nothing waiting on the floor. It
bounds how long a borrowed slot may be held, *not* how long it may be held after
the owner asks for it back. That is precisely what makes the owner's worst-case
wait enforceable, and it means the bill is paid by every borrower that
legitimately runs longer than the deadline, needed or not. `deadlineMs` is a
workload parameter, not a safety margin; a rising `releasedByCause.deadline`
share in Tyr's `/stats` is the signal that it was set too tight.

**Enforced restoration is never free, so it is always reported with its bill.**
An enforced slot is bought with a shed request; an unlent token floor is bought
with capacity no borrower could use for the entire idle window. A mechanism that
restores instantly by never lending anything has not beaten lending — it has
declined to lend, and the benchmark refuses a configuration whose unlent floors
cover the whole guarantee for exactly that reason.

**No configuration here reclaims upstream tokens.** Nothing in this stack can
make a provider forget an in-flight request. Tyr sends an abort signal and
reports the outcome as `unverified`; `unlent_floor` withholds a slice *before*
lending, which is strictly weaker than reclamation. Every summary carries
`upstreamReclamation: "not-claimed"`, and the analysis raises rather than
summarizing a response that claims otherwise.

One further finding worth knowing before reading a deadline result: the
abandonment has two client-visible shapes. Tyr can only write its clean
`504 borrowed_admission_deadline` while it still owns the response; once a stream
has begun it destroys the connection instead. On this benchmark's canonical
streaming workload the caller therefore usually gets a truncated body with no
error at all, so the summary reports `byOutcome` and `silentTruncationRate`
rather than one total.

That last point is measured, not predicted. On a single-seed run against the
licensed stack, Tyr released 26 borrowed slots to the deadline and all 26
reached the caller as destroyed streams — `silentTruncationRate` 1.0, not one
clean `504`. Against the same trace the deadline arm completed 40 of 89 premium
requests where the otherwise-identical unlent arm completed 58. The bounded
restoration is real, and so is its bill.

**No multi-seed ladder result is published yet.** 0.31.0 ships the arms, the
analysis, and the end-to-end evidence above that the mechanisms behave as
described — not a statistical claim about what they are worth. One seed at one
duration is a mechanism check. Treat `--restoration-ladder` as a measurement you
can now take, not one already taken.
