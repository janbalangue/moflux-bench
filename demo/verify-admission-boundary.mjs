#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ADMISSION_BOUNDARY_BAND_REQUESTS,
  ADMISSION_BOUNDARY_PROFILES,
  admissionBoundaryAnalysis,
  classifyReturnWindow,
  describePaired,
  returnWindow,
} from "./admission-boundary-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARMS = ["vllm-fcfs", "vllm-priority", "static", "moflux"];
const SEEDS = [1, 2, 3, 4, 5];
const workload = {
  profile: "metal-long-context-v1",
  interactiveResumeStartMs: 60_000,
  interactiveResumeDurationMs: 25_000,
};
const window = returnWindow(workload);
assert.deepEqual(window, { fromMs: 60_000, toMs: 85_000, durationMs: 25_000 });
assert.throws(() => returnWindow({}), /no interactive return window/u);
assert.equal(ADMISSION_BOUNDARY_BAND_REQUESTS, 2);
assert.deepEqual(ADMISSION_BOUNDARY_PROFILES, {
  boundary8: "admission-8-unlent-2",
  boundary4: "unlent-concurrency-1",
});

// Return-window classification uses trace arrival time and the summary's SLO rule.
const trace = {
  hash: "trace-hash",
  entries: [
    { id: "interactive-1", class: "interactive", arrivalMs: 10_000 },
    { id: "batch-1", class: "batch", arrivalMs: 61_000 },
    ...Array.from({ length: 6 }, (_, index) =>
      ({ id: `interactive-resume-${index + 1}`, class: "interactive", arrivalMs: 60_000 + index * 4_000 })),
    { id: "interactive-late", class: "interactive", arrivalMs: 85_000 },
  ],
};
const loadgen = {
  trace: { hash: "trace-hash" },
  classes: {
    interactive: {
      phaseSamples: [
        { arrivalMs: 10_000, ttftMs: 100, latencyMs: 900 },
        { arrivalMs: 60_000, ttftMs: 400, latencyMs: 1_500 },
        { arrivalMs: 64_000, ttftMs: 5_000, latencyMs: 6_000 },
        { arrivalMs: 68_000, ttftMs: 5_001, latencyMs: 6_000 },
        { arrivalMs: 72_000, ttftMs: 300, latencyMs: 30_001 },
      ],
      localRejectSnapshots: [
        { requestId: "interactive-resume-5", requestClass: "interactive" },
        { requestId: "interactive-1", requestClass: "interactive" },
      ],
    },
  },
};
assert.deepEqual(classifyReturnWindow({ trace, loadgen, window }), {
  arrivals: 6,
  metSlo: 2,
  slowCompleted: 2,
  rejectedAtAdmission: 1,
  otherUnserved: 1,
});
assert.throws(() => classifyReturnWindow({
  trace: { entries: [] },
  loadgen,
  window,
}), /more completions and rejections than planned arrivals/u);

// Preregistered bands: a median of two requests either way is a difference.
const readings = { higher: "up", within: "same", lower: "down" };
const paired = (values) => describePaired(values.map((value, index) => ({ seed: index + 1, value })), readings);
assert.equal(paired([2, 2, 2, -9, 0]).reading, "up");
assert.equal(paired([1, 1, 1, 9, 9]).reading, "same");
assert.equal(paired([-1, -1, -1, -9, -9]).reading, "same", "-1 is still within one request");
assert.equal(paired([-2, -2, -2, 0, 0]).reading, "down");
assert.equal(paired([null, 1, 1, 1, 1]).reading, "unavailable", "a missing seed is not silently dropped");
assert.deepEqual(
  (({ median, mean, sum }) => ({ median, mean, sum }))(paired([0, -5, 1, 3, -6])),
  { median: 0, mean: -1.4, sum: -7 },
);

// Synthetic paired sweeps with known per-seed SLO counts.
const sloCounts = {
  boundary8: {
    "vllm-fcfs": [4, 8, 10, 1, 12],
    "vllm-priority": [8, 14, 10, 12, 16],
    static: [9, 13, 10, 12, 13],
    moflux: [9, 15, 9, 14, 16],
  },
  boundary4: {
    "vllm-fcfs": [4, 9, 10, 0, 12],
    "vllm-priority": [9, 13, 10, 12, 17],
    static: [9, 13, 10, 12, 13],
    moflux: [5, 10, 9, 11, 13],
  },
};
function summary(sweep, { profile = ADMISSION_BOUNDARY_PROFILES[sweep], hash = (seed) => `trace-${seed}` } = {}) {
  return {
    benchmark: `fixture-${sweep}`,
    generatedAt: "2026-09-28T00:00:00.000Z",
    backend: "metal",
    runtime: { mofluxBench: "0.49.0", platform: { platform: "darwin", arch: "arm64", macosVersion: "27.0", appleChip: "Apple M1", systemMemoryBytes: 17179869184 }, tyr: "0.33.0", latchflo: "0.19.0", vllm: "0.29.0", vllmMetal: "0.29.0", model: "m", resolvedModelRevision: "r" },
    experiment: {
      policy: { profile }, workload, seeds: SEEDS,
      engine: { maxNumSeqs: 4, maxModelLen: 4096, gpuMemoryUtilization: 0.4,
        prefixCaching: false, pagedAttention: true, blockSize: 16, numGpuBlocksOverride: 320 },
    },
    ...(sweep === "boundary8" ? { admissionBoundary: { passed: true, seedsMeeting: 5, requiredSeeds: 3, bySeed: [] } } : {}),
    proof: { status: "pass", valid: true, medians: {} },
    results: SEEDS.map((seed, index) => ({
      seed,
      comparison: { batchBorrowGoodputRps: { static: 0.057, moflux: 0.114 } },
      evidence: { moflux: { recovery: { floorRestorationLatencyMs: 500, occupancyRestorationLatencyMs: 5_000 } } },
      arms: Object.fromEntries(ARMS.map((arm) => [arm, {
        trace: { hash: hash(seed) },
        classes: { interactive: { windows: { contention: {
          sloGoodputRps: sloCounts[sweep][arm][index] / 25,
          ttftP50Ms: 450,
          ttftP95Ms: 5_100,
        } } } },
        vllm: {
          preemptions: { delta: 1 },
          phases: { contention: { waiting: { max: 2 } } },
          gauges: { kvCacheUsage: { max: 0.98 } },
          histograms: { itl: { mean: 0.12 } },
        },
        hostPressure: { pagesDuringArm: { pageins: 100 } },
      }])),
    })),
  };
}
const missesFor = (counts) => Object.fromEntries(Object.entries(counts).map(([sweep, arms]) =>
  [sweep, Object.fromEntries(Object.entries(arms).map(([arm, values]) => [arm, Object.fromEntries(
    values.map((metSlo, index) => [SEEDS[index], {
      arrivals: 17, metSlo, slowCompleted: 1, rejectedAtAdmission: 16 - metSlo, otherUnserved: 0,
    }]),
  )]))]));
const analysis = admissionBoundaryAnalysis({
  boundary8: summary("boundary8"),
  boundary4: summary("boundary4"),
  misses: missesFor(sloCounts),
});
assert.deepEqual(analysis.seeds, SEEDS);
assert.deepEqual(analysis.primary1.bySeed.map(({ value }) => value), [1, 1, -1, 2, 0]);
assert.equal(analysis.primary1.median, 1);
assert.equal(analysis.primary1.reading, "no-measurable-difference");
assert.deepEqual(analysis.primary2.moflux.bySeed.map(({ value }) => value), [5, 4, 0, 3, 4]);
assert.equal(analysis.primary2.moflux.reading, "toward-or-past-priority");
assert.deepEqual(analysis.primary2.static.bySeed.map(({ value }) => value), [1, -1, 0, 0, 1]);
assert.equal(analysis.primary2.static.reading, "no-measurable-change");
assert.deepEqual(analysis.drift["vllm-priority"].bySeed.map(({ value }) => value), [-1, 1, 0, 0, -1]);
assert.equal(analysis.secondary.mofluxMinusStaticAtBoundary8.sum, 6);
assert.equal(analysis.misses.boundary8.moflux.totals.metSlo, 63);
assert.equal(analysis.secondary.byArm.boundary8.moflux[0].itlMeanMs, 120);
assert.equal(analysis.validity.runtimeMatches, true);
assert.equal(analysis.validity.traceHashesMatch, true);
assert.equal(analysis.manipulationCheck.passed, true);

// Interrupted sweeps cannot silently select the surviving pairs.
const analyze = (boundary8, boundary4 = summary("boundary4")) => admissionBoundaryAnalysis({
  boundary8, boundary4, misses: missesFor(sloCounts),
});
for (const sweep of ["boundary8", "boundary4"]) {
  const inputs = { boundary8: summary("boundary8"), boundary4: summary("boundary4") };
  inputs[sweep].results = inputs[sweep].results.filter((row) => row.seed === 3);
  assert.throws(() => analyze(inputs.boundary8, inputs.boundary4), /incomplete or duplicate results/u);
}
for (const change of [
  (s) => { s.results[4] = s.results[0]; },
  (s) => { s.experiment.seeds = [1, 2, 3, 4, 4]; },
  (s) => { delete s.experiment.seeds; },
]) {
  const s = summary("boundary8"); change(s);
  assert.throws(() => analyze(s), /planned seeds/u);
}
const pilot = (s) => {
  s.experiment.seeds = [3]; s.results = s.results.filter((row) => row.seed === 3); return s;
};
assert.throws(() => analyze(pilot(summary("boundary8"))), /identical planned seeds/u);
assert.equal(analyze(pilot(summary("boundary8")), pilot(summary("boundary4"))).primary1.reading,
  "inconclusive", "a complete pilot still cannot receive the five-seed interpretation");

// Retain descriptive statistics, but suppress every reading when evidence is inconclusive.
for (const change of [
  (s) => { s.admissionBoundary.passed = false; },
  (s) => { delete s.admissionBoundary; },
  (s) => { s.proof.valid = false; },
]) {
  const s = summary("boundary8"); change(s);
  const result = analyze(s);
  assert.equal(result.validity.interpretable, false);
  assert.equal(result.primary1.median, 1);
  assert.equal(result.primary1.reading, "inconclusive");
  assert.equal(result.primary2.moflux.reading, "inconclusive");
  assert.equal(result.primary2.static.reading, "inconclusive");
  assert.equal(result.secondary.mofluxMinusStaticAtBoundary8.reading, "inconclusive");
  assert.equal(result.drift["vllm-priority"].reading, "inconclusive");
}
const invalidBaseline = summary("boundary4"); invalidBaseline.proof.valid = false;
assert.equal(analyze(summary("boundary8"), invalidBaseline).primary2.moflux.reading, "inconclusive");
const failedHypothesis = summary("boundary8"); failedHypothesis.proof.status = "fail";
assert.equal(analyze(failedHypothesis).validity.interpretable, true,
  "a failed hypothesis is not a failed validity gate");

// Every recorded runtime control matters; missing on both sides is not a match.
for (const [section, keys] of [
  ["runtime", ["mofluxBench", "tyr", "latchflo", "vllm", "vllmMetal", "model", "resolvedModelRevision"]],
  ["platform", ["platform", "arch", "macosVersion", "appleChip", "systemMemoryBytes"]],
  ["engine", ["maxNumSeqs", "maxModelLen", "gpuMemoryUtilization", "prefixCaching", "pagedAttention", "blockSize", "numGpuBlocksOverride"]],
]) {
  const object = (s) => section === "runtime" ? s.runtime
    : section === "platform" ? s.runtime.platform : s.experiment.engine;
  for (const key of keys) {
    const a = summary("boundary8"), b = summary("boundary4");
    object(b)[key] = "changed";
    const result = analyze(a, b);
    assert.equal(result.validity.runtimeMatches, false, `${section}.${key}`);
    assert.equal(result.primary1.reading, "inconclusive");
    delete object(a)[key]; delete object(b)[key];
    assert.equal(analyze(a, b).validity.runtimeMatches, false, `missing ${section}.${key}`);
  }
}
const reordered = summary("boundary4");
reordered.runtime.platform = Object.fromEntries(Object.entries(reordered.runtime.platform).reverse());
assert.equal(analyze(summary("boundary8"), reordered).validity.runtimeMatches, true);

// Raw evidence, profiles and traces must agree before anything is reported.
const wrongMisses = missesFor(sloCounts);
wrongMisses.boundary8.moflux[3].metSlo += 1;
assert.throws(() => admissionBoundaryAnalysis({
  boundary8: summary("boundary8"), boundary4: summary("boundary4"), misses: wrongMisses,
}), /raw evidence counts 10 SLO requests, summary 9/u);
assert.throws(() => admissionBoundaryAnalysis({
  boundary8: summary("boundary4"), boundary4: summary("boundary4"), misses: missesFor(sloCounts),
}), /boundary-8 summary must be a admission-8-unlent-2 sweep/u);
assert.throws(() => admissionBoundaryAnalysis({
  boundary8: summary("boundary8"),
  boundary4: summary("boundary4", { hash: (seed) => `other-${seed}` }),
  misses: missesFor(sloCounts),
}), /identical traces/u);
assert.throws(() => admissionBoundaryAnalysis({
  boundary8: { ...summary("boundary8"), backendAvailability: {} },
  boundary4: summary("boundary4"),
  misses: missesFor(sloCounts),
}), /without the availability protocol/u);

// The command reads raw run files beside each summary and never overwrites output.
const temp = mkdtempSync(path.join(tmpdir(), "moflux-admission-boundary-"));
try {
  for (const sweep of ["boundary8", "boundary4"]) {
    const directory = path.join(temp, sweep);
    mkdirSync(directory);
    writeFileSync(path.join(directory, "summary.json"), JSON.stringify(summary(sweep)));
    SEEDS.forEach((seed, index) => {
      const entries = Array.from({ length: 17 }, (_, n) =>
        ({ id: `interactive-resume-${n + 1}`, class: "interactive", arrivalMs: 60_000 + n * 1_000 }));
      writeFileSync(path.join(directory, `trace-seed-${seed}.json`), JSON.stringify({ hash: `trace-${seed}`, entries }));
      for (const arm of ARMS) {
        const met = sloCounts[sweep][arm][index];
        writeFileSync(path.join(directory, `${arm}-seed-${seed}.json`), JSON.stringify({
          trace: { hash: `trace-${seed}` },
          classes: { interactive: {
            phaseSamples: entries.slice(0, met + 1).map((entry, n) =>
              ({ arrivalMs: entry.arrivalMs, ttftMs: n < met ? 300 : 6_000, latencyMs: 2_000 })),
            localRejectSnapshots: entries.slice(met + 1)
              .map((entry) => ({ requestId: entry.id, requestClass: "interactive" })),
          } },
        }));
      }
    });
  }
  const output = path.join(temp, "analysis.json");
  const run = () => spawnSync(process.execPath, [
    path.join(ROOT, "demo/admission-boundary-analysis.mjs"),
    path.join(temp, "boundary8/summary.json"),
    path.join(temp, "boundary4/summary.json"),
    output,
  ], { cwd: ROOT, encoding: "utf8" });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Primary 1: MoFlux - priority at 8 +median 1, mean 0.6, sum 3 -> no-measurable-difference/u);
  const written = JSON.parse(readFileSync(output, "utf8"));
  assert.deepEqual(written.misses.boundary8.moflux.bySeed[0],
    { seed: 1, arrivals: 17, metSlo: 9, slowCompleted: 1, rejectedAtAdmission: 7, otherUnserved: 0 });
  assert.equal(Object.keys(written.sourceSha256).length, 2 * (1 + SEEDS.length + SEEDS.length * ARMS.length));
  const second = run();
  assert.notEqual(second.status, 0, "an existing analysis is never overwritten");
  assert.match(second.stderr, /EEXIST/u);
  const invalid = summary("boundary8"); invalid.admissionBoundary.passed = false;
  writeFileSync(path.join(temp, "boundary8/summary.json"), JSON.stringify(invalid));
  rmSync(output);
  const inconclusive = run();
  assert.equal(inconclusive.status, 0, inconclusive.stderr);
  assert.match(inconclusive.stdout, /INCONCLUSIVE: manipulation-check-failed-or-missing/u);
  assert.match(inconclusive.stdout, /Primary 1:.* -> inconclusive/u);
  const incomplete = summary("boundary8"); incomplete.results.pop();
  writeFileSync(path.join(temp, "boundary8/summary.json"), JSON.stringify(incomplete));
  rmSync(output);
  const interrupted = run();
  assert.notEqual(interrupted.status, 0);
  assert.match(interrupted.stderr, /incomplete or duplicate results/u);
  assert.throws(() => readFileSync(output), /ENOENT/u);
  const reviewed = spawnSync(process.execPath, [
    path.join(ROOT, "demo/admission-boundary-analysis.mjs"),
    path.join(temp, "boundary8/summary.json"),
    path.join(temp, "boundary4/summary.json"),
    path.join(ROOT, "results/vllm-metal-long-context-admission-8-unlent-2.json"),
  ], { cwd: ROOT, encoding: "utf8" });
  assert.notEqual(reviewed.status, 0);
  assert.match(reviewed.stderr, /refusing to write reviewed evidence/u);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log("PASS  admission boundary classification, preregistered readings, and paired analysis");
