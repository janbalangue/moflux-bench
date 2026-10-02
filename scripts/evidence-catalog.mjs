import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Editorial scope/limitations are explicit; dates, seeds, outcomes and runtime
// are read from evidence. Never infer a modern verdict for an older schema.
const entries = [
  ["Simulation", "video-seed-sweep", "video-seed-sweep.json", "Eight-seed adaptive corpus; simulator-only evidence."],
  ["Simulation", "headroom workload", "curated/video-seed-sweep-v0.40.1-20260923T210051Z.json", "Separate runtime cohort and headroom policy."],
  ["Simulation", "adaptive control", "curated/moflux-seed-sweep-v0.44.0-20260924T225251Z-adaptive.json", "Input sweep for the paired headroom comparison."],
  ["Simulation", "one-slot headroom", "curated/moflux-seed-sweep-v0.44.0-20260924T225251Z-headroom-lend1.json", "Input sweep; passing mechanism proof does not establish the paired performance result."],
  ["Simulation", "paired headroom comparison", "curated/headroom-policy-comparison-v0.44.0-20260924T225251Z-lend1.json", "Fails batch-payoff and interactive-p95 checks; see curated notes."],
  ["Simulation", "historical fragmented batch floor", "curated/negative-fragmented-batch-floor/aggregate.json", "Historical negative case; no modern proof contract or immutable trace corpus."],
  ["Hosted provider", "hosted compatibility", "openai-live-compatibility.json", "Compatibility only; does not establish overload efficacy."],
  ["Hosted provider", "eight-seed overload", "openai-live-overload-8-seed.json", "Provider-pressure workload; does not exercise fleet coordination or token-budget admission."],
  ["Local admission", "local compatibility", "local-inference-compatibility.json", "Compatibility only; warm-up/order artifacts prevent proxy-overhead claims."],
  ["Local admission", "tenant fairness", "tenant-fairness.json", "Class admission/lending proof, distinct from local inference contention."],
  ["Local admission", "contention baseline", "local-inference-contention.json", "Negative result: H1 interactive SLO goodput fails."],
  ["Local admission", "one-slot reserve (0.35.0)", "local-inference-contention-unlent-concurrency.json", "Pre-native reserve follow-up; separate from 0.36.0 enforcement."],
  ["Local admission", "native one-slot reserve (0.36.0)", "local-inference-contention-unlent-concurrency-v0.36.0.json", "Native reserve follow-up; do not relabel the older corpus."],
  ["vLLM Metal", "balanced workload", "vllm-metal-contention.json", "Unpinned KV corpus; does not establish KV-pressure behavior."],
  ["vLLM Metal", "long context, first run", "curated/vllm-metal-long-context/20260925T001105Z.json", "First pass was not reliably reproduced; read with the failed repeat."],
  ["vLLM Metal", "long context, repeat", "curated/vllm-metal-long-context/20260925T164229Z.json", "Valid negative H2 result; recorded macOS differs from the first run."],
  ["vLLM Metal", "two-slot reserve, first run", "vllm-metal-long-context-unlent-concurrency-2.json", "H2 median sits exactly on its -0.04 req/s margin."],
  ["vLLM Metal", "two-slot reserve, repeat", "vllm-metal-long-context-unlent-concurrency-2-v0.47.1.json", "H2 median again sits on its margin; descriptive five-seed checks."],
  ["vLLM Metal", "admission boundary 8", "vllm-metal-long-context-admission-8-unlent-2.json", "Queue manipulation passes 5/5; paired boundary-4 baseline is missing."],
  ["vLLM Metal", "availability v2 control", "curated/vllm-metal-backend-availability/fixed-burst-v2-20260928T041426Z.json", "No observed post-restoration episodes; four served before restoration, one inconclusive."],
  ["vLLM Metal", "availability v3", "curated/vllm-metal-backend-availability/fixed-burst-v3-20260928T032816Z.json", "Valid negative H2 result; only 5/30 availability observations."],
];
function walk(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}
for (const file of walk(path.join(root, "results/published"))) {
  const rel = path.relative(path.join(root, "results"), file).split(path.sep).join("/");
  if (rel.split("/").length === 5 && rel.endsWith("/summary.json")) {
    const parts = rel.split("/");
    entries.push(["New layout", `${parts[1]} / ${parts[2]} / ${parts[3]}`, rel, "Read the run README and original evidence limits before interpreting outcomes."]);
  }
}
const json = (rel) => JSON.parse(readFileSync(path.join(root, "results", rel), "utf8"));
// Require every published summary to be indexed, including future additions
// to legacy locations. Raw arm/telemetry files have no sweep seed list.
const inventory = [
  ...readdirSync(path.join(root, "results")).filter((f) => f.endsWith(".json")),
  ...walk(path.join(root, "results/curated")).map((f) => path.relative(path.join(root, "results"), f).split(path.sep).join("/"))
    .filter((f) => f.endsWith(".json") && f.split("/").length <= 3)
    .filter((f) => { const j = json(f); return Array.isArray(j.seeds) || Array.isArray(j.experiment?.seeds); }),
];
const indexed = new Set(entries.map((e) => e[2]));
for (const source of inventory) if (!indexed.has(source)) throw new Error(`published summary missing from catalog: ${source}`);
const escape = (value) => String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
function outcome(j) {
  let result;
  if (j.proof) result = `${j.proof.valid ? "valid" : "inconclusive"}; H1–H5 ${j.proof.status}`;
  else if (j.localContentionProof) result = `local contention proof ${j.localContentionProof.passed ? "pass" : "fail"}`;
  else if (typeof j.acceptance?.passed === "boolean") result = `acceptance ${j.acceptance.passed ? "pass" : "fail"}`;
  else if (j.validation) result = j.validation.allConclusive ? "provider overload conclusive" : "provider overload inconclusive";
  else if (typeof j.adaptiveProof?.passed === "boolean") result = `adaptive mechanism proof ${j.adaptiveProof.passed ? "pass" : "fail"}`;
  else if (typeof j.passed === "boolean") result = `recorded pass flag ${j.passed}`;
  else result = "modern verdict not recorded";
  if (j.backendAvailability) result += `; availability distribution ${j.backendAvailability.proof.passed ? "pass" : "fail"}; overall passed=${j.passed}`;
  return result;
}
function runtime(j) {
  if (!j.runtime) {
    const armRuntimes = (j.runs ?? []).flatMap((run) => {
      const file = run.arms?.moflux;
      if (!file || !file.startsWith("results/")) return [];
      const arm = JSON.parse(readFileSync(path.join(root, file), "utf8"));
      return arm.runtime ? [runtime({ runtime: arm.runtime })] : [];
    });
    if (armRuntimes.length) return `summary runtime not recorded; ${armRuntimes.length} raw MoFlux arms: ${[...new Set(armRuntimes)].join(" / ")}`;
  }
  const r = j.runtime ?? {};
  return [
    r.mofluxBench && `harness ${r.mofluxBench}`,
    r.tyr && `Tyr ${typeof r.tyr === "object" ? r.tyr.version : r.tyr}`,
    r.latchflo && `Latchflo ${typeof r.latchflo === "object" ? r.latchflo.version : r.latchflo}`,
    r.ollama && `Ollama ${r.ollama}`,
    r.vllm && `vLLM ${r.vllm}`,
    r.vllmMetal && `vllm-metal ${r.vllmMetal}`,
    r.asyncBulkheadLlm && `async-bulkhead-llm ${typeof r.asyncBulkheadLlm === "object" ? r.asyncBulkheadLlm.version : r.asyncBulkheadLlm}`,
    r.asyncBulkheadTs && `async-bulkhead-ts ${typeof r.asyncBulkheadTs === "object" ? r.asyncBulkheadTs.version : r.asyncBulkheadTs}`,
  ].filter(Boolean).join("; ") || "not recorded in summary";
}
let output = "# Published evidence catalog\n\n" +
  "Generated from recorded evidence by `npm run evidence:catalog`; verify with `npm run verify:catalog`.\n\n" +
  "Top-level and `curated/` locations have the same reviewed status. Existing paths are preserved for citations; new publications use `published/<experiment>/<profile>/<UTC-run-id>/`. See [organization and corrections](CORRECTIONS.md).\n\n" +
  "Dates below are the summary's recorded `generatedAt` in UTC, not inferred run start or release dates. Seed counts come from the recorded design. A pass is specific to the named proof contract; it does not remove the listed limitations. Missing metadata stays missing. Metal results establish no MoFlux physical KV/GPU reclamation or CUDA generalization.\n";
const metadata = [];
for (const group of [...new Set(entries.map((e) => e[0]))]) {
  output += `\n## ${group}\n\n| Evidence | UTC date | Seeds | Policy / protocol | Recorded outcome | Limits |\n| --- | --- | ---: | --- | --- | --- |\n`;
  for (const [, label, source, limits] of entries.filter((e) => e[0] === group)) {
    const j = json(source);
    const seeds = j.experiment?.seeds ?? j.seeds;
    const policy = j.backendAvailability?.protocol ?? j.experiment?.policy?.profile ?? j.capacityPolicy?.profile
      ?? (j.baselineProfile && j.headroomProfile ? `${j.baselineProfile} vs ${j.headroomProfile}` : "see source configuration");
    output += `| [${label}](${source}) | ${escape(j.generatedAt?.slice(0, 10) ?? "not recorded")} | ${Array.isArray(seeds) ? seeds.length : "not recorded"} | ${escape(policy)} | ${escape(outcome(j))} | ${escape(limits)} |\n`;
    const directory = source.endsWith("/summary.json") ? path.dirname(source) : source.replace(/\.json$/, "");
    const manifest = `${directory}/provenance.json`;
    const provenance = existsSync(path.join(root, "results", manifest)) ? json(manifest) : null;
    const files = provenance?.sha256 ?? provenance?.originalJsonSha256;
    metadata.push([label, source, runtime(j), files ? `[${Object.keys(files).length} source hashes](${manifest})` : "source hash manifest not recorded"]);
  }
}
output += "\n## Runtime and provenance\n\nRecorded summary metadata is listed here. When a summary lacks runtime metadata but references raw MoFlux arms, their recorded services are shown explicitly as arm-level evidence. Missing harness versions are not inferred from filenames. Older corpora without hash manifests remain historical evidence with that limitation.\n\n| Evidence | Recorded services | Source manifest |\n| --- | --- | --- |\n";
for (const [label, source, services, hashes] of metadata) output += `| [${label}](${source}) | ${escape(services)} | ${hashes} |\n`;
output += "\n## Reserved and generated paths\n\n`results/vllm-contention.json` is reserved for reviewed CUDA evidence and is currently absent. Reserved paths are not published results. `results/runs/` and `results/replicates/` contain generated work, not cataloged reviewed claims.\n";
const target = path.join(root, "results/CATALOG.md");
if (process.argv.includes("--check")) {
  if (!existsSync(target) || readFileSync(target, "utf8") !== output) throw new Error("evidence catalog differs from recorded summaries; run npm run evidence:catalog");
  console.log(`PASS evidence catalog (${entries.length} published summaries)`);
} else {
  writeFileSync(target, output);
  console.log(`Wrote results/CATALOG.md (${entries.length} published summaries)`);
}
