#!/usr/bin/env node
import path from "node:path";
import { readBurstRun } from "./burst-recovery-run-lib.mjs";
try {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !args[0].startsWith("--run=")) throw new Error("usage: node demo/burst-recovery-analysis.mjs --run=<run-directory>");
  const result = readBurstRun(path.resolve(args[0].slice(6)));
  console.log(JSON.stringify(result, null, 2));
  if (!result.pilot && !result.passed || result.results.some((t) => !t.analysis.valid)) process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
