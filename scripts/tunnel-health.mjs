import { Agent, request } from "node:http";
import { performance } from "node:perf_hooks";
import { readPrivateFile } from "./managed-file.mjs";
import { MAX_TUNNEL_CONTROL_PLANE_AGE_MS } from "./runtime-status.mjs";

// Direct GETs still poll. Keep this independent of bridge/event liveness.
export const TUNNEL_HEALTH_TIMEOUT_MS = 2_000;
const POLL_METRIC = "commands_poll_last_successful_timestamp_seconds";
const MAX_METRIC_LINE_BYTES = 1024 * 1024;

export function createTunnelHealthObserver({ urlFile, pidFile, expectedPid, timeoutMs = TUNNEL_HEALTH_TIMEOUT_MS }) {
  const agent = new Agent({ keepAlive: true, maxSockets: 3, maxFreeSockets: 3 });
  let identity;
  let lastSuccessfulPoll = null;
  let confirmed = false;
  let inFlight;
  let closed = false;

  function locator() {
    const pidText = readPrivateFile(pidFile, { encoding: "utf8" }).trim();
    if (!/^[1-9][0-9]*$/.test(pidText) || Number(pidText) !== expectedPid) throw new Error("pid-mismatch");
    const url = new URL(readPrivateFile(urlFile, { encoding: "utf8" }).trim());
    // The launcher starts its owned daemon on 127.0.0.1:0. Do not follow a
    // rewritten locator to DNS, a remote host, credentials, or a redirect.
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port ||
        url.username || url.password || url.search || url.hash ||
        !["/", "/healthz", "/readyz"].includes(url.pathname)) throw new Error("locator-invalid");
    return url.origin;
  }

  function alive() {
    try { process.kill(expectedPid, 0); return true; }
    catch (error) { return error.code === "EPERM"; }
  }

  function reset() { identity = undefined; lastSuccessfulPoll = null; confirmed = false; agent.destroy(); }

  async function observe(signal) {
    const started = performance.now();
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted || closed) controller.abort();
    // Wall-clock and monotonic checks below also reject late success when the
    // parent loop could not run this timer at the deadline.
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const failedEndpoint = failure => ({ status: null, failure });
    let healthz = failedEndpoint("not-observed");
    let readyz = failedEndpoint("not-observed");
    let poll = { value: null, failure: "not-observed" };
    let failure = null;
    let base;
    try {
      try { base = locator(); }
      catch (error) { failure = error.message === "pid-mismatch" ? "pid-mismatch" : "locator-invalid"; reset(); }
      if (base && identity !== base) { reset(); identity = base; }
      if (!alive()) { failure = "process-exited"; reset(); }
      if (!failure) {
        [healthz, readyz, poll] = await Promise.all([
          probeEndpoint(base, "/healthz", agent, controller.signal, started + timeoutMs),
          probeEndpoint(base, "/readyz", agent, controller.signal, started + timeoutMs),
          probeEndpoint(base, "/metrics", agent, controller.signal, started + timeoutMs, true)
        ]);
        // Files are not cached: fence a locator/PID replacement during a read.
        try { if (locator() !== base) failure = "locator-changed"; }
        catch { failure = "locator-changed"; }
        if (!alive()) failure = "process-exited";
        if (failure) reset();
        else {
          const now = Date.now();
          const timely = performance.now() - started < timeoutMs && !controller.signal.aborted;
          if (!timely) {
            failure = signal?.aborted || closed ? "aborted" : "timeout";
            // Never admit a response delivered after the absolute deadline.
            // Each request rejects late responses itself. Preserve a metric
            // or endpoint that settled before the shared deadline.
          }
          if (poll.value !== null) {
            if (poll.value > 0 && poll.value * 1000 <= now + 5_000) lastSuccessfulPoll = poll.value * 1000;
            else { poll.failure = "poll-unverified"; confirmed = false; }
          }
          const negative = [healthz, readyz].some(endpoint => endpoint.status !== null &&
            (endpoint.status < 200 || endpoint.status >= 300));
          if (negative) { failure = "endpoint-failed"; confirmed = false; }
          const fresh = lastSuccessfulPoll !== null && now - lastSuccessfulPoll >= -5_000 &&
            now - lastSuccessfulPoll <= MAX_TUNNEL_CONTROL_PLANE_AGE_MS;
          if (!fresh) { failure ??= "poll-stale-or-unverified"; confirmed = false; }
          failure ??= healthz.failure ?? readyz.failure ?? poll.failure;
          if (!failure && fresh) confirmed = true;
        }
      }
      const now = Date.now();
      const fresh = lastSuccessfulPoll !== null && now - lastSuccessfulPoll >= -5_000 &&
        now - lastSuccessfulPoll <= MAX_TUNNEL_CONTROL_PLANE_AGE_MS;
      const processRunning = alive();
      if (!processRunning) { failure = "process-exited"; reset(); }
      return {
        connected: processRunning && confirmed && fresh,
        processRunning,
        reason: failure && [failure, ...Object.entries({ healthz, readyz })
          .filter(([, endpoint]) => endpoint.status !== null && (endpoint.status < 200 || endpoint.status >= 300))
          .map(([name, endpoint]) => `${name}=${endpoint.status}`)].join(", "),
        observation: {
          healthz, readyz,
          controlPlanePoll: { lastSuccessfulAt: lastSuccessfulPoll === null ? null : new Date(lastSuccessfulPoll).toISOString(),
            fresh: processRunning && fresh && lastSuccessfulPoll !== null, failure: poll.failure },
          failure
        }
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  return {
    probe({ signal } = {}) {
      // Share physical work, including the final identity checks. The launcher
      // owns cancellation; observers cannot start a second simultaneous probe.
      if (!inFlight) inFlight = observe(signal).finally(() => { inFlight = undefined; });
      return inFlight;
    },
    close() { closed = true; agent.destroy(); reset(); }
  };
}

function probeEndpoint(base, path, agent, signal, deadline, metric = false) {
  return new Promise(resolve => {
    let settled = false;
    let status = null;
    let bytes = 0;
    let line = Buffer.alloc(0);
    let req;
    const finish = (failure, value = null) => {
      if (settled) return;
      if (performance.now() >= deadline) { failure = "timeout"; value = null; status = null; }
      settled = true;
      resolve(metric ? { value, failure } : { status, failure });
      req?.destroy();
    };
    req = request(new URL(path, base), { method: "GET", agent, signal }, response => {
      status = response.statusCode;
      if (!metric && (status < 200 || status >= 300)) { finish("endpoint-failed"); return; }
      if (metric && status !== 200) { finish("metrics-failed"); return; }
      response.on("data", chunk => {
        if (settled) return;
        if (!metric) {
          bytes += chunk.length;
          if (bytes >= 4096) finish(status >= 200 && status < 300 ? null : "endpoint-failed");
          return;
        }
        // Match the CLI's named Prometheus sample; retain at most one bounded
        // line and no raw response/URL/error in the status record.
        let remaining = chunk;
        while (remaining.length && !settled) {
          const newline = remaining.indexOf(10);
          const part = newline < 0 ? remaining : remaining.subarray(0, newline);
          if (line.length + part.length > MAX_METRIC_LINE_BYTES) { finish("metrics-line-limit"); return; }
          line = Buffer.concat([line, part]);
          if (newline < 0) break;
          const value = parsePollMetric(line.toString("utf8"));
          line = Buffer.alloc(0);
          if (value !== null) { finish(null, value); return; }
          remaining = remaining.subarray(newline + 1);
        }
      });
      response.on("end", () => {
        if (metric) {
          const value = parsePollMetric(line.toString("utf8"));
          finish(value === null ? "poll-unverified" : null, value);
        } else finish(status >= 200 && status < 300 ? null : "endpoint-failed");
      });
      response.on("error", () => finish(signal.aborted ? "timeout" : "transport-error"));
      response.on("aborted", () => finish(signal.aborted ? "timeout" : "transport-error"));
    });
    req.on("error", () => finish(signal.aborted ? "timeout" : "transport-error"));
    req.end();
  });
}

function parsePollMetric(line) {
  const text = line.trim();
  if (!text.startsWith(POLL_METRIC + " ") && !text.startsWith(POLL_METRIC + "{")) return null;
  const value = Number(text.split(/\s+/).at(-1));
  return Number.isFinite(value) ? value : null;
}
