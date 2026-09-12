import { createHash } from "node:crypto";
import type {
  McpServer,
  RegisteredTool
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  ToolAnnotations,
  ToolExecution
} from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

/**
 * The complete mutable portion of one SDK registered-tool descriptor.
 *
 * Schema objects are treated as immutable values. JSON-shaped descriptor
 * fields are cloned and frozen when a snapshot is admitted so a caller cannot
 * mutate the coordinator's signature behind its back.
 */
export type SdkToolDescriptorSnapshot = {
  title?: string;
  description?: string;
  inputSchema?: z.ZodType;
  outputSchema?: z.ZodType;
  annotations?: ToolAnnotations;
  execution?: ToolExecution;
  _meta?: Record<string, unknown>;
  /** Internal admission authority carried with the exact public descriptor. */
  admissionRef?: string;
  /** Internal catalog generation used to recompute admission after settings races. */
  admissionCatalogFingerprint?: string | null;
  /**
   * Whether this registration is present in the advertised tool list.
   *
   * The SDK's RegisteredTool.remove() is intentionally not used here because
   * it permanently removes the original name binding and cannot restore that
   * same registration. Presence is therefore projected reversibly by combining
   * this flag with enabled when updating the registered tool.
   */
  present: boolean;
  enabled: boolean;
};

export type SdkToolDescriptorSnapshotInput = Omit<
  SdkToolDescriptorSnapshot,
  "present" | "enabled"
> & {
  present?: boolean;
  enabled?: boolean;
};

export type SdkToolDescriptorProjectionStatus = {
  descriptorProjectionUpdated: boolean;
  developerModeRefreshRequired: boolean;
  descriptorEpoch: number;
  descriptorFingerprint: string | null;
  notificationQueued: boolean;
  bindingCount: number;
};

export type SdkToolDescriptorCoordinatorStatus = {
  descriptorEpoch: number;
  descriptorFingerprint: string | null;
  bindingCount: number;
  notificationEligibleBindingCount: number;
  notificationQueued: boolean;
  notificationAttemptCount: number;
  notificationErrorCount: number;
  lastNotificationEpoch: number | null;
  lastNotificationAttemptAt: string | null;
  clientRelistObservationCount: number;
  clientRelistedSessionCount: number;
  lastClientRelistedEpoch: number | null;
  lastClientRelistedAt: string | null;
  /** Observed interval only; it does not prove descriptor adoption or causality. */
  lastObservedNotificationToRelistMs: number | null;
  pendingReconcileFingerprint: string | null;
  pendingReconcileObservationCount: number;
  disposed: boolean;
};

export type SdkToolDescriptorBinding = {
  readonly id: number;
  setNotificationEligible(eligible?: boolean): boolean;
  detach(): boolean;
};

export type SdkToolDescriptorCoordinatorOptions = {
  reconcile?: () => SdkToolDescriptorSnapshotInput;
  /** Injectable wall clock for deterministic diagnostics tests. */
  now?: () => number;
  /** Delay before retrying a failed transport notification. */
  notificationRetryDelayMs?: number;
  /** Bounded retries after the initial notification attempt. */
  maxNotificationRetries?: number;
};

type DescriptorBindingRecord = {
  server: McpServer;
  tool: RegisteredTool;
  lastNotificationEpoch: number;
  notificationEligible: boolean;
  notificationInFlightEpochs: Set<number>;
  notificationFailureEpoch?: number;
  consecutiveNotificationFailures: number;
  notificationRetryTimer?: ReturnType<typeof setTimeout>;
  notificationRetryForce?: boolean;
};

/**
 * Bridge-global registered-tool descriptor coordinator.
 *
 * A changed snapshot is installed synchronously on every attached registered
 * tool before one microtask-coalesced tools/list_changed attempt is made for
 * each binding. Notification delivery is advisory; runtime policy enforcement
 * must remain independent of this class.
 */
export class SdkToolDescriptorCoordinator {
  private readonly bindings = new Map<number, DescriptorBindingRecord>();
  private nextBindingId = 1;
  private snapshot?: Readonly<SdkToolDescriptorSnapshot>;
  private fingerprint?: string;
  private epoch = 0;
  private notificationQueued = false;
  private notificationAttemptCount = 0;
  private notificationErrorCount = 0;
  private lastNotificationEpoch?: number;
  private lastNotificationAttemptAt?: number;
  private readonly notificationAttemptAtByEpoch = new Map<number, number>();
  private clientRelistObservationCount = 0;
  private readonly clientRelistedEpochBySession = new Map<string, number>();
  private lastClientRelistedEpoch?: number;
  private lastClientRelistedAt?: number;
  private lastObservedNotificationToRelistMs?: number;
  private pendingReconcileSnapshot?: Readonly<SdkToolDescriptorSnapshot>;
  private pendingReconcileFingerprint?: string;
  private pendingReconcileObservationCount = 0;
  private disposed = false;
  private reconcileHook?: () => SdkToolDescriptorSnapshotInput;
  private readonly now: () => number;
  private readonly notificationRetryDelayMs: number;
  private readonly maxNotificationRetries: number;

  constructor(
    initial?: SdkToolDescriptorSnapshotInput,
    options: SdkToolDescriptorCoordinatorOptions = {}
  ) {
    this.now = options.now || Date.now;
    this.notificationRetryDelayMs = nonNegativeInteger(
      options.notificationRetryDelayMs,
      250,
      "notificationRetryDelayMs"
    );
    this.maxNotificationRetries = nonNegativeInteger(
      options.maxNotificationRetries,
      1,
      "maxNotificationRetries"
    );
    this.reconcileHook = options.reconcile;
    if (initial) this.installInitial(initial);
  }

  /** Attach one session-local SDK tool. The latest shared snapshot wins. */
  attach(
    server: McpServer,
    tool: RegisteredTool,
    initial?: SdkToolDescriptorSnapshotInput,
    options: { notificationEligible?: boolean } = {}
  ): SdkToolDescriptorBinding {
    this.assertActive();
    if (!this.snapshot) {
      this.installInitial(initial || descriptorFromRegisteredTool(tool));
    }
    applyDescriptorSnapshot(tool, this.snapshot as SdkToolDescriptorSnapshot);
    const id = this.nextBindingId++;
    this.bindings.set(id, {
      server,
      tool,
      // A newly attached session already has the latest descriptor before its
      // first tools/list and does not need an advisory change notification.
      lastNotificationEpoch: this.epoch,
      notificationEligible: options.notificationEligible ?? true,
      notificationInFlightEpochs: new Set<number>(),
      consecutiveNotificationFailures: 0
    });
    return {
      id,
      setNotificationEligible: (eligible = true) => this.setNotificationEligible(id, eligible),
      detach: () => this.detach(id)
    };
  }

  private setNotificationEligible(id: number, eligible: boolean): boolean {
    const binding = this.bindings.get(id);
    if (!binding || binding.notificationEligible === eligible) return false;
    binding.notificationEligible = eligible;
    if (!eligible) this.clearNotificationRetry(binding);
    // A descriptor may change after the initialize response but before the
    // client sends notifications/initialized. Preserve that pending epoch and
    // signal it once the binding is protocol-ready; retained client tool lists
    // must not be assumed to re-list automatically on a new transport session.
    if (eligible && binding.lastNotificationEpoch < this.epoch) {
      this.queueNotifications();
    }
    return true;
  }

  detach(binding: number | SdkToolDescriptorBinding): boolean {
    const id = typeof binding === "number" ? binding : binding.id;
    const record = this.bindings.get(id);
    if (!record) return false;
    this.clearNotificationRetry(record);
    return this.bindings.delete(id);
  }

  /**
   * Atomically replace the complete descriptor on every active binding.
   * Equivalent snapshots are ignored and do not enqueue another notification.
   */
  publish(next: SdkToolDescriptorSnapshotInput): SdkToolDescriptorProjectionStatus {
    this.assertActive();
    const snapshot = freezeDescriptorSnapshot(next);
    const fingerprint = descriptorSignature(snapshot);
    if (fingerprint === this.fingerprint) {
      this.clearPendingReconcile();
      return this.projectionStatus(false);
    }

    if (
      this.snapshot &&
      this.bindings.size > 0 &&
      snapshot.outputSchema !== this.snapshot.outputSchema
    ) {
      // The MCP SDK validates a result against RegisteredTool.outputSchema only
      // after the async handler returns. Mutating that object while a request is
      // in flight could validate an old result against a new contract. Require a
      // versioned/reinitialized boundary instead of creating that race.
      throw new Error(
        "DYNAMIC_OUTPUT_SCHEMA_CHANGE_REQUIRES_VERSIONED_CONTRACT: " +
        "Close active descriptor bindings and reinitialize with a versioned output contract."
      );
    }

    const previous = this.snapshot;
    const installed: RegisteredTool[] = [];
    try {
      for (const { tool } of this.bindings.values()) {
        installed.push(tool);
        applyDescriptorSnapshot(tool, snapshot);
      }
    } catch (error) {
      if (previous) {
        for (const tool of installed) applyDescriptorSnapshot(tool, previous);
      }
      throw error;
    }

    // JavaScript executes the installation loop without interleaving another
    // request, so publishing these fields after all bindings were updated makes
    // the new snapshot and epoch visible as one coordinator transition.
    this.snapshot = snapshot;
    this.fingerprint = fingerprint;
    this.epoch += 1;
    for (const binding of this.bindings.values()) {
      this.clearNotificationRetry(binding);
      binding.notificationFailureEpoch = undefined;
      binding.consecutiveNotificationFailures = 0;
    }
    this.clearPendingReconcile();
    this.queueNotifications();
    return this.projectionStatus(true);
  }

  setReconcileHook(hook?: () => SdkToolDescriptorSnapshotInput): void {
    this.assertActive();
    this.reconcileHook = hook;
  }

  /** Rebuild and publish from the configured hook or a one-shot hook. */
  reconcile(
    hook: (() => SdkToolDescriptorSnapshotInput) | SdkToolDescriptorSnapshotInput | undefined =
      this.reconcileHook
  ): SdkToolDescriptorProjectionStatus {
    this.assertActive();
    if (!hook) return this.projectionStatus(false);
    return this.publish(typeof hook === "function" ? hook() : hook);
  }

  /**
   * Require the same out-of-band candidate for consecutive observations before
   * publishing it. Runtime admission remains immediate; this only prevents a
   * transient availability probe from flapping discovery and notifications.
   */
  reconcileStable(
    requiredObservations = 2,
    hook: (() => SdkToolDescriptorSnapshotInput) | SdkToolDescriptorSnapshotInput | undefined =
      this.reconcileHook
  ): SdkToolDescriptorProjectionStatus {
    this.assertActive();
    if (!Number.isInteger(requiredObservations) || requiredObservations < 1) {
      throw new Error("Stable descriptor reconciliation requires a positive observation count.");
    }
    if (!hook) return this.projectionStatus(false);
    const snapshot = freezeDescriptorSnapshot(typeof hook === "function" ? hook() : hook);
    const fingerprint = descriptorSignature(snapshot);
    if (fingerprint === this.fingerprint) {
      this.clearPendingReconcile();
      return this.projectionStatus(false);
    }
    if (requiredObservations === 1) return this.publish(snapshot);
    if (fingerprint === this.pendingReconcileFingerprint) {
      this.pendingReconcileObservationCount += 1;
    } else {
      this.pendingReconcileSnapshot = snapshot;
      this.pendingReconcileFingerprint = fingerprint;
      this.pendingReconcileObservationCount = 1;
    }
    if (this.pendingReconcileObservationCount < requiredObservations) {
      return this.projectionStatus(false);
    }
    const admitted = this.pendingReconcileSnapshot as Readonly<SdkToolDescriptorSnapshot>;
    return this.publish(admitted);
  }

  /** Deterministic test/diagnostic hook; normal callers use coalesced delivery. */
  flushNotifications(): void {
    if (this.disposed || !this.notificationQueued) return;
    this.notificationQueued = false;
    const epoch = this.epoch;
    for (const [id, binding] of this.bindings) {
      if (!binding.notificationEligible) continue;
      if (binding.lastNotificationEpoch >= epoch) continue;
      if (binding.notificationInFlightEpochs.has(epoch)) continue;
      this.attemptToolListChanged(id, binding, epoch, false);
    }
  }

  get current(): Readonly<SdkToolDescriptorSnapshot> | undefined {
    return this.snapshot;
  }

  /**
   * Records an inbound tools/list after the transport handled it. This proves
   * only that one client session re-listed; it never means every conversation
   * adopted the descriptor or that a later call used it.
   */
  noteClientRelisted(sessionKey?: string, descriptorEpoch = this.epoch): void {
    if (this.disposed) return;
    if (
      !Number.isInteger(descriptorEpoch) ||
      descriptorEpoch < 1 ||
      descriptorEpoch > this.epoch
    ) return;
    const observedAt = this.now();
    this.clientRelistObservationCount += 1;
    // Stateless requests have no durable client-session identity. Count the
    // observation, but never misreport all stateless conversations as one
    // adopted live session.
    if (sessionKey) {
      const previous = this.clientRelistedEpochBySession.get(sessionKey) || 0;
      this.clientRelistedEpochBySession.set(sessionKey, Math.max(previous, descriptorEpoch));
    }
    this.lastClientRelistedEpoch = Math.max(
      this.lastClientRelistedEpoch || 0,
      descriptorEpoch
    );
    this.lastClientRelistedAt = observedAt;
    const notificationAt = this.notificationAttemptAtByEpoch.get(descriptorEpoch);
    if (notificationAt !== undefined) {
      this.lastObservedNotificationToRelistMs = Math.max(0, observedAt - notificationAt);
    }
  }

  /**
   * Re-signal a known stateful client when it reconnects its standalone SSE
   * channel without having re-listed the current descriptor epoch.
   *
   * The SDK does not emit a replay anchor on a fresh standalone GET. A change
   * notification sent while that channel was disconnected can therefore be
   * stored but unreachable to a client that has no Last-Event-ID. Repeating the
   * advisory notification on reconnect closes that transport gap without ever
   * treating notification delivery as descriptor adoption.
   */
  resignalUnrelistedSession(sessionKey: string, server: McpServer): boolean {
    if (this.disposed) return false;
    const relistedEpoch = this.clientRelistedEpochBySession.get(sessionKey);
    // No observation means the client has not yet established a stale list;
    // avoid sending a redundant change before its first tools/list request.
    if (relistedEpoch === undefined || relistedEpoch >= this.epoch) return false;
    const entry = [...this.bindings.entries()].find(
      ([, candidate]) => candidate.server === server
    );
    if (!entry?.[1].notificationEligible) return false;
    const [id, binding] = entry;
    if (binding.notificationInFlightEpochs.has(this.epoch)) return false;
    return this.attemptToolListChanged(id, binding, this.epoch, true);
  }

  /** Remove disconnected session state so adoption counts describe live clients. */
  forgetClientSession(sessionKey: string): boolean {
    if (this.disposed) return false;
    return this.clientRelistedEpochBySession.delete(sessionKey);
  }

  private attemptToolListChanged(
    id: number,
    binding: DescriptorBindingRecord,
    epoch: number,
    force: boolean
  ): boolean {
    if (
      this.disposed ||
      this.bindings.get(id) !== binding ||
      !binding.notificationEligible ||
      binding.notificationInFlightEpochs.has(epoch) ||
      (!force && binding.lastNotificationEpoch >= epoch)
    ) return false;

    this.clearNotificationRetry(binding);
    binding.notificationInFlightEpochs.add(epoch);
    this.recordNotificationAttempt(epoch);
    try {
      // McpServer.sendToolListChanged() discards the underlying Promise. Use
      // the protocol server directly so asynchronous transport failures are
      // observed and cannot become unhandled rejections.
      const delivery = binding.server.server.sendToolListChanged();
      void Promise.resolve(delivery).then(
        () => {
          binding.notificationInFlightEpochs.delete(epoch);
          binding.lastNotificationEpoch = Math.max(
            binding.lastNotificationEpoch,
            epoch
          );
          if (binding.notificationFailureEpoch === epoch) {
            binding.notificationFailureEpoch = undefined;
            binding.consecutiveNotificationFailures = 0;
          }
        },
        () => this.handleNotificationFailure(id, binding, epoch, force)
      );
    } catch {
      this.handleNotificationFailure(id, binding, epoch, force);
    }
    return true;
  }

  private handleNotificationFailure(
    id: number,
    binding: DescriptorBindingRecord,
    epoch: number,
    force: boolean
  ): void {
    binding.notificationInFlightEpochs.delete(epoch);
    this.notificationErrorCount += 1;
    if (
      this.disposed ||
      this.bindings.get(id) !== binding ||
      !binding.notificationEligible ||
      epoch !== this.epoch
    ) return;
    if (binding.notificationFailureEpoch === epoch) {
      binding.consecutiveNotificationFailures += 1;
    } else {
      binding.notificationFailureEpoch = epoch;
      binding.consecutiveNotificationFailures = 1;
    }
    if (
      binding.consecutiveNotificationFailures > this.maxNotificationRetries
    ) return;

    binding.notificationRetryForce = force;
    binding.notificationRetryTimer = setTimeout(() => {
      binding.notificationRetryTimer = undefined;
      const retryForce = binding.notificationRetryForce || false;
      binding.notificationRetryForce = undefined;
      this.attemptToolListChanged(id, binding, epoch, retryForce);
    }, this.notificationRetryDelayMs);
    binding.notificationRetryTimer.unref?.();
  }

  private recordNotificationAttempt(epoch: number): void {
    const attemptAt = this.now();
    this.notificationAttemptCount += 1;
    this.lastNotificationEpoch = epoch;
    this.lastNotificationAttemptAt = attemptAt;
    if (!this.notificationAttemptAtByEpoch.has(epoch)) {
      this.notificationAttemptAtByEpoch.set(epoch, attemptAt);
    }
    for (const recordedEpoch of this.notificationAttemptAtByEpoch.keys()) {
      if (recordedEpoch < epoch - 1) {
        this.notificationAttemptAtByEpoch.delete(recordedEpoch);
      }
    }
  }

  private clearNotificationRetry(binding: DescriptorBindingRecord): void {
    if (binding.notificationRetryTimer) {
      clearTimeout(binding.notificationRetryTimer);
      binding.notificationRetryTimer = undefined;
    }
    binding.notificationRetryForce = undefined;
  }

  get status(): SdkToolDescriptorCoordinatorStatus {
    return {
      descriptorEpoch: this.epoch,
      descriptorFingerprint: this.fingerprint || null,
      bindingCount: this.bindings.size,
      notificationEligibleBindingCount: [...this.bindings.values()]
        .filter((binding) => binding.notificationEligible).length,
      notificationQueued: this.notificationQueued,
      notificationAttemptCount: this.notificationAttemptCount,
      notificationErrorCount: this.notificationErrorCount,
      lastNotificationEpoch: this.lastNotificationEpoch ?? null,
      lastNotificationAttemptAt: isoTimestamp(this.lastNotificationAttemptAt),
      clientRelistObservationCount: this.clientRelistObservationCount,
      // Count only sessions that re-listed the descriptor at the current
      // epoch. Historical observations must not make a fresh publish look
      // adopted before any client has re-listed it.
      clientRelistedSessionCount: [...this.clientRelistedEpochBySession.values()]
        .filter((epoch) => epoch === this.epoch).length,
      lastClientRelistedEpoch: this.lastClientRelistedEpoch ?? null,
      lastClientRelistedAt: isoTimestamp(this.lastClientRelistedAt),
      lastObservedNotificationToRelistMs:
        this.lastObservedNotificationToRelistMs ?? null,
      pendingReconcileFingerprint: this.pendingReconcileFingerprint || null,
      pendingReconcileObservationCount: this.pendingReconcileObservationCount,
      disposed: this.disposed
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.notificationQueued = false;
    for (const binding of this.bindings.values()) {
      this.clearNotificationRetry(binding);
      binding.notificationInFlightEpochs.clear();
    }
    this.bindings.clear();
    this.clientRelistedEpochBySession.clear();
    this.notificationAttemptAtByEpoch.clear();
    this.clearPendingReconcile();
    this.reconcileHook = undefined;
  }

  private installInitial(initial: SdkToolDescriptorSnapshotInput): void {
    const snapshot = freezeDescriptorSnapshot(initial);
    this.snapshot = snapshot;
    this.fingerprint = descriptorSignature(snapshot);
    this.epoch = 1;
  }

  private queueNotifications(): void {
    if (
      ![...this.bindings.values()].some((binding) => binding.notificationEligible) ||
      this.notificationQueued
    ) return;
    this.notificationQueued = true;
    queueMicrotask(() => this.flushNotifications());
  }

  private projectionStatus(updated: boolean): SdkToolDescriptorProjectionStatus {
    return {
      descriptorProjectionUpdated: updated,
      // Until real-client adoption is observed, developer-mode Refresh remains
      // the conservative recovery instruction even if a notification was queued.
      developerModeRefreshRequired: updated,
      descriptorEpoch: this.epoch,
      descriptorFingerprint: this.fingerprint || null,
      notificationQueued: this.notificationQueued,
      bindingCount: this.bindings.size
    };
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("Tool descriptor coordinator is disposed.");
  }

  private clearPendingReconcile(): void {
    this.pendingReconcileSnapshot = undefined;
    this.pendingReconcileFingerprint = undefined;
    this.pendingReconcileObservationCount = 0;
  }
}

/**
 * Compatibility event retained for the existing codex_task projection call
 * sites. New shared-session code should publish a complete descriptor through
 * SdkToolDescriptorCoordinator directly.
 */
export type ModelPolicyChangedEvent = {
  schema: z.ZodType;
  annotations: ToolAnnotations;
  metadata?: Record<string, unknown>;
  description?: string;
};

export type ModelPolicyProjectionStatus = Pick<
  SdkToolDescriptorProjectionStatus,
  "descriptorProjectionUpdated" | "developerModeRefreshRequired"
>;

/** Per-server compatibility wrapper around the complete descriptor coordinator. */
export class SdkModelPolicyProjectionAdapter {
  private tool?: RegisteredTool;
  private binding?: SdkToolDescriptorBinding;
  private readonly coordinator: SdkToolDescriptorCoordinator;

  constructor(private readonly server: McpServer) {
    this.coordinator = new SdkToolDescriptorCoordinator();
  }

  attach(tool: RegisteredTool, current?: ModelPolicyChangedEvent): void {
    this.binding?.detach();
    this.tool = tool;
    this.binding = this.coordinator.attach(
      this.server,
      tool,
      current ? completeLegacyDescriptor(tool, current) : undefined
    );
  }

  publish(event: ModelPolicyChangedEvent): ModelPolicyProjectionStatus {
    if (!this.tool) {
      return {
        descriptorProjectionUpdated: false,
        developerModeRefreshRequired: false
      };
    }
    const status = this.coordinator.publish(completeLegacyDescriptor(this.tool, event));
    return {
      descriptorProjectionUpdated: status.descriptorProjectionUpdated,
      developerModeRefreshRequired: status.developerModeRefreshRequired
    };
  }

  detach(): void {
    this.binding?.detach();
    this.binding = undefined;
    this.tool = undefined;
  }

  dispose(): void {
    this.detach();
    this.coordinator.dispose();
  }
}

export function descriptorSignature(snapshot: SdkToolDescriptorSnapshotInput): string {
  const normalized = freezeDescriptorSnapshot(snapshot);
  const canonical = JSON.stringify(canonicalJsonValue({
    title: normalized.title ?? null,
    description: normalized.description ?? null,
    inputSchema: jsonSchema(normalized.inputSchema, "input"),
    outputSchema: jsonSchema(normalized.outputSchema, "output"),
    annotations: normalized.annotations ?? null,
    execution: normalized.execution ?? null,
    _meta: normalized._meta ?? null,
    admissionRef: normalized.admissionRef ?? null,
    admissionCatalogFingerprint: normalized.admissionCatalogFingerprint ?? null,
    present: normalized.present,
    enabled: normalized.enabled
  }));
  return createHash("sha256").update(canonical).digest("hex");
}

function completeLegacyDescriptor(
  tool: RegisteredTool,
  event: ModelPolicyChangedEvent
): SdkToolDescriptorSnapshotInput {
  return {
    title: tool.title,
    description: event.description === undefined ? tool.description : event.description,
    inputSchema: event.schema,
    outputSchema: tool.outputSchema as z.ZodType | undefined,
    annotations: event.annotations,
    execution: tool.execution,
    // Undefined intentionally removes a previously projected Task UI binding.
    _meta: event.metadata,
    present: true,
    enabled: tool.enabled
  };
}

function descriptorFromRegisteredTool(tool: RegisteredTool): SdkToolDescriptorSnapshotInput {
  return {
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema as z.ZodType | undefined,
    outputSchema: tool.outputSchema as z.ZodType | undefined,
    annotations: tool.annotations,
    execution: tool.execution,
    _meta: tool._meta,
    present: true,
    enabled: tool.enabled
  };
}

function applyDescriptorSnapshot(
  tool: RegisteredTool,
  snapshot: Readonly<SdkToolDescriptorSnapshot>
): void {
  tool.title = snapshot.title;
  tool.description = snapshot.description;
  tool.inputSchema = snapshot.inputSchema;
  tool.outputSchema = snapshot.outputSchema;
  tool.annotations = snapshot.annotations;
  tool.execution = snapshot.execution;
  tool._meta = snapshot._meta;
  tool.enabled = snapshot.present && snapshot.enabled;
}

function freezeDescriptorSnapshot(
  input: SdkToolDescriptorSnapshotInput
): Readonly<SdkToolDescriptorSnapshot> {
  return Object.freeze({
    title: input.title,
    description: input.description,
    inputSchema: input.inputSchema,
    outputSchema: input.outputSchema,
    annotations: freezeJsonValue(input.annotations),
    execution: freezeJsonValue(input.execution),
    _meta: freezeJsonValue(input._meta),
    admissionRef: input.admissionRef,
    admissionCatalogFingerprint: input.admissionCatalogFingerprint,
    present: input.present ?? true,
    enabled: input.enabled ?? true
  });
}

function jsonSchema(
  schema: z.ZodType | undefined,
  io: "input" | "output"
): Record<string, unknown> | null {
  if (!schema) return null;
  return z.toJSONSchema(schema, { target: "draft-7", io });
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalJsonValue(value[key])])
  );
}

function freezeJsonValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => freezeJsonValue(entry))) as T;
  }
  if (!isPlainObject(value)) return value;
  const clone = Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, freezeJsonValue(entry)])
  );
  return Object.freeze(clone) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isoTimestamp(value: number | undefined): string | null {
  return value === undefined ? null : new Date(value).toISOString();
}

function nonNegativeInteger(
  value: number | undefined,
  fallback: number,
  label: string
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return resolved;
}
