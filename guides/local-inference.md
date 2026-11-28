# Local inference with Ollama

The local inference benchmark is entirely self-hosted, unmetered, and needs no
API key:

```bash
npm run demo:local:dry-run   # prints the plan; sends nothing
npm run demo:local           # 8 direct + 8 Tyr requests against a local server
```

It starts an Ollama server and one Tyr in front of it from
`demo/ollama/compose.yaml`, pulls `qwen3:0.6b` into a named volume on first use,
and replays the same paired, alternating-order design as the OpenAI
compatibility path — so the two arms differ only by whether the request went
through the proxy. Override the weights with `--model=` or `MOFLUX_LOCAL_MODEL`;
anything the pool's `modelPrefixes` admits will do, and a bigger model changes
how long a run takes rather than what it measures.

Three things about this benchmark are worth stating plainly, because they are
what make it different from the hosted one rather than a cheaper version of it:

- **There is no spend guard, so there is a locality guard instead.** A
  self-hosted server has no price to compute a worst-case bill from. What
  replaces `--max-usd` is a check that `--direct-url` and `--moflux-url` both
  resolve to a loopback, private, or single-label address, applied before the
  first request and **not overridable by any flag**. Pointing this benchmark at
  a metered provider is refused rather than warned about; that run is
  `npm run demo:openai`, which enforces a cost ceiling.
- **The proxy and the model share the machine.** Against a hosted provider they
  contend for nothing. Here Tyr and the inference server compete for the same
  cores, so `deltas.latencyP50Ms` includes contention that no hosted run would
  ever show. That is the interesting part, and it is also why a local number
  must not be quoted as a general proxy-overhead figure.
- **The earliest pairs are warm-up, and the summary says so.** The first request
  after the stack starts pays to load the weights into memory, and Tyr's
  adaptive token estimator needs `minSamples` observations before it corrects
  its estimate. `caveats.warmupPairs` reports how many pairs that covers.
  Alternating arm order balances the effect across arms rather than removing it.

The pool in `demo/ollama/tyr.yaml` is pinned to `maxConcurrent: 1` to match
`OLLAMA_NUM_PARALLEL=1` in the compose file. An admission bound above the
server's real concurrency would be shedding against imaginary capacity. Like the
OpenAI compatibility path, this is **not** an overload benchmark. Workload-isolation
under local contention is measured by the separate 0.33.0 benchmark below.

## Local inference under contention

MoFlux Bench 0.33.0 added a second, separate local benchmark that *is* about
behavior under load; 0.33.1 corrected its phase attribution and proof
semantics, 0.33.2 fixed H4 attribution for borrowing backed by another class's
explicitly released capacity, and **0.34.0 makes the benchmark trustworthy
enough to decide whether the restoration policy needs changing**. None of them
changes the workload, the capacity policy, the SLO thresholds, the grant TTL, or
the seed count. `demo/local-contention.mjs` asks one question:

> When interactive and batch requests contend for the same self-hosted inference
> capacity, does MoFlux preserve interactive service while still letting batch
> traffic use otherwise-idle capacity?

```bash
npm run demo:local:contention:dry-run           # published-baseline design; sends nothing
npm run demo:local:contention:single            # one baseline seed, development
npm run demo:local:contention                   # five baseline seeds with --require-proof
npm run demo:local:contention:unlent:dry-run    # 0.36.0 native one-slot-reserve plan
npm run demo:local:contention:unlent:single     # one follow-up seed
npm run demo:local:contention:unlent            # five follow-up seeds with --require-proof
```

Three arms replay one immutable, five-phase trace against one Ollama container
serving one model: `direct` (no admission control, Ollama's own FIFO queue),
`static` (fixed per-class protected floors, never lent), and `moflux` (the same
nominal floors, with idle capacity lent and restored on demand). Both managed
arms retain the same 3/1 protected partition and maxConcurrent=4 class ceilings.
The static arm never lends. The MoFlux arm enables Latchflo's
`admissionClassDemandPolicy`; the native-unlent follow-up also marks one
interactive protected slot as allocation-enforced and never lendable.

0.36.0 upgrades the **separate one-slot-reserve follow-up profile** to Latchflo
0.16.0's native concurrency primitive. The protected floors remain
interactive=3 and batch=1 on a four-slot runtime, and both class ceilings remain
four. `globalUnlentProtectedConcurrent: 1` is sent on the interactive class only
in the lending arm. Latchflo may therefore release at most two of interactive's
three protected slots; the third never enters shared capacity. The follow-up
continues to write to `local-inference-contention-unlent-concurrency`, leaving
the published 0.34.0 baseline corpus untouched and making the enforcement
mechanism explicit in new 0.36.0 evidence.

The unmanaged direct arm retains the measurement rule introduced in 0.35.0: if requests
are still progressing when the absolute 300 s drain ceiling is reached, they are
recorded as **censored incomplete failures** instead of crashing the whole sweep.
They are never turned into latency samples or successful work. Their client
streams are aborted, then Ollama is force-recreated and warmed again before the
next arm so unfinished direct work cannot leak into a managed measurement. An
idle/no-progress drain still fails, and `static`/`moflux` still fail on either
drain bound.

The higher-resolution H4 proof introduced in 0.35.0 is retained unchanged.
Before measured load, each managed arm establishes a synchronous Tyr
`admission-provenance.v1` sequence baseline. Apparent borrow growth at a 250 ms
sampler boundary is cleared only when exact Tyr `admittedAt` provenance proves
the newly observed admission occurred before protected demand returned. Missing,
dropped, capture-failed, or non-unique provenance is reported as indeterminate
and fails the separate proof-completeness gate. For H4a the runner reads
Latchflo's full 1000-event window, correlates `admission_class.handoff_*` events
by `handoffId`, and requires the first ACK for every drain grant named by the
prepare event to precede commit. A truncated event window is likewise
indeterminate rather than silently safe or falsely unsafe.

The workload class is carried by signed identity rather than a client header,
and the trace contains a deliberate interval in which interactive demand is
absent — a control plane cannot lend a floor it never observes idle. That is why
`load/trace-lib.mjs` grew an optional second interactive arrival window
(trace version 3); without it every historical trace still hashes exactly as
before.

Its acceptance object is `localContentionProof` and the top-level `passed`
mirrors that and nothing else. Per seed it gates validity and safety only —
one trace across arms, warm-up excluded, measurable queueing in the control arm,
no unlent-floor/class/pool over-allocation, no new borrowing of a protected
floor after its owner has come back for it, and no unacknowledged handoff. Phase
membership is determined by immutable trace arrival time, not by when a slow
local decode finally completes. Across seeds it gates pre-registered
hypotheses: H1 requires at least +0.04 req/s of interactive contention-window
**SLO goodput** over unmanaged Ollama, where a useful request must succeed with
TTFT <= 5 s and completion latency <= 30 s; H2 requires at least 1.2x the static
arm's batch completions while interactive demand is idle; H3 requires the
protected floor never to be violated; **H4a** requires no unsafe capacity
transfer and **H4b** requires no new borrowing after protected demand returns.
Survivor-only TTFT/goodput remain descriptive and cannot by themselves make H1
pass. H1 and H2 can fail, and the harness tests exercise them failing.

### What 0.34.0 changed about the evidence

Every item here is instrumentation, benchmark semantics, or reliability. The
experiment is deliberately unchanged so the corrected instrumentation evaluates
the same thing.

- **A failed load-generator arm is now diagnosable after the process is gone.** Each local-contention arm persists stdout/stderr to `<arm>-seed-<n>.loadgen.log` beside its JSON output. A non-zero exit includes the bounded child-output tail plus the repo-relative log path in the benchmark error instead of reducing every failure to `exit 1`. The log header does not copy argv, because managed-arm argv contains identity credentials.
- **Demand transitions are first-class evidence.** Each managed arm's summary
  carries every observed demand-state change for both classes, plus a
  `demandReturn` timeline that reconciles three clocks — the immutable trace,
  the load generator's own reject/admission records, and the 250 ms `/stats`
  sampler — onto one origin via a measured `loadgenSkewMs`. From the summary
  alone a reader can now answer when interactive demand resumed at the
  generator, when Tyr first decided anything about it, when the benchmark marked
  the class active, whether its capacity was lent at that instant, how much the
  other class held, whether any new borrowing followed, and when restoration
  began. A deduplicated per-sample digest of the 50–70 s interval ships with it.
- **Restoration episodes are accounted correctly.** A restoration-required
  episode now means capacity was lent, its owner returned while it was still
  lent, and the controller therefore had something to restore. Demand return is
  detected from the controller's demand state and from *rejections*, not only
  from admissions — the previous rule was blind in exactly the case restoration
  exists for, because a class returning to a fully-borrowed pool is refused on
  every attempt and is never admitted. Passive returns (a lease rolling a floor
  back with nobody asking) are counted separately and are never reported as
  restorations. Each episode carries both `restorationLatencyMs` for the grant
  and `occupancyRestorationLatencyMs` for the moment the owner could actually
  use its floor; on a non-preemptive policy those differ by the borrowers'
  remaining decode and quoting only the first prices restoration at nothing.
- **Empty distributions are `null`, not `0`.** A window in which every request
  was rejected used to report `ttftP95Ms: 0`, which reads as the fastest window
  in the run. Counts and rates stay numeric — zero completions really is zero
  goodput — and ratios built from a missing distribution are `null`.
- **H4 is split.** `h4a` is capacity-transfer safety (no ceiling, pool or
  floor-sum over-allocation, no unlent-slice breach, no handoff committed
  without acknowledgement). `h4b` is timing (no new borrowing after protected
  demand returns, grandfathered borrowers may drain but a slot they give back
  may not be refilled, restoration-required episodes converge). An
  acknowledged-and-aborted-safe handoff is no longer described as unsafe because
  borrow growth happened at a suspect instant. `hypotheses.h4` remains as the
  conjunction for one release.
- **Post-demand borrowing is measured against the nominal partition.** Tyr's
  `borrowedConcurrent` is occupancy above a class's *applied* floor, and a class
  whose own floor has been lent away while idle reports its first legitimate
  request as borrowing. That produced a false H4 failure at 29.896 s on the
  0.33.2 seed 4, inside the phase in which batch is supposed to be using idle
  capacity. Encroachment is now occupancy above a class's own *nominal* floor,
  which is the only occupancy that can be coming out of another class's reserve.
- **Managed-arm warm-up authentication is diagnosable.** The identity fixture
  re-mints its JWTs on access as they approach expiry instead of minting once
  per process; a five-seed sweep runs for over an hour and 0.33.2's died in seed
  5 on an expired one-hour token. Every warm-up failure now records seed, arm,
  workload class, request index, attempt, HTTP status, a bounded response body,
  whether a token was present, its fingerprint, issue and expiry times, elapsed
  benchmark time, and whether credentials were refreshed for that attempt. A 401
  is retried exactly once behind a forced re-mint, and both attempts are
  recorded. Bearer tokens are never written to a summary.

Schema compatibility: `hypotheses.h4` and the seed-level
`safety.noBorrowGrowthAfterRestoration` key remain as aliases for one release.
Latency and TTFT percentile fields that previously read `0` on an empty window
now read `null`, which is a deliberate and breaking change to a misleading
value.

**This is a different corpus from the 0.32.0 compatibility result and does not
restate it.** `results/local-inference-compatibility.json` measures a proxy in
front of an *unsaturated* server, one request at a time, and its deltas are
explicitly not quotable. Read [`demo/LOCAL-CONTENTION.md`](../demo/LOCAL-CONTENTION.md) for the workload
parameters, the measured control-plane behavior the design is built around, and
the full list of claims this evidence may not be used to support — no GPU
preemption, no GPU utilization, no KV-cache reclamation, no scheduler
preemption, and no generalization from `qwen3:0.6b` on a CPU-only container.
