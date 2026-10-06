import { spawn as spawnProcess } from "node:child_process";
import { captureClockSample } from "./burst-clock-lib.mjs";

// Fixed read-only program. Each newline asks for one current paired reading;
// user input is only an integer correlation ID and is never executed.
export const CONTAINER_CLOCK_PROGRAM = `
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!/^\\d{1,12}$/.test(line)) return;
  const before = Number(process.hrtime.bigint()) / 1e6;
  const epochMs = Date.now();
  const after = Number(process.hrtime.bigint()) / 1e6;
  process.stdout.write(JSON.stringify({ id: Number(line), epochMs,
    monotonicMs: (before + after) / 2, readSpanMs: after - before }) + "\\n");
});`;

/**
 * Start one persistent `docker compose exec` clock reader. args is an optional
 * command prefix (including compose/exec/service); the fixed node program is
 * appended. sample() never exposes Docker stderr and returns explicit error
 * records so a failed capture cannot silently disappear from analysis.
 */
export async function startContainerClockProbe({ command = "docker", args, service, cwd, env = process.env,
  signal, timeoutMs = 1000, spawn = spawnProcess } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Clock probe timeout must be positive");
  if (!args && !service) throw new Error("Clock probe requires a service or command prefix");
  const argv = [...(args ?? ["compose", "exec", "-T", service]), "node", "-e", CONTAINER_CLOCK_PROGRAM];
  let child, stopped = false, failure = null, buffer = "", nextId = 0, stopPromise;
  const pending = new Map();
  function finish(id, remote, error) {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id); clearTimeout(request.timer);
    const received = captureClockSample();
    request.resolve({ sampleId: id,
      hostSentEpochMs: request.sent.epochMs, hostSentMonotonicMs: request.sent.monotonicMs,
      hostSentReadSpanMs: request.sent.readSpanMs,
      hostReceivedEpochMs: received.epochMs, hostReceivedMonotonicMs: received.monotonicMs,
      hostReceivedReadSpanMs: received.readSpanMs,
      remoteEpochMs: remote?.epochMs ?? null, remoteMonotonicMs: remote?.monotonicMs ?? null,
      remoteReadSpanMs: remote?.readSpanMs ?? null, ...(error ? { error } : {}) });
  }
  function fail(code) {
    failure ??= code;
    for (const id of pending.keys()) finish(id, null, code);
  }
  function abort() { fail("aborted"); void stop(); }
  if (signal?.aborted) failure = "aborted";
  else {
    try {
      child = spawn(command, argv, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      child.on("error", () => fail("spawn_error"));
      child.on("exit", () => fail(stopped ? "stopped" : "process_exited"));
      child.stdin.on("error", () => fail("write_error"));
      // Drain output without saving command lines, container errors or secrets.
      child.stderr?.resume();
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        if (buffer.length > 8192) { fail("invalid_response"); void stop(); return; }
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          let remote;
          try { remote = JSON.parse(line); } catch { fail("invalid_response"); void stop(); return; }
          if (!Number.isSafeInteger(remote?.id) || ![remote.epochMs, remote.monotonicMs, remote.readSpanMs]
            .every((value) => typeof value === "number" && Number.isFinite(value))) {
            fail("invalid_response"); void stop(); return;
          }
          finish(remote.id, remote);
        }
      });
      signal?.addEventListener("abort", abort, { once: true });
    } catch { failure = "spawn_error"; }
  }
  function sample() {
    const id = ++nextId, sent = captureClockSample();
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish(id, null, "timeout"), timeoutMs);
      pending.set(id, { sent, resolve, timer });
      if (failure || stopped || !child) finish(id, null, failure ?? "stopped");
      else {
        try { child.stdin.write(`${id}\n`, (error) => { if (error) finish(id, null, "write_error"); }); }
        catch { finish(id, null, "write_error"); }
      }
    });
  }
  async function stop() {
    if (stopPromise) return stopPromise;
    stopped = true; signal?.removeEventListener("abort", abort); fail(failure ?? "stopped");
    stopPromise = new Promise((resolve) => {
      if (!child || child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      let timer;
      const done = () => { clearTimeout(timer); resolve(); };
      child.once("exit", done);
      child.stdin.end();
      child.kill("SIGTERM");
      timer = setTimeout(() => { child.kill("SIGKILL"); child.removeListener("exit", done); resolve(); }, 500);
    });
    return stopPromise;
  }
  return { sample, stop };
}
