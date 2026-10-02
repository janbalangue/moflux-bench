# Evidence organization and correction record

## 2026-10-02

The source-derived [catalog](CATALOG.md) is the entry point for all published
summaries. It replaces directory names and historical release prose as the
way to discover a result's recorded date, seed count, runtime and outcome.
Dates are summary generation dates in UTC, not reconstructed run starts.

### Documentation corrections

| Previous description | Corrected description and source |
| --- | --- |
| `video-seed-sweep` was described as the original five-seed 0.10.0 corpus using Tyr 0.17.0/Latchflo 0.5.1. | Its current [summary](video-seed-sweep.json) records eight seeds and adaptive-28-4; its eight raw MoFlux arms record Tyr 0.27.0, Latchflo 0.12.4 and async-bulkhead-llm 3.16.0. The summary itself has no runtime field. |
| Local contention was described as intentionally absent. | The [0.34.0 baseline](local-inference-contention.json) is present and fails H1; its separate 0.35.0 and 0.36.0 reserve follow-ups pass their recorded proof. |
| No two-slot vLLM reserve sweep had been run. | The [0.46.0 run](vllm-metal-long-context-unlent-concurrency-2.json) and [0.47.1 repeat](vllm-metal-long-context-unlent-concurrency-2-v0.47.1.json) are published separately. Both pass, with H2 exactly on its median margin. |
| Latchflo 0.15.0 or 0.16.0 and Tyr 0.30.0 were called current runtime pins. | Licensed command defaults are Tyr 0.33.0/Latchflo 0.19.0. Historical summaries retain their recorded runtimes; current pins are not assigned to old evidence. |
| Curated evidence was described as historical, while current reviewed results were said to live only at the top level. | Both legacy locations contain reviewed evidence, including recent results. Neither location implies a pass, stronger reproducibility or a different review level. |
| Public replication output was said to live under `replicates/`. | `scripts/replicate.sh` writes to `results/replicates/`. This generated output is distinct from reviewed corpora. |
| The standard publisher omitted scheduler JSONL. | JSONL is now included with JSON/YAML evidence. The availability v2/v3 publication already preserved all scheduler files explicitly; no old raw files were rewritten. |

The repository README, results README, curated index and `.gitignore` comments
are updated accordingly. This corrects descriptions of the currently committed
artifacts; it does not infer when an earlier replacement occurred or establish
a missing causal result.

### Stable citations and new publication layout

Existing top-level and curated paths remain stable. Their names mix versions,
policies and timestamps because they were published under earlier conventions.
The catalog resolves them to their recorded sources. No old summary, raw JSON,
scheduler JSONL, runtime field, verdict or provenance manifest is moved or edited
by this correction.

New publications use this supported layout:

```text
results/published/<experiment>/<profile>/<UTC-run-id>/
  summary.json
  original-summary.json
  provenance.json
  raw/
    trace-seed-N.json
    <arm>-seed-N.json
    <arm>-telemetry-seed-N.json
    backend-events-*.jsonl
    diagnostics/
```

Add a `README.md` at the run or experiment level with methodology, limitations
and related controls. The publisher preserves original source bytes and
generates SHA-256 hashes for every copied JSON/YAML/JSONL file and the source
summary. Text process logs are excluded. It retargets published summary pointers
to `raw/` and refuses an existing target without explicit `--force`.

```sh
npm run evidence:publish -- \
  --run=results/runs/<sweep>/<run-id> \
  --experiment=<experiment> --profile=<profile> --as=<run-id>
npm run evidence:catalog
npm run verify:catalog
```

Experiment and profile are path components, and `--as` is the UTC run ID
`YYYYMMDDTHHMMSSZ`. Supplying neither namespace flag retains the legacy
promotion behavior for existing citation targets. The complete `published/`
tree is protected as reviewed evidence, just like `curated/`.

### Outcome and provenance semantics

The catalog names the original proof contract rather than inventing a universal
pass flag. Availability v2 passes contention H1–H5 while its separate distribution
gate and top-level `passed` are false. v3 is valid but fails H2 and the distribution
gate. Boundary-8 passes its recorded proof, but the preregistered paired boundary-4
baseline remains missing. A catalog entry is not an endorsement of broader claims.

Older evidence without a source hash manifest remains explicitly labeled as
such. No manifest is backdated or represented as proof of original capture.
Existing `originalJsonSha256` manifests and newer `sha256` manifests are both
recognized. Missing summary runtime metadata stays missing even when arm-level
metadata is available.

### Verification

`verify:publication` now requires the catalog and correction record and checks
that the catalog matches recorded summaries. Publisher verification covers
scheduler JSONL retention, the new layout, raw-pointer retargeting, source-summary
and hash preservation, and refusal to overwrite published evidence.
