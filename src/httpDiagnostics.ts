import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { AsyncLocalStorage } from "node:async_hooks";

// Generated at the supervisor boundary, stripped from public input and output.
// It never carries an MCP id, principal, URL, body or execution identity.
export const HTTP_DIAGNOSTIC_HEADER = "x-bridge-private-http-trace";
export const HTTP_DIAGNOSTIC_PHASES = [
  "admitted", "admission-rejected", "queued", "dispatch", "request-finished", "response-headers", "response-header-start",
  "response-end", "response-complete", "upstream-request-error",
  "upstream-response-error", "upstream-close", "idle-timeout", "caller-aborted",
  "caller-closed", "body-rejected", "cleanup", "application-dispatch",
  "application-response", "application-error", "application-start", "application-complete",
  "state-start", "state-yield"
] as const;

export type HttpObservation = {
  requestId: string;
  source: "ingress" | "child";
  phase: typeof HTTP_DIAGNOSTIC_PHASES[number];
  /** Event time at its source; IPC delivery order is not event order. */
  atUnixMs: number;
  /** Monotonic elapsed time within the source process, never across processes. */
  elapsedMs: number;
  responseStarted: boolean;
  headersSent: boolean;
  upstreamComplete: boolean;
  callerComplete: boolean;
  outcome: "not-observed" | "unknown";
  firstTermination: boolean;
  activeRequests?: number;
  activeBytes?: number;
  reusedSocket?: boolean;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_EVENTS_PER_REQUEST = 32;

/** A whole-session budget, not an unbounded per-request logger or ring buffer.
 * Retaining at most 128 small sessions lets a detached child's late completion
 * correlate after proxy cleanup. There are no request/response/body references.
 */
export class BoundedHttpDiagnostics {
  private readonly sessions = new Map<string, HttpDiagnosticSession>();
  private readonly maximumRequests: number;
  constructor(private readonly observe: (value: HttpObservation) => void, maximumRequests = 128) {
    this.maximumRequests = Number.isSafeInteger(maximumRequests)
      ? Math.max(0, Math.min(128, maximumRequests)) : 128;
  }

  start(source: HttpObservation["source"], trustedId?: string): HttpDiagnosticSession | undefined {
    if (this.sessions.size >= this.maximumRequests || trustedId !== undefined && !UUID.test(trustedId)) return;
    const id = trustedId ?? randomUUID();
    if (this.sessions.has(id)) return;
    const session = new HttpDiagnosticSession(id, source, this.observe);
    this.sessions.set(id, session);
    return session;
  }

  receiveChild(value: unknown): void {
    if (!isChildHttpObservation(value)) return;
    this.sessions.get(value.requestId)?.receiveChild(value);
  }
}

export class HttpDiagnosticSession {
  responseStarted = false;
  headersSent = false;
  upstreamComplete = false;
  callerComplete = false;
  outcome: HttpObservation["outcome"] = "not-observed";
  private readonly startedAt = performance.now();
  private events = 0;
  private terminated = false;
  private readonly recordedOnce = new Set<HttpObservation["phase"]>();
  constructor(readonly requestId: string, private readonly source: HttpObservation["source"],
    private readonly sink: (value: HttpObservation) => void) {}

  record(phase: HttpObservation["phase"], terminal = false,
    accounting?: Pick<HttpObservation, "activeRequests" | "activeBytes" | "reusedSocket">): void {
    const firstTermination = terminal && !this.terminated;
    this.terminated ||= terminal;
    this.emit({ requestId: this.requestId, source: this.source, phase,
      atUnixMs: Date.now(), elapsedMs: performance.now() - this.startedAt,
      responseStarted: this.responseStarted, headersSent: this.headersSent,
      upstreamComplete: this.upstreamComplete, callerComplete: this.callerComplete,
      outcome: this.outcome, firstTermination, ...accounting });
  }

  receiveChild(value: HttpObservation): void {
    // Reconstruct the allowlisted record: never forward arbitrary IPC fields.
    this.emit({ requestId: value.requestId, source: "child", phase: value.phase,
      atUnixMs: value.atUnixMs, elapsedMs: value.elapsedMs,
      responseStarted: value.responseStarted, headersSent: value.headersSent,
      upstreamComplete: value.upstreamComplete, callerComplete: value.callerComplete,
      outcome: this.outcome, firstTermination: false });
  }

  recordOnce(phase: HttpObservation["phase"]): boolean {
    if (this.recordedOnce.has(phase)) return false;
    this.recordedOnce.add(phase);
    this.record(phase);
    return true;
  }

  private emit(value: HttpObservation): void {
    if (this.events >= MAX_EVENTS_PER_REQUEST) return;
    this.events += 1;
    try { this.sink(value); } catch { /* Evidence cannot change request behavior. */ }
  }
}

/** Correlation only: it is never an authorization, cancellation or replay context. */
export const httpDiagnosticContext = new AsyncLocalStorage<HttpDiagnosticSession | undefined>();

export function isChildHttpObservation(value: unknown): value is HttpObservation {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.requestId === "string" && UUID.test(row.requestId) && row.source === "child" &&
    HTTP_DIAGNOSTIC_PHASES.includes(row.phase as HttpObservation["phase"]) &&
    typeof row.atUnixMs === "number" && Number.isSafeInteger(row.atUnixMs) && row.atUnixMs >= 0 &&
    typeof row.elapsedMs === "number" && Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0 &&
    ["responseStarted", "headersSent", "upstreamComplete", "callerComplete", "firstTermination"]
      .every(key => typeof row[key] === "boolean") &&
    (row.outcome === "not-observed" || row.outcome === "unknown");
}
