import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

/** Signals request cancellation; callers finish their finally blocks before exiting. */
export function installRunCancellation({ onInterrupt = async () => {}, target = process } = {}) {
  const controller = new AbortController();
  let signalName = null;
  let stopping = Promise.resolve();
  const handlers = new Map();
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const handler = () => {
      if (controller.signal.aborted) return;
      signalName = name;
      const reason = new Error(`run interrupted by ${name}`);
      reason.code = "RUN_INTERRUPTED";
      controller.abort(reason);
      // Observe rejection immediately, even when the main task is still unwinding.
      stopping = Promise.resolve().then(() => onInterrupt(name)).then(
        () => null,
        (error) => error,
      );
    };
    handlers.set(name, handler);
    target.on(name, handler);
  }
  return {
    signal: controller.signal,
    get interrupted() { return controller.signal.aborted; },
    get signalName() { return signalName; },
    get exitCode() { return signalName === "SIGINT" ? 130 : signalName === "SIGHUP" ? 129 : signalName ? 143 : null; },
    throwIfInterrupted() { controller.signal.throwIfAborted(); },
    async waitForOwnedChildren() {
      const error = await stopping;
      if (error) throw error;
    },
    async sleep(ms) {
      try { await delay(ms, undefined, { signal: controller.signal }); }
      catch (error) { controller.signal.throwIfAborted(); throw error; }
    },
    dispose() { for (const [name, handler] of handlers) target.removeListener(name, handler); },
  };
}

/** Forward cancellation once, then await cooperative child cleanup and closed stdio. */
export function runCooperativeChild(command, argv, {
  cancellation = null,
  cwd,
  env = process.env,
  inherit = true,
} = {}) {
  cancellation?.throwIfInterrupted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { cwd, env, stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", spawnError = null;
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    const interrupt = () => child.kill(cancellation.signalName ?? "SIGTERM");
    cancellation?.signal.addEventListener("abort", interrupt, { once: true });
    if (cancellation?.interrupted) interrupt();
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (status, signal) => {
      cancellation?.signal.removeEventListener("abort", interrupt);
      if (spawnError) reject(spawnError);
      else resolve({ status, signal, stdout, stderr });
    });
  });
}
