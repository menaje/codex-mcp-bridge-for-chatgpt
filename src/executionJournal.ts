import { createHash } from "node:crypto";

type Message = { type: string; requestId?: string; sequence?: number; [key: string]: any };
type Entry = {
  fingerprint: string;
  retained: boolean;
  control: boolean;
  lane: ExecutionLane;
  createdAt: number;
  completedAt?: number;
  sequence: number;
  sent: number;
  events: Map<string, Message>;
  terminal?: Message;
  deliveryFailure?: string;
  abandoned?: boolean;
  acknowledged?: boolean;
};

const RESULT_BYTES = 8 * 1024 * 1024;
const EVENT_BYTES = 8 * 1024 * 1024;
const ORDINARY_PROGRESS_BYTES = 64 * 1024;
export const EXECUTION_LANE_CAPACITIES = { execution: 30, inspection: 8, metadata: 8, control: 6 } as const;
export type ExecutionLane = keyof typeof EXECUTION_LANE_CAPACITIES;
export type ExecutionJournalStatus = {
  observedAt: number;
  lanes: Record<ExecutionLane, { capacity: number; used: number; active: number;
    awaitingAcknowledgement: number; awaitingCommitAcknowledgement: number; oldestAcknowledgementMs: number }>;
};
export function executionLane(operation: string, control: boolean): ExecutionLane {
  if (control) return "control";
  if (["callTool", "startThread", "continueThread", "forkThread"].includes(operation)) return "execution";
  if (["probeThread", "listBackgroundTerminals", "listLoadedBackgroundTerminals"].includes(operation)) return "inspection";
  return "metadata";
}

/**
 * Bounded execution receipts, owned by the process holding the Codex pipes.
 * At most 52 * (8 MiB result + 8 MiB events) are reserved. Results are released
 * only after the DB owner acknowledges its commit. No database is opened here.
 * Ordinary progress is a snapshot; live questions and exact terminal outcomes
 * are retained. An exhausted per-request reservation is explicit containment,
 * never authority to kill the owner or unrelated workers.
 */
export class ExecutionJournal {
  private readonly entries = new Map<string, Entry>();
  private readonly acknowledged = new Set<string>();
  private link?: (message: Message, done: (error?: Error | null) => void) => boolean;
  private sending = false;
  private receiptBurst = 0;
  private epoch = 0;
  private controllerId?: string;
  private readonly auxiliary = new Map<string, Message>();

  constructor(private readonly generation: string,
    private readonly contain: (requestId: string, assignment: unknown, reason: string) => void) {}

  admit(request: Message, control: boolean): "new" | "existing" | "rejected" {
    const id = request.requestId!;
    const fingerprint = createHash("sha256").update(JSON.stringify([request.operation, request.args])).digest("hex");
    const entry = this.entries.get(id);
    if (entry) {
      if (entry.fingerprint !== fingerprint) this.replyError(id, "EXECUTION_IDENTITY_CONFLICT");
      else { entry.sent = Math.min(entry.sent, request.afterSequence || 0); this.pump(); }
      return "existing";
    }
    if (this.acknowledged.has(id)) { this.replyError(id, "EXECUTION_ALREADY_ACKNOWLEDGED"); return "rejected"; }
    const lane = executionLane(request.operation, control);
    const used = [...this.entries.values()].filter(entry => entry.lane === lane).length;
    if (used >= EXECUTION_LANE_CAPACITIES[lane]) {
      const code = lane === "execution" ? "EXECUTION_RETENTION_CAPACITY" : `EXECUTION_${lane.toUpperCase()}_CAPACITY`;
      this.replyError(id, code, `${lane} receipts are full (${used}/${EXECUTION_LANE_CAPACITIES[lane]}). Retry after active requests settle and receipt acknowledgements drain. Agent/Activity history does not occupy this capacity.`);
      return "rejected";
    }
    this.entries.set(id, { fingerprint, retained: request.retained === true, control, lane, createdAt: Date.now(),
      sequence: 0, sent: 0, events: new Map() });
    return "new";
  }
  recover(requestId: string, afterSequence = 0): void {
    const entry = this.entries.get(requestId);
    if (!entry) { this.replyError(requestId, "CODEX_WORKER_LOST", "The execution owner has no receipt for this exact Job; no turn was replayed."); return; }
    entry.sent = afterSequence;
    this.pump();
  }
  acknowledge(requestId: string): void {
    const entry = this.entries.get(requestId);
    if (!entry) return;
    if (!entry.terminal) { entry.acknowledged = true; return; }
    this.entries.delete(requestId);
    this.acknowledged.add(requestId);
    // The DB owns deduplication after acknowledgement. Retain a bounded extra
    // defense against stale messages from this control connection.
    if (this.acknowledged.size > 4096) this.acknowledged.delete(this.acknowledged.values().next().value!);
  }
  connect(link: NonNullable<ExecutionJournal["link"]>, controllerId = "default"): void {
    if (this.controllerId && this.controllerId !== controllerId) {
      for (const [id, entry] of this.entries) if (!entry.retained) {
        // Durable control ledgers in the replacement state owner mark these
        // dispatches uncertain. They are never silently resent as new actions.
        if (entry.terminal) this.entries.delete(id);
        else entry.abandoned = true;
      }
    }
    this.controllerId = controllerId;
    this.epoch += 1;
    this.link = link;
    this.sending = false;
    // Subscribe/recover messages select receipts after every reconnect. Do not
    // publish another state's private events before it requests those IDs.
    for (const entry of this.entries.values()) entry.sent = Number.MAX_SAFE_INTEGER;
    this.pump();
  }
  disconnect(): void { this.epoch += 1; this.link = undefined; this.sending = false; this.auxiliary.clear(); }
  get size(): number { return this.entries.size; }
  status(now = Date.now()): ExecutionJournalStatus {
    const lanes = Object.fromEntries(Object.entries(EXECUTION_LANE_CAPACITIES).map(([lane, capacity]) => {
      const entries = [...this.entries.values()].filter(entry => entry.lane === lane);
      const completed = entries.filter(entry => entry.terminal);
      return [lane, { capacity, used: entries.length, active: entries.length - completed.length,
        awaitingAcknowledgement: completed.length, awaitingCommitAcknowledgement: completed.filter(entry => entry.retained).length,
        oldestAcknowledgementMs: completed.reduce((oldest, entry) => Math.max(oldest, now - entry.completedAt!), 0) }];
    })) as ExecutionJournalStatus["lanes"];
    return { observedAt: now, lanes };
  }
  send(message: Message): void {
    const entry = message.requestId ? this.entries.get(message.requestId) : undefined;
    if (!entry || !["progress", "assignment", "response"].includes(message.type)) {
      const key = message.type === "release-check" ? `check:${message.checkId}` :
        message.type === "acknowledged" ? `ack:${message.requestId}` :
        message.type === "late-response" ? `late:${message.response.workerId}:${message.response.workerGeneration}:${message.response.requestId}` : message.type;
      if (this.auxiliary.size >= 256 && !this.auxiliary.has(key)) return;
      // Auxiliary observations have no execution-state authority.
      if (encodedBytes(message) <= RESULT_BYTES) this.auxiliary.set(key, message);
      this.pump(); return;
    }
    if (entry.terminal) return;
    const event = { ...message, sequence: ++entry.sequence };
    if (message.type === "response") {
      if (entry.abandoned || entry.acknowledged) { this.entries.delete(message.requestId!); return; }
      entry.completedAt = Date.now();
      if (entry.deliveryFailure || encodedBytes(event) > RESULT_BYTES || !Number.isFinite(encodedBytes(event))) {
        entry.terminal = { type: "response", generation: this.generation, requestId: message.requestId,
          sequence: event.sequence, ok: false,
          error: { code: entry.deliveryFailure || "EXECUTION_RESPONSE_TOO_LARGE",
            message: "The execution settled, but its payload exceeded the reserved delivery capacity." } };
      } else entry.terminal = event;
      // Completed questions are no longer answerable. Assignment remains for
      // recovering a session created immediately before controller loss.
      for (const key of entry.events.keys()) if (key !== "assignment") entry.events.delete(key);
    } else {
      const interactionId = message.interactionId;
      const resolvedId = message.progress?.event?.details?.resolvedInteractionId;
      if (typeof resolvedId === "string") entry.events.delete(`input:${resolvedId}`);
      const key = message.type === "assignment" ? "assignment" : interactionId ? `input:${interactionId}` :
        resolvedId ? `resolved:${resolvedId}` : "progress";
      const bytes = encodedBytes(event);
      // Optional history/progress can be coalesced. Current input cannot.
      if (key === "progress" && bytes > ORDINARY_PROGRESS_BYTES) return;
      const retainedBytes = [...entry.events].reduce((sum, [oldKey, value]) => sum + (oldKey === key ? 0 : encodedBytes(value)), 0);
      if (bytes + retainedBytes > EVENT_BYTES || entry.events.size > 64) {
        if (!entry.deliveryFailure) {
          entry.deliveryFailure = "EXECUTION_EVENT_RETENTION_EXHAUSTED";
          // A small error reserve is independent of the exhausted event payload.
          entry.events.set("delivery-failure", { type: "progress", generation: this.generation,
            requestId: message.requestId, sequence: ++entry.sequence, progress: {
              progress: 0, message: "Execution delivery capacity exhausted; exact-turn interruption requested.",
              event: { eventId: `delivery-failure:${message.requestId}`, type: "error", phase: "updated",
                createdAt: Date.now(), summary: "Execution delivery capacity exhausted; original execution remains unconfirmed until protocol settlement." }
            } });
          this.contain(message.requestId!, entry.events.get("assignment")?.assignment, entry.deliveryFailure);
        }
        this.pump();
        return;
      }
      entry.events.set(key, event);
    }
    this.pump();
  }
  private replyError(requestId: string, code: string, message = code): void {
    // At most the parent's bounded pending set can request error receipts.
    const key = `error:${requestId}`;
    if (this.auxiliary.size < 256 || this.auxiliary.has(key)) this.auxiliary.set(key, {
      type: "response", generation: this.generation, requestId, ok: false, error: { code, message }
    });
    this.pump();
  }
  private pump(): void {
    if (this.sending || !this.link) return;
    let entry: Entry | undefined;
    let message: Message | undefined;
    for (const candidate of this.entries.values()) {
      if (this.receiptBurst >= 8 && this.auxiliary.size) break;
      const messages = [...candidate.events.values(), ...(candidate.terminal ? [candidate.terminal] : [])]
        .filter(event => event.sequence! > candidate.sent)
        .sort((a, b) => a.sequence! - b.sequence!);
      if (messages.length) { entry = candidate; message = messages[0]; break; }
    }
    let auxiliaryKey: string | undefined;
    if (!message) {
      const next = this.auxiliary.entries().next().value;
      if (next) [auxiliaryKey, message] = next;
    }
    if (!message) return;
    const epoch = this.epoch;
    this.sending = true;
    this.link(message, error => {
      if (epoch !== this.epoch) return;
      this.sending = false;
      if (error) { this.disconnect(); return; }
      if (entry) {
        this.receiptBurst += 1;
        entry.sent = message!.sequence!;
        // Round-robin receipt delivery keeps a noisy worker from starving peers.
        const id = message!.requestId!;
        if (this.entries.get(id) === entry) { this.entries.delete(id); this.entries.set(id, entry); }
      }
      if (auxiliaryKey) {
        this.receiptBurst = 0;
        if (this.auxiliary.get(auxiliaryKey) === message) this.auxiliary.delete(auxiliaryKey);
      }
      // Yield to the worker pipes; do not recursively drain synchronous fakes.
      setImmediate(() => this.pump());
    });
  }
}

function encodedBytes(value: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(value), "utf8"); } catch { return Infinity; }
}
