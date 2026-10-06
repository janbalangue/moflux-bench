import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { BURST_CLOCK_LIMITS, captureClockSample } from "./burst-clock-lib.mjs";
import { startContainerClockProbe } from "./burst-clock-probe.mjs";
import { waitForBurstHostReady } from "./burst-host-preflight-lib.mjs";
import { BURST_CLOCK_PREFLIGHT_MS, burstV4Preflight } from "./burst-v4-analysis-lib.mjs";

export const BURST_PROBE_SERVICES = Object.freeze({ tyr: "tyr-moflux", latchflo: "latchflo" });
const MAX_REPORT_BYTES = 4096;
const PROBE_START_ATTEMPTS = 20;

/**
 * Paired host readings and container probes on independent loops, so a slow
 * probe cannot thin the host series. Every failed probe stays as a row.
 */
function startCapture(probes, { sleep, signal }) {
  const clockSamples = [captureClockSample()];
  const clockAlignment = Object.fromEntries(Object.keys(probes).map((name) => [name, []]));
  const errors = [];
  let running = true;
  const guard = (loop) => loop().catch(() => { errors.push(signal?.aborted ? "cancelled" : "clock_capture_failed"); });
  const loops = [guard(async () => {
    while (running) {
      await sleep(BURST_CLOCK_LIMITS.sampleIntervalMs);
      if (running) clockSamples.push(captureClockSample());
    }
  }), ...Object.entries(probes).map(([name, probe]) => guard(async () => {
    while (running) {
      clockAlignment[name].push(await probe.sample());
      if (running) await sleep(BURST_CLOCK_LIMITS.sampleIntervalMs);
    }
  }))];
  return {
    failed: () => errors.length > 0,
    async stop() {
      running = false;
      await Promise.all(loops);
      // Keep a real endpoint even when the last regular tick preceded completion.
      if (!signal?.aborted) {
        const last = await Promise.all(Object.values(probes).map((probe) => probe.sample()));
        Object.keys(probes).forEach((name, index) => clockAlignment[name].push(last[index]));
      }
      clockSamples.push(captureClockSample());
      return { clockSamples, clockAlignment, errors };
    },
  };
}

const describeFailures = (failures) => Object.entries(failures)
  .map(([source, reasons]) => `${source}: ${reasons.join(", ")}`).join("; ");

/**
 * Read-only burst-recovery-v4 runtime: a full-duration clock preflight, a host
 * memory preflight, then clock capture and a loopback readiness endpoint for
 * the measured trace. No policy change, model request or host mutation. Either
 * preflight failing throws before any trace request is sent.
 */
export async function startBurstRuntime({ dockerArgs, cwd, env, signal, sleep,
  readPressure, readPoolStats, writePreflight, onProgress = () => {},
  clockPreflightMs = BURST_CLOCK_PREFLIGHT_MS, startProbe = startContainerClockProbe,
  waitForHost = waitForBurstHostReady }) {
  const probes = {};
  const setupReports = [];
  let capture = null, server = null, stopped = null;
  const stop = () => stopped ??= (async () => {
    const timing = capture ? await capture.stop()
      : { clockSamples: [], clockAlignment: {}, errors: ["capture_not_started"] };
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await Promise.all(Object.values(probes).map((probe) => probe.stop()));
    return { ...timing, setupReports };
  })();
  try {
    for (const [name, service] of Object.entries(BURST_PROBE_SERVICES)) {
      probes[name] = await startProbe({ args: [...dockerArgs, "exec", "-T", service], cwd, env, signal });
    }
    // docker exec start-up delays a probe's first answers. Wait for a live
    // one so that start-up is not recorded as missing clock evidence.
    for (const [name, probe] of Object.entries(probes)) {
      let live = false;
      for (let attempt = 0; attempt < PROBE_START_ATTEMPTS && !live; attempt++) {
        if (signal?.aborted) throw signal.reason ?? new Error("burst preflight cancelled");
        live = !(await probe.sample()).error;
      }
      if (!live) throw new Error(`burst clock probe for ${name} did not answer; trial not started`);
    }
    onProgress(`checking host and container clocks for ${Math.round(clockPreflightMs / 1000)} s before collection`);
    const preflightCapture = startCapture(probes, { sleep, signal });
    const startedMono = performance.now();
    let clockTiming;
    try {
      // A dead capture loop cannot recover; stop waiting and retain the evidence.
      while (!preflightCapture.failed() && performance.now() - startedMono < clockPreflightMs) {
        await sleep(Math.min(1000, Math.max(1, clockPreflightMs - (performance.now() - startedMono))));
      }
    } finally { clockTiming = await preflightCapture.stop(); }
    const preflight = { schemaVersion: 1, host: null,
      clock: { requiredDurationMs: clockPreflightMs, durationMs: performance.now() - startedMono, ...clockTiming } };
    await writePreflight(preflight);
    const clock = burstV4Preflight(preflight, { requiredClockDurationMs: clockPreflightMs }).clock;
    if (!clock.passed) {
      throw new Error(`burst clock preflight failed (${describeFailures(clock.failures)}); trial not started`);
    }
    onProgress(`clock preflight passed: host slew ${clock.host.fittedSlewPpm.toFixed(1)} ppm, ` +
      `container alignment within ${Math.max(clock.tyr.maxUncertaintyMs, clock.latchflo.maxUncertaintyMs)} ms`);
    onProgress("waiting for 10 s of normal memory pressure with no new swap-outs");
    preflight.host = await waitForHost({ readPressure, sleep, signal });
    await writePreflight(preflight);
    const host = burstV4Preflight(preflight, { requiredClockDurationMs: clockPreflightMs }).host;
    if (!host.passed) {
      throw new Error(`burst host preflight failed (${host.reason}): no 10 s of normal memory pressure ` +
        "without swap-out growth within 60 s; trial not started");
    }
    onProgress("host preflight passed: memory pressure normal and swap-outs flat");
    // Preflight evidence stays separate from the measured capture.
    capture = startCapture(probes, { sleep, signal });
    const route = `/${randomBytes(24).toString("hex")}`;
    server = createServer(async (request, response) => {
      if (request.url !== route || !["GET", "POST"].includes(request.method)) { response.writeHead(404).end(); return; }
      try {
        if (request.method === "POST") {
          // The load generator's checkpoint verdict, shown as soon as it exists.
          let body = "";
          for await (const chunk of request) {
            body += chunk;
            if (body.length > MAX_REPORT_BYTES) throw new Error("report too large");
          }
          const report = JSON.parse(body);
          const reasons = Array.isArray(report?.reasons) ? report.reasons.filter((r) => typeof r === "string").slice(0, 16) : [];
          const status = report?.status === "ready" ? "ready" : "missed";
          setupReports.push({ receivedAtEpochMs: Date.now(), status, reasons });
          onProgress(status === "ready" ? "setup readiness confirmed before setup request 1"
            : `SETUP READINESS MISSED (${reasons.join(", ") || "unknown"}); this trial is invalid, arrivals continue unchanged`);
          response.writeHead(204).end();
          return;
        }
        const sampleStartedAtEpochMs = Date.now();
        const batch = (await readPoolStats())?.admissionClasses?.classes?.batch;
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ sampleStartedAtEpochMs, observedAtEpochMs: Date.now(),
          batchInFlight: batch?.inFlight ?? null,
          batchProtectedConcurrent: batch?.limits?.protectedConcurrent ?? null }));
      } catch { response.writeHead(503).end(JSON.stringify({ error: "readiness_unavailable" })); }
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    return { readinessUrl: `http://127.0.0.1:${server.address().port}${route}`, preflight, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
