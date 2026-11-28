# vLLM contention: NVIDIA and Apple Silicon

MoFlux Bench 0.37.0 adds a separate four-arm experiment on one GPU-backed vLLM
server: direct FCFS, direct native priority, a rigid 3/1 protected admission
partition, and MoFlux lending with the same 3/1 nominal partition. All arms use
the same pinned vLLM image, immutable model commit, GPU and engine limits; the
runner recreates vLLM before each arm and rejects runtime-identity drift.
Apple Silicon is a separately named companion corpus: native vLLM Metal with
the same four-arm design, never treated as CUDA-equivalent evidence.

The backends intentionally use separate recorded workload profiles. NVIDIA's
`nvidia-decode-heavy-v1` sends 128-token interactive and 768-token batch work at
1/6 req/s. Metal's `metal-balanced-v1` sends 16-token interactive and 32-token
batch work at 0.25/0.75 req/s, with interactive demand returning at 0.5 req/s.
This keeps the mechanism transition measurable on an M1 instead of building a
400-request queue from CUDA-sized work. Both profiles still require observed
vLLM queueing; a host too fast to contend is inconclusive.

## Commands

```bash
npm run demo:vllm:dry-run
npm run demo:vllm:doctor
npm run demo:vllm:single
npm run demo:vllm

# Apple Silicon / macOS 15+ after installing vLLM Metal
npm run demo:vllm:metal:dry-run
npm run demo:vllm:metal:doctor  # prerequisites/capabilities only; no inference
npm run demo:vllm:metal:single
npm run demo:vllm:metal

# Apple Silicon with a pinned KV pool that long batch requests fill
npm run demo:vllm:metal:long-context:dry-run
npm run demo:vllm:metal:long-context:single
npm run demo:vllm:metal:long-context

# The same long-context run with two interactive slots unlent instead of one
npm run demo:vllm:metal:long-context:unlent2:dry-run
npm run demo:vllm:metal:long-context:unlent2:single
npm run demo:vllm:metal:long-context:unlent2
```

The `unlent2` commands select the `unlent-concurrency-2` policy profile. The
MoFlux arm lends one of its three protected interactive slots instead of two,
and everything else about the long-context experiment is unchanged. It tests
whether the published one-slot reserve is too small, after the long-context
repeat failed H2 against native priority. Results go to their own corpus,
`results/runs/vllm-metal-long-context-unlent-concurrency-2/`. Two reviewed
five-seed sweeps, recorded at harness 0.46.0 and 0.47.1, pass their configured
gates; H2's median sits exactly on the -0.04 req/s margin in both.
See the [catalog](../results/CATALOG.md) for the separate evidence paths.

## Measurement and validity

The harness measures client SLO goodput and TTFT alongside vLLM queue/running
occupancy, KV-cache usage, preemptions, TTFT/ITL and queue/prefill/decode timing,
plus host GPU utilization, memory, power and temperature on NVIDIA. Metal
records native vLLM process-tree CPU/RSS instead; it does not relabel those as
GPU utilization. A run with no observed vLLM queue, or with zero interactive
contention-window SLO goodput in both direct arms, is inconclusive. Equality at
zero cannot pass a performance hypothesis. MoFlux restoration remains an
admission-grant claim; GPU work or KV-cache reclamation is explicitly not
claimed.

Metal scrapes vLLM and managed admission state every second and samples the
native process tree asynchronously every five seconds. NVIDIA retains 250 ms
vLLM scrapes and one-second GPU samples. Both backends use the same
65,536-token admission envelope, fully reserved by the 49,152/16,384 protected
token floors. A run is invalid if any admission is token-budget-limited. Compact
class summaries retain the observed requested/available/budget ranges and exact
global state for each token refusal; the critical-window digest retains token
grants and occupancy, so that failure is diagnosable rather than waived.

A refusal made with a zero capacity envelope is not token pressure, even when
Tyr reports `budget_limit`. It is Tyr's fail-closed state between Latchflo
grants. The load generator and summaries report it as `grantUnavailable`,
outside the token and concurrency counts, and the `managedGrantContinuity` gate
makes it invalidate the seed. This experiment pins Latchflo 0.20.1, which
renews live leases before they expire and commits idle-floor lending without
waiting for expiry. It also pins Tyr 0.35.0, whose 502 responses name the
transport cause. All current benchmark commands now share Latchflo 0.20.1 and
Tyr 0.35.0 defaults. Saved results retain their originally recorded runtimes. Metal arms also report host memory pressure, swap and
thermal state as `hostPressure`. The `hostMemoryHeadroom` gate makes a seed
inconclusive if any arm hit critical pressure, swapped out more than 256 MiB,
or lost its pressure samples. vLLM's `--gpu-memory-utilization` defaults to 0.4
on Metal, down from 0.85, so its KV reservation leaves room for macOS and
Docker's VM on a 16 GB Mac. CUDA keeps 0.85.

CUDA fixed-output requests send `ignore_eos` and `min_tokens=max_tokens`.
vLLM Metal 0.29.0 rejects `min_tokens`, so the Metal path intentionally sends
`ignore_eos` plus `max_tokens` without that field. Unexpected HTTP responses,
structured errors inside a 200 SSE stream, missing terminal frames, empty
fixed-output streams, zero token totals, or unpopulated vLLM request histograms
all invalidate the seed instead of being counted as fast successful inference.
Its ephemeral local API key is passed as one `--api-key=<value>` token so a
leading base64url `-` can never be mistaken for another vLLM option.
For authenticated model downloads, export the current `HF_TOKEN` variable;
`HUGGING_FACE_HUB_TOKEN` remains accepted as a compatibility alias. Registry
credentials are never sent to the inference endpoint or written to evidence.

No command writes reviewed vLLM evidence. New output is confined to
`results/runs/vllm-contention/<run-id>/`, and an existing run directory is
refused. Metal uses `results/runs/vllm-metal-contention/<run-id>/` and a separate
reviewed target. See [`demo/VLLM-CONTENTION.md`](../demo/VLLM-CONTENTION.md) for the exact
matrix, workload, telemetry contract, acceptance gates, and publication path.

## Grant-to-backend availability experiment (0.47.0)

The opt-in [backend availability experiment](../demo/BACKEND-AVAILABILITY.md) correlates
grant restoration with request-level scheduler service under sustained KV pressure.
It retains timing bounds, tail percentiles, empirical CDFs, failures and censoring.
Start with `npm run demo:vllm:metal:availability:dry-run`.

## Protected burst recovery experiment

The [preregistered paired experiment](../demo/BURST-RECOVERY.md) tests current
MoFlux with one never-lent interactive slot and two batch borrowers. Two
protected requests return together, followed by sustained traffic from both
classes. Short/long variants change only the two designated borrowers' output caps; exact
admission records and scheduler IDs distinguish draining from fresh borrowing.

```sh
npm run demo:vllm:metal:burst-recovery:dry-run
npm run demo:vllm:metal:burst-recovery:pilot
npm run demo:vllm:metal:burst-recovery
```

The current protocol is `burst-recovery-v4` (MoFlux Bench 0.52.0). Its trace
is byte-identical to v3 (MoFlux Bench 0.51.0): v2's short prime and staggered
setup, and 90s of
sustained post-return arrivals to observe long-borrower draining. V4 changes
start conditions and measurement only. Each trial first passes a 180s clock
preflight and a host memory preflight. Clock validity uses paired wall and
monotonic readings with bracketed container alignment; gradual drift within
100ppm is allowed, jumps are not, and a 10ms budget widens every reported
bracket. Setup readiness is observed explicitly before setup request 1, with
arrivals fixed. See the [v4 amendment](../demo/BURST-RECOVERY.md#final-v3-pilot-and-v4-amendment).
Historical v1–v3 runs remain readable with their original trace, horizon and gates.
The first v4 pilot `20261004T185842Z` is invalid: the host preflight stopped
short at `warn` memory pressure, and long swapped 1353 MiB during its trace.
Run a valid v4 instrumentation pilot before the default alternating five-pair sweep;
non-pilot runs require at least five seeds. Invalid, negative and censored trials
are retained under `results/runs/vllm-metal-burst-recovery/`.

The repeat v2 pilot passed all validity gates in both trials and recorded no new
borrowing after return, but the long trial did not drain within 40s. Both trials
completed 14/41 interactive requests; SLO successes were 12/41 and 14/41. This
pilot does not establish a general performance effect. Report protected-limit
restoration, borrower draining and interactive SLO outcomes separately; see the
[protocol amendment](../demo/BURST-RECOVERY.md#successful-v2-pilot-and-v3-amendment).
The latest v3 seed-3 pilot `20261003T201440Z` is invalid: both trials fail
clock stability, and long also has telemetry gaps above 750ms. There are zero
valid matched pairs and no formal paired estimates. It records no fresh borrowed
batch admissions after return. Descriptively, short completes 38/91 interactive
requests and long 31/91; SLO successes are 30/91 and 29/91. Short still rejects
40/75 requests sent after sampled accounting zero. These observations do not
establish a general performance effect or a service-recovery timestamp.

Diagnostics report clock drift and residual ranges, outcomes after accounting
zero, completion of the original borrowers, KV saturation samples, preemption
counters and scheduler transitions. They preserve the existing validity gates
and distinguish accounting from continuing engine work. Diagnose the timing and
sampling failures, obtain a valid v3 pilot, then run the five-pair sweep; see the
[latest pilot record](../demo/BURST-RECOVERY.md#latest-v3-pilot-and-descriptive-diagnostics).
Clock fits are about 30ppm: over roughly 170s of backend capture this accumulates
about 5.1ms, already beyond the existing 5ms raw-range limit. Any measurement
revision must be preregistered and versioned before new collection; fitted
residuals do not validate these failed pilots. Long also has 1.108s and 1.134s
telemetry gaps above the 750ms limit.
No results from this experiment have been published.
