#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fetchWithTimeout, hostChildren, killChildTree, launchCommand, sleep, stopHostChildren, waitFor, waitForChildOutput } from "./host-process-lib.mjs";
import { installRunCancellation } from "./run-cancellation-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(path.join(tmpdir(), "moflux-cancellation-"));
const hostLib = JSON.stringify(pathToFileURL(path.join(ROOT, "demo/host-process-lib.mjs")).href);
const cancellationLib = JSON.stringify(pathToFileURL(path.join(ROOT, "demo/run-cancellation-lib.mjs")).href);
let active = null;
const fixture = path.join(temp, "trial.mjs");
const engine = path.join(temp, "engine.mjs");
const hook = path.join(temp, "hook.mjs");

async function eventually(check, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(20);
  }
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

try {
  // Keep the real burst wrapper, its loop, signal handlers, and aggregate writes.
  // Replace only its expensive trial executable with a local cooperative trial.
  writeFileSync(hook, `import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const actual = childProcess.spawn;
childProcess.spawn = (command, argv, options) => actual(command,
  argv?.[0]?.endsWith("/demo/vllm-contention.mjs") ? [${JSON.stringify(fixture)}, ...argv.slice(1)] : argv, options);
syncBuiltinESMExports();\n`);
  writeFileSync(engine, `import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
const leaf = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.env.FIXTURE_DIR + '/leaf-ready', 'true'); setInterval(() => {}, 1000)"], { stdio: process.env.FIXTURE_STDIO ?? "inherit" });
writeFileSync(process.env.FIXTURE_DIR + "/leaf.pid", String(leaf.pid));
const readiness = setInterval(() => {
  if (!existsSync(process.env.FIXTURE_DIR + '/leaf-ready')) return;
  clearInterval(readiness);
  console.log('ready');
  if (process.env.EXIT_LEADER === 'true') process.exit(0);
}, 10);
setInterval(() => {}, 1000);\n`);
  writeFileSync(fixture, `import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { launchCommand, sleep, stopHostChildren, waitForChildOutput } from ${hostLib};
import { installRunCancellation } from ${cancellationLib};
const out = process.argv.find((arg) => arg.startsWith("--out=")).slice(6);
mkdirSync(out, { recursive: true });
writeFileSync(out + "/started", "true");
const cancellation = installRunCancellation({ onInterrupt: () => stopHostChildren() });
const engine = launchCommand("fixture-engine", process.execPath, [${JSON.stringify(engine)}]);
let error = null;
try {
  await waitForChildOutput(engine, "ready");
  writeFileSync(process.env.FIXTURE_DIR + "/ready.json", JSON.stringify({ engine: engine.pid,
    leaf: Number(readFileSync(process.env.FIXTURE_DIR + "/leaf.pid", "utf8")) }));
  await cancellation.sleep(60_000);
} catch (caught) { error = caught.message; }
finally {
  await cancellation.waitForOwnedChildren();
  await stopHostChildren();
  await sleep(100);
  writeFileSync(out + "/cleanup-complete", "true");
  writeFileSync(out + "/summary.json", JSON.stringify({ passed: false, error }));
  process.exitCode = cancellation.exitCode ?? 1;
  cancellation.dispose();
}\n`);

  for (const { signal, stdio } of [
    { signal: "SIGINT", stdio: "inherit" },
    { signal: "SIGTERM", stdio: "inherit" },
    { signal: "SIGTERM", stdio: "ignore" },
  ]) {
    const directory = path.join(temp, `${signal}-${stdio}`);
    mkdirSync(directory);
    const output = path.join(directory, "run");
    let logs = "";
    active = spawn(process.execPath, [path.join(ROOT, "demo/burst-recovery.mjs"), "--pilot", `--out=${output}`], {
      cwd: ROOT, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FIXTURE_DIR: directory, FIXTURE_STDIO: stdio, NODE_OPTIONS: `--import=${pathToFileURL(hook).href}` },
    });
    active.stdout.on("data", (chunk) => { logs += chunk; });
    active.stderr.on("data", (chunk) => { logs += chunk; });
    const completed = new Promise((resolve, reject) => {
      active.once("error", reject);
      active.once("close", (code, receivedSignal) => resolve({ code, signal: receivedSignal }));
    });
    await eventually(() => existsSync(path.join(directory, "ready.json")), `${signal} trial readiness`);
    const pids = JSON.parse(readFileSync(path.join(directory, "ready.json"), "utf8"));
    // Signal the wrapper alone: the trial must receive the forwarded signal and
    // remove its detached process group before the wrapper writes the aggregate.
    active.kill(signal);
    const result = await Promise.race([completed, sleep(8_000).then(() => { throw new Error(`${signal} cleanup hung: ${logs}`); })]);
    active = null;
    assert.equal(result.code, signal === "SIGINT" ? 130 : 143, logs);
    const manifest = JSON.parse(readFileSync(path.join(output, "plan.json"), "utf8"));
    const [first, second] = manifest.commands;
    const trialOut = (command) => command.args.find((arg) => arg.startsWith("--out=")).slice(6);
    assert.ok(existsSync(path.join(trialOut(first), "cleanup-complete")), "wrapper must wait for child finally");
    assert.equal(existsSync(trialOut(second)), false, "interruption must prevent the next trial");
    const summary = JSON.parse(readFileSync(path.join(output, "summary.json"), "utf8"));
    assert.equal(summary.passed, false);
    assert.equal(summary.proof.passed, false);
    assert.match(summary.error, new RegExp(signal));
    assert.equal(summary.results.length, 2, "partial aggregate must retain all planned trials");
    await eventually(() => !alive(pids.engine) && !alive(pids.leaf), "owned detached engine descendants exit");
    console.log(`  ok  ${signal} with ${stdio} stdio waits for cleanup, kills detached descendants, skips the next trial, and retains invalid output`);
  }

  // The leader can also finish naturally before cleanup begins. Keep ownership
  // of its surviving group, and leave a separately launched process untouched.
  const orphanDirectory = path.join(temp, "closed-leader");
  mkdirSync(orphanDirectory);
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: process.platform !== "win32" });
  try {
    const leader = launchCommand("closed-leader", process.execPath, [engine], {
      env: { ...process.env, FIXTURE_DIR: orphanDirectory, FIXTURE_STDIO: "ignore", EXIT_LEADER: "true" },
    });
    await waitForChildOutput(leader, "ready");
    await eventually(() => leader.hostClosed, "leader closes without inherited leaf stdio");
    const leaf = Number(readFileSync(path.join(orphanDirectory, "leaf.pid"), "utf8"));
    assert.ok(alive(leaf), "stubborn descendant must still be alive before cleanup");
    assert.ok(hostChildren.has(leader), "leader close must retain ownership of live descendants");
    await stopHostChildren();
    await eventually(() => !alive(leaf), "closed leader's stubborn descendant exits");
    assert.equal(hostChildren.has(leader), false);
    assert.ok(alive(unrelated.pid), "cleanup must leave unrelated process groups untouched");
    console.log("  ok  cleanup retains a closed leader's group, kills its silent stubborn descendant, and leaves unrelated processes alone");
  } finally { killChildTree(unrelated, "SIGKILL"); }

  const target = new EventEmitter();
  const cancellation = installRunCancellation({ target });
  const server = createServer((_request, _response) => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/ready`;
    const readiness = waitFor(url, { timeoutMs: 60_000, signal: cancellation.signal });
    const request = fetchWithTimeout(url, { signal: cancellation.signal }, 60_000);
    const assertions = Promise.all([
      assert.rejects(readiness, /interrupted by SIGTERM/u),
      assert.rejects(request, /interrupted by SIGTERM/u),
    ]);
    target.emit("SIGTERM");
    await assertions;
    cancellation.dispose();
    assert.equal(target.listenerCount("SIGTERM"), 0);
    console.log("  ok  readiness and HTTP requests abort immediately and remove signal handlers");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    cancellation.dispose();
  }
  console.log("PASS run cancellation verification (no Docker or inference)");
} finally {
  if (active) killChildTree(active, "SIGKILL");
  await stopHostChildren();
  rmSync(temp, { recursive: true, force: true });
}
