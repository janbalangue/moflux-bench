/**
 * Pure analysis for the preregistered looser admission boundary
 * (demo/ADMISSION-BOUNDARY.md): a boundary-8 sweep against a paired boundary-4
 * sweep on the same seeds. Nothing here reads files or runs inference.
 */

import { VLLM_HYPOTHESIS_THRESHOLDS, median } from "./vllm-contention-lib.mjs";

export const ADMISSION_BOUNDARY_PROFILES = Object.freeze({
  boundary8: "admission-8-unlent-2",
  boundary4: "unlent-concurrency-1",
});

/** A median paired difference of at least two requests per window is a difference. */
export const ADMISSION_BOUNDARY_BAND_REQUESTS = 2;

const ARMS = Object.freeze(["vllm-fcfs", "vllm-priority", "static", "moflux"]);

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function round(value, digits = 3) {
  return value === null ? null : Number(value.toFixed(digits));
}

/** The return window by trace arrival time, as the summary's SLO goodput defines it. */
export function returnWindow(workload) {
  const fromMs = finite(workload?.interactiveResumeStartMs);
  const durationMs = finite(workload?.interactiveResumeDurationMs);
  if (fromMs === null || durationMs === null || durationMs <= 0) {
    throw new Error("workload has no interactive return window");
  }
  return Object.freeze({ fromMs, toMs: fromMs + durationMs, durationMs });
}

/**
 * Classify every interactive request that arrived in the return window.
 * `metSlo` uses the summary's own rule (arrival in window, TTFT and end-to-end
 * within the SLO), so it equals the window's SLO goodput times its length.
 * `otherUnserved` is every arrival that neither completed nor was refused at
 * admission: server or transport errors, and drain censoring.
 */
export function classifyReturnWindow({
  trace,
  loadgen,
  window,
  thresholds = VLLM_HYPOTHESIS_THRESHOLDS,
}) {
  const inWindow = (arrivalMs) => {
    const value = finite(arrivalMs);
    return value !== null && value >= window.fromMs && value < window.toMs;
  };
  const arrivals = (trace?.entries ?? [])
    .filter((entry) => entry?.class === "interactive" && inWindow(entry.arrivalMs));
  const arrivalIds = new Set(arrivals.map((entry) => entry.id));
  const interactive = loadgen?.classes?.interactive ?? {};
  const completed = (interactive.phaseSamples ?? []).filter((sample) => inWindow(sample?.arrivalMs));
  const metSlo = completed.filter((sample) =>
    Number(sample?.ttftMs) <= thresholds.interactiveSloTtftMaxMs &&
    Number(sample?.latencyMs) <= thresholds.interactiveSloLatencyMaxMs).length;
  const rejectedIds = new Set((interactive.localRejectSnapshots ?? [])
    .filter((snapshot) => snapshot?.requestClass === "interactive" && arrivalIds.has(snapshot.requestId))
    .map((snapshot) => snapshot.requestId));
  const result = {
    arrivals: arrivals.length,
    metSlo,
    slowCompleted: completed.length - metSlo,
    rejectedAtAdmission: rejectedIds.size,
  };
  result.otherUnserved = result.arrivals - completed.length - result.rejectedAtAdmission;
  if (result.otherUnserved < 0) {
    throw new Error("more completions and rejections than planned arrivals in the return window");
  }
  return Object.freeze(result);
}

/** Median, mean and sum of per-seed values, with the preregistered reading. */
export function describePaired(bySeed, readings) {
  const values = bySeed.map(({ value }) => value).filter((value) => value !== null);
  const middle = values.length === bySeed.length && values.length > 0 ? median(values) : null;
  let reading = "unavailable";
  if (middle !== null) {
    reading = middle >= ADMISSION_BOUNDARY_BAND_REQUESTS
      ? readings.higher
      : middle <= -ADMISSION_BOUNDARY_BAND_REQUESTS ? readings.lower : readings.within;
  }
  return Object.freeze({
    bySeed: Object.freeze(bySeed.map((row) => Object.freeze({ ...row }))),
    median: middle,
    mean: values.length > 0 ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null,
    sum: values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : null,
    reading,
  });
}

const PRIMARY_1_READINGS = Object.freeze({
  higher: "moflux-protects-beyond-priority",
  within: "no-measurable-difference",
  lower: "moflux-worse-than-priority",
});
const PRIMARY_2_READINGS = Object.freeze({
  higher: "toward-or-past-priority",
  within: "no-measurable-change",
  lower: "away-from-priority",
});

function armMetrics(row, arm) {
  const value = row?.arms?.[arm];
  const contention = value?.classes?.interactive?.windows?.contention;
  return Object.freeze({
    ttftP50Ms: round(finite(contention?.ttftP50Ms), 1),
    ttftP95Ms: round(finite(contention?.ttftP95Ms), 1),
    preemptions: finite(value?.vllm?.preemptions?.delta),
    contentionWaitingPeak: finite(value?.vllm?.phases?.contention?.waiting?.max),
    kvCacheUsagePeak: finite(value?.vllm?.gauges?.kvCacheUsage?.max),
    batchBorrowGoodputRps: finite(row?.comparison?.batchBorrowGoodputRps?.[arm]),
    itlMeanMs: round(finite(value?.vllm?.histograms?.itl?.mean) === null
      ? null : finite(value.vllm.histograms.itl.mean) * 1000, 1),
    pageins: finite(value?.hostPressure?.pagesDuringArm?.pageins),
  });
}

function recoveryMetrics(row) {
  const recovery = row?.evidence?.moflux?.recovery;
  return Object.freeze({
    floorRestorationLatencyMs: finite(recovery?.floorRestorationLatencyMs),
    occupancyRestorationLatencyMs: finite(recovery?.occupancyRestorationLatencyMs),
  });
}

function assertSweep(summary, label, profile) {
  const policy = summary?.experiment?.policy;
  if (policy?.profile !== profile) {
    throw new Error(`${label} must be a ${profile} sweep, got ${JSON.stringify(policy?.profile ?? null)}`);
  }
  if (summary?.experiment?.workload?.profile !== "metal-long-context-v1" || summary?.backendAvailability) {
    throw new Error(`${label} must use metal-long-context-v1 without the availability protocol`);
  }
}

const RUNTIME_KEYS = Object.freeze([
  "mofluxBench", "tyr", "latchflo", "vllm", "vllmMetal", "model", "resolvedModelRevision",
]);
const PLATFORM_KEYS = Object.freeze([
  "platform", "arch", "macosVersion", "appleChip", "systemMemoryBytes",
]);
const ENGINE_KEYS = Object.freeze([
  "maxNumSeqs", "maxModelLen", "gpuMemoryUtilization", "prefixCaching",
  "pagedAttention", "blockSize", "numGpuBlocksOverride",
]);

function runtimeControls(summary) {
  return Object.fromEntries([
    ["backend", summary.backend ?? null],
    ...RUNTIME_KEYS.map((key) => [key, summary.runtime?.[key] ?? null]),
    ...PLATFORM_KEYS.map((key) => [`platform.${key}`, summary.runtime?.platform?.[key] ?? null]),
    ...ENGINE_KEYS.map((key) => [`engine.${key}`, summary.experiment?.engine?.[key] ?? null]),
  ]);
}

function plannedSeeds(summary, label) {
  const seeds = summary.experiment?.seeds;
  if (!Array.isArray(seeds) || seeds.length === 0 ||
      seeds.some((seed) => !Number.isSafeInteger(seed)) || new Set(seeds).size !== seeds.length) {
    throw new Error(`${label}: planned seeds must be nonempty, unique integers`);
  }
  const rows = summary.results ?? [];
  if (rows.length !== seeds.length || new Set(rows.map((row) => row.seed)).size !== rows.length ||
      seeds.some((seed) => !rows.some((row) => row.seed === seed))) {
    throw new Error(`${label}: incomplete or duplicate results for planned seeds; analysis is inconclusive`);
  }
  return [...seeds].sort((a, b) => a - b);
}

/**
 * Compute the preregistered outcomes. `misses[sweep][arm][seed]` holds
 * classifyReturnWindow results; each is checked against the summary's SLO
 * goodput so raw evidence and summary cannot silently disagree.
 */
export function admissionBoundaryAnalysis({ boundary8, boundary4, misses }) {
  assertSweep(boundary8, "boundary-8 summary", ADMISSION_BOUNDARY_PROFILES.boundary8);
  assertSweep(boundary4, "boundary-4 summary", ADMISSION_BOUNDARY_PROFILES.boundary4);
  const sweeps = { boundary8, boundary4 };
  const window = returnWindow(boundary8.experiment.workload);
  if (JSON.stringify(returnWindow(boundary4.experiment.workload)) !== JSON.stringify(window)) {
    throw new Error("the two sweeps use different return windows");
  }
  const seeds = plannedSeeds(boundary8, "boundary8");
  if (JSON.stringify(seeds) !== JSON.stringify(plannedSeeds(boundary4, "boundary4"))) {
    throw new Error("the two sweeps must have identical planned seeds; analysis is inconclusive");
  }
  const rowOf = (sweep, seed) => sweeps[sweep].results.find((row) => row.seed === seed);
  const traceHashesMatch = seeds.every((seed) => ARMS.every((arm) =>
    rowOf("boundary8", seed)?.arms?.[arm]?.trace?.hash !== undefined &&
    rowOf("boundary8", seed).arms[arm].trace.hash === rowOf("boundary4", seed)?.arms?.[arm]?.trace?.hash));
  if (!traceHashesMatch) throw new Error("paired seeds must replay identical traces in every arm");

  const slo = (sweep, arm, seed) => {
    const counts = misses?.[sweep]?.[arm]?.[seed];
    if (!counts) throw new Error(`missing return-window classification for ${sweep} ${arm} seed ${seed}`);
    const summaryRps = finite(rowOf(sweep, seed)?.arms?.[arm]?.classes?.interactive?.windows?.contention?.sloGoodputRps);
    const summaryCount = summaryRps === null ? null : Math.round(summaryRps * window.durationMs / 1000);
    if (summaryCount !== counts.metSlo) {
      throw new Error(`${sweep} ${arm} seed ${seed}: raw evidence counts ${counts.metSlo} SLO requests, summary ${summaryCount}`);
    }
    return counts.metSlo;
  };
  const runtime = Object.fromEntries(Object.entries(sweeps)
    .map(([name, summary]) => [name, runtimeControls(summary)]));
  const runtimeMismatches = Object.keys(runtime.boundary8).filter((key) =>
    runtime.boundary8[key] === null || runtime.boundary4[key] === null ||
    runtime.boundary8[key] !== runtime.boundary4[key]);
  const bothSweepsValid = boundary8.proof?.valid === true && boundary4.proof?.valid === true;
  const inconclusiveReasons = [
    ...(JSON.stringify(seeds) !== JSON.stringify([1, 2, 3, 4, 5]) ? ["requires-preregistered-seeds-1-5"] : []),
    ...(!bothSweepsValid ? ["invalid-sweep"] : []),
    ...(boundary8.admissionBoundary?.passed !== true ? ["manipulation-check-failed-or-missing"] : []),
    ...(runtimeMismatches.length > 0 ? ["runtime-controls-differ-or-missing"] : []),
  ];
  const describe = (rows, readings) => {
    const statistics = describePaired(rows, readings);
    return inconclusiveReasons.length === 0 ? statistics : Object.freeze({
      ...statistics, reading: "inconclusive",
    });
  };
  const difference = (sweep, left, right) => seeds.map((seed) => {
    const [a, b] = [slo(sweep, left, seed), slo(sweep, right, seed)];
    return { seed, [left]: a, [right]: b, value: a - b };
  });
  const primary1 = describe(difference("boundary8", "moflux", "vllm-priority"), PRIMARY_1_READINGS);
  const differenceInDifferences = (arm) => describe(seeds.map((seed) => {
    const at8 = slo("boundary8", arm, seed) - slo("boundary8", "vllm-priority", seed);
    const at4 = slo("boundary4", arm, seed) - slo("boundary4", "vllm-priority", seed);
    return { seed, boundary8: at8, boundary4: at4, value: at8 - at4 };
  }), PRIMARY_2_READINGS);

  const missTable = Object.fromEntries(Object.keys(sweeps).map((sweep) => [sweep, Object.fromEntries(
    ARMS.map((arm) => {
      const bySeed = seeds.map((seed) => ({ seed, ...misses[sweep][arm][seed] }));
      const totals = Object.fromEntries(["arrivals", "metSlo", "slowCompleted", "rejectedAtAdmission", "otherUnserved"]
        .map((key) => [key, bySeed.reduce((sum, row) => sum + row[key], 0)]));
      return [arm, { bySeed, totals }];
    }),
  )]));
  const drift = Object.fromEntries(["vllm-fcfs", "vllm-priority"].map((arm) => [arm, describe(
    seeds.map((seed) => ({ seed, value: slo("boundary8", arm, seed) - slo("boundary4", arm, seed) })),
    { higher: "boundary-8-sweep-higher", within: "within-one-request", lower: "boundary-8-sweep-lower" },
  )]));

  return Object.freeze({
    schemaVersion: 1,
    preregistration: "demo/ADMISSION-BOUNDARY.md",
    unit: "requests meeting the interactive SLO per 25-second return window, paired by seed",
    seeds,
    manipulationCheck: boundary8.admissionBoundary ?? null,
    validity: Object.freeze({
      boundary8ProofStatus: boundary8.proof?.status ?? null,
      boundary4ProofStatus: boundary4.proof?.status ?? null,
      bothSweepsValid,
      runtimeMatches: runtimeMismatches.length === 0,
      runtimeMismatches,
      runtime: Object.freeze(runtime),
      interpretable: inconclusiveReasons.length === 0,
      inconclusiveReasons,
      traceHashesMatch,
    }),
    primary1: Object.freeze({
      statistic: "S(moflux) - S(vllm-priority) at boundary 8",
      ...primary1,
    }),
    primary2: Object.freeze({
      statistic: "[S(arm) - S(vllm-priority)] at boundary 8 minus the same at boundary 4",
      moflux: differenceInDifferences("moflux"),
      static: differenceInDifferences("static"),
    }),
    misses: missTable,
    secondary: Object.freeze({
      mofluxMinusStaticAtBoundary8: describe(difference("boundary8", "moflux", "static"), {
        higher: "moflux-higher", within: "no-measurable-difference", lower: "static-higher",
      }),
      byArm: Object.fromEntries(Object.keys(sweeps).map((sweep) => [sweep, Object.fromEntries(
        ARMS.map((arm) => [arm, seeds.map((seed) => ({ seed, ...armMetrics(rowOf(sweep, seed), arm) }))]),
      )])),
      mofluxRestoration: Object.fromEntries(Object.keys(sweeps).map((sweep) => [sweep,
        seeds.map((seed) => ({ seed, ...recoveryMetrics(rowOf(sweep, seed)) }))])),
      hypothesisMedians: Object.freeze({
        boundary8: boundary8.proof?.medians ?? null,
        boundary4: boundary4.proof?.medians ?? null,
      }),
    }),
    drift,
    note: "Descriptive. Readings apply the preregistered two-request bands to five-seed medians, " +
      "which are not confidence bounds; the mean and sum are reported because a median of five " +
      "paired differences can move between identical runs. A failed manipulation check leaves the " +
      "boundary question inconclusive.",
  });
}
