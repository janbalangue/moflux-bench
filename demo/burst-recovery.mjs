#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BURST_PROTOCOL, BURST_WORKLOAD, burstPairPlan } from "./burst-recovery-lib.mjs";
import { readBurstRun } from "./burst-recovery-run-lib.mjs";
import { assertSafeRunDir, runId } from "./evidence-paths-lib.mjs";
import { installRunCancellation, runCooperativeChild } from "./run-cancellation-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const allowed = new Set(["seeds", "pilot", "dry-run", "run-id", "out", "metal-bin", "metal-python"]);
const options = new Map();
let cancellation = null;
try {
  for (const argument of process.argv.slice(2)) {
    const match = /^--([^=]+)(?:=(.*))?$/u.exec(argument);
    if (!match || !allowed.has(match[1]) || options.has(match[1])) throw new Error(`invalid argument ${argument}`);
    if (["pilot", "dry-run"].includes(match[1]) && match[2] !== undefined) throw new Error(`${match[1]} is a flag`);
    if (!["pilot", "dry-run"].includes(match[1]) && !match[2]) throw new Error(`${match[1]} requires a value`);
    options.set(match[1], match[2] ?? true);
  }
  const pilot = options.has("pilot");
  const seeds = [];
  for (const part of String(options.get("seeds") ?? (pilot ? "3" : "1-5")).split(",")) {
    const m = /^(\d+)(?:-(\d+))?$/u.exec(part);
    if (!m) throw new Error("--seeds must be comma-separated integer seeds or ranges");
    const start = Number(m[1]), end = Number(m[2] ?? m[1]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start || end - start > 1000) throw new Error("invalid seed range");
    for (let i = start; i <= end; i++) seeds.push(i);
  }
  if (new Set(seeds).size !== seeds.length) throw new Error("duplicate seeds are not independent pairs");
  if (!pilot && seeds.length < 5) throw new Error("a sweep requires at least five pairs; use --pilot for instrumentation");
  const id = options.get("run-id") ?? runId();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(id)) throw new Error("unsafe run id");
  const output = assertSafeRunDir(options.has("out") ? path.resolve(options.get("out")) :
    path.join(ROOT, "results/runs/vllm-metal-burst-recovery", id), ROOT, "burst recovery output");
  if (existsSync(output)) throw new Error("refusing to reuse existing run directory");
  const plan = burstPairPlan(seeds);
  const commands = plan.flatMap(({ seed, order }) => order.map((variant) => ({ seed, variant,
    args: [path.join(ROOT, "demo/vllm-contention.mjs"), "--backend=metal", "--workload=metal-long-context-v1",
      "--policy-profile=unlent-concurrency-1", "--arms=moflux", `--burst-recovery=${variant}`, `--seeds=${seed}`,
      `--duration-ms=${BURST_WORKLOAD.durationMs}`, "--managed-telemetry-interval-ms=250", "--require-proof", `--out=${path.join(output, "trials", `${variant}-seed-${seed}`)}`,
      ...["metal-bin", "metal-python"].filter((key) => options.has(key)).map((key) => `--${key}=${options.get(key)}`)] })));
  console.log(JSON.stringify({ protocol: BURST_PROTOCOL, pilot, output, plan, commands }, null, 2));
  if (options.has("dry-run")) {
    console.log("PASS dry-run: no files created, stack started, or inference requested");
  } else {
    mkdirSync(path.dirname(output), { recursive: true });
    mkdirSync(output);
    writeFileSync(path.join(output, "plan.json"), `${JSON.stringify({ protocol: BURST_PROTOCOL, pilot, plan, commands }, null, 2)}\n`);
    cancellation = installRunCancellation();
    for (const command of commands) {
      if (cancellation.interrupted) break;
      console.log(`Running ${command.variant}, seed ${command.seed}`);
      try {
        const result = await runCooperativeChild(process.execPath, command.args, { cwd: ROOT, cancellation });
        if (result.status !== 0) console.error(`Trial exited ${result.status ?? result.signal}; retained for analysis`);
      } catch (error) { console.error(error.message); }
    }
    const summary = readBurstRun(output);
    if (cancellation.interrupted) {
      summary.error = cancellation.signal.reason.message;
      summary.passed = false;
      summary.proof = { ...summary.proof, passed: false, status: "interrupted" };
    }
    writeFileSync(path.join(output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`Wrote ${path.join(output, "summary.json")}; ${summary.proof.status}`);
    if (cancellation.interrupted || summary.results.some((t) => t.error) || (!pilot && !summary.passed) ||
        (pilot && summary.results.some((t) => !t.analysis.valid))) process.exitCode = 1;
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally {
  if (cancellation?.interrupted) process.exitCode = cancellation.exitCode;
  cancellation?.dispose();
}
