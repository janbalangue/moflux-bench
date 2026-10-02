#!/usr/bin/env node
/**
 * Preregistered analysis for the looser admission boundary
 * (demo/ADMISSION-BOUNDARY.md). Reads a boundary-8 and a boundary-4 sweep and
 * writes a new file; it never modifies either run or runs inference.
 *
 *   node demo/admission-boundary-analysis.mjs BOUNDARY8_SUMMARY BOUNDARY4_SUMMARY NEW_OUTPUT
 */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { admissionBoundaryAnalysis, classifyReturnWindow, returnWindow } from "./admission-boundary-lib.mjs";
import { assertSafeOutputFile } from "./evidence-paths-lib.mjs";

const [boundary8Input, boundary4Input, output] = process.argv.slice(2);
if (!boundary8Input || !boundary4Input || !output || process.argv.length !== 5) {
  console.error("Usage: node demo/admission-boundary-analysis.mjs BOUNDARY8_SUMMARY BOUNDARY4_SUMMARY NEW_OUTPUT");
  process.exit(1);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(realpathSync(path.dirname(path.resolve(output))), path.basename(output));
assertSafeOutputFile(target, root);

const hashes = {};
function read(file) {
  const bytes = readFileSync(file);
  hashes[path.relative(root, file)] = createHash("sha256").update(bytes).digest("hex");
  return JSON.parse(bytes);
}

const sources = { boundary8: realpathSync(boundary8Input), boundary4: realpathSync(boundary4Input) };
const summaries = Object.fromEntries(Object.entries(sources).map(([sweep, file]) => [sweep, read(file)]));
const misses = {};
for (const [sweep, summary] of Object.entries(summaries)) {
  const directory = path.dirname(sources[sweep]);
  const window = returnWindow(summary.experiment?.workload);
  misses[sweep] = {};
  for (const row of summary.results ?? []) {
    if (!Number.isSafeInteger(row.seed)) throw new Error(`${sweep}: invalid seed`);
    const trace = read(path.join(directory, `trace-seed-${row.seed}.json`));
    for (const [arm, value] of Object.entries(row.arms ?? {})) {
      if (!/^[a-z-]+$/u.test(arm)) throw new Error(`${sweep}: invalid arm ${JSON.stringify(arm)}`);
      const loadgen = read(path.join(directory, `${arm}-seed-${row.seed}.json`));
      if (loadgen.trace?.hash !== value.trace?.hash || trace.hash !== value.trace?.hash) {
        throw new Error(`${sweep} ${arm} seed ${row.seed}: raw evidence trace does not match the summary`);
      }
      misses[sweep][arm] ??= {};
      misses[sweep][arm][row.seed] = classifyReturnWindow({ trace, loadgen, window });
    }
  }
}

const analysis = {
  ...admissionBoundaryAnalysis({ ...summaries, misses }),
  generatedAt: new Date().toISOString(),
  sources: Object.fromEntries(Object.entries(sources).map(([sweep, file]) => [sweep, {
    summary: path.relative(root, file),
    benchmark: summaries[sweep].benchmark,
    policyProfile: summaries[sweep].experiment.policy.profile,
    generatedAt: summaries[sweep].generatedAt,
  }])),
  sourceSha256: hashes,
};
writeFileSync(target, `${JSON.stringify(analysis, null, 2)}\n`, { flag: "wx" });

const line = (label, value) => console.log(`${label.padEnd(44)} ${value}`);
const describe = (stat) => `median ${stat.median}, mean ${stat.mean}, sum ${stat.sum} -> ${stat.reading}`;
const check = analysis.manipulationCheck;
line("seeds", analysis.seeds.join(","));
line("manipulation check (MoFlux contention queue >=2)",
  check ? `${check.seedsMeeting}/${check.bySeed.length} seeds, need ${check.requiredSeeds}: ${check.passed ? "PASS" : "FAIL"}` : "missing");
line("proof status boundary 8 / boundary 4",
  `${analysis.validity.boundary8ProofStatus} / ${analysis.validity.boundary4ProofStatus}`);
line("runtime identical across sweeps", analysis.validity.runtimeMatches);
if (!analysis.validity.interpretable) {
  line("interpretation", `INCONCLUSIVE: ${analysis.validity.inconclusiveReasons.join(", ")}`);
}
if (analysis.validity.runtimeMismatches.length > 0) {
  line("runtime controls differing or missing", analysis.validity.runtimeMismatches.join(", "));
}
line("Primary 1: MoFlux - priority at 8", describe(analysis.primary1));
line("Primary 2: MoFlux change from boundary 4", describe(analysis.primary2.moflux));
line("Primary 2: static change from boundary 4", describe(analysis.primary2.static));
line("MoFlux - static at 8", describe(analysis.secondary.mofluxMinusStaticAtBoundary8));
for (const sweep of ["boundary8", "boundary4"]) {
  for (const arm of ["vllm-priority", "static", "moflux"]) {
    const t = analysis.misses[sweep][arm].totals;
    line(`${sweep} ${arm} return window`,
      `${t.arrivals} arrivals: ${t.metSlo} met, ${t.slowCompleted} slow, ` +
        `${t.rejectedAtAdmission} rejected, ${t.otherUnserved} other`);
  }
}
line("drift: priority boundary 8 - boundary 4", describe(analysis.drift["vllm-priority"]));
console.log(`\nwrote ${path.relative(root, target)}`);
