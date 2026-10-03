import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { analyzeBurstTrial, BURST_PROTOCOL, BURST_PROTOCOLS, summarizeBurstPairs } from "./burst-recovery-lib.mjs";
import { fileURLToPath } from "node:url";
import { vllmArm } from "./vllm-contention-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => JSON.parse(readFileSync(file, "utf8"));
export function readBurstTrial(directory, seed, variant, protocol = BURST_PROTOCOL) {
  const summary = read(path.join(directory, "summary.json"));
  if (summary.experiment?.protocol !== protocol || summary.experiment.variant !== variant ||
      summary.experiment.seeds?.join(",") !== String(seed)) throw new Error("trial protocol/variant/seed mismatch");
  const raw = read(path.join(directory, `moflux-telemetry-seed-${seed}.json`));
  const eventsFiles = readdirSync(directory).filter((f) => /^backend-events-\d+-moflux\.jsonl$/u.test(f));
  if (eventsFiles.length !== 1) throw new Error("expected exactly one scheduler event file");
  const backendEvents = readFileSync(path.join(directory, eventsFiles[0]), "utf8").split("\n").filter(Boolean).map(JSON.parse);
  const analysis = analyzeBurstTrial({ seed, variant,
    trace: read(path.join(directory, `trace-seed-${seed}.json`)),
    loadgen: read(path.join(directory, `moflux-seed-${seed}.json`)),
    managed: raw.managed, backendEvents, arm: vllmArm("moflux"), armSummary: summary.results?.[0]?.arms?.moflux, protocol });
  // Deliberately exclude per-process PIDs, preserving pinned versions/model/host.
  const { generatedAt, ...runtime } = summary.runtime;
  return { seed, variant, runtime, analysis, ...(summary.error ? { error: summary.error } : {}) };
}

export function readBurstRun(directory) {
  const manifest = read(path.join(directory, "plan.json"));
  if (!BURST_PROTOCOLS.includes(manifest.protocol) || !Array.isArray(manifest.plan) || !manifest.plan.length ||
      typeof manifest.pilot !== "boolean" || new Set(manifest.plan.map((p) => p.seed)).size !== manifest.plan.length ||
      manifest.plan.some((p) => !Number.isSafeInteger(p.seed) || p.seed < 0 ||
        !Array.isArray(p.order) || p.order.length !== 2 || [...p.order].sort().join(",") !== "long,short")) {
    throw new Error("invalid burst recovery run manifest");
  }
  const trials = [];
  for (const { seed, order } of manifest.plan) for (const variant of order) {
    const relative = `trials/${variant}-seed-${seed}`;
    try { trials.push(readBurstTrial(path.join(directory, relative), seed, variant, manifest.protocol)); }
    catch (error) { trials.push({ seed, variant, error: error.message,
      analysis: { valid: false, gates: [{ name: "rawTrialReadable", passed: false, observed: error.message }] } }); }
  }
  return { schemaVersion: 1, benchmark: "vllm-metal-burst-recovery", generatedAt: new Date().toISOString(),
    question: "Does current MoFlux stop new borrowing on protected return, and how does remaining borrower work affect recovery?",
    experiment: { protocol: manifest.protocol, plan: manifest.plan, pilot: manifest.pilot,
      policy: "unlent-concurrency-1", manipulatedField: "batch-setup-[2-3].maxTokens: short=64,long=192; batch-setup-1=64" },
    ...summarizeBurstPairs(manifest.plan, trials, { pilot: manifest.pilot, protocol: manifest.protocol }),
    evidenceLimits: ["Exploratory paired workloads, no competitor or new policy.",
      "Observed transition brackets are not exact controller/application times.",
      "Admission recovery does not establish physical engine capacity reclamation."],
    runs: trials.map((t) => ({ seed: t.seed, variant: t.variant, arms: { moflux: path.relative(ROOT, path.join(directory, "trials", `${t.variant}-seed-${t.seed}`, "summary.json")).split(path.sep).join("/") } })),
    results: trials };
}
