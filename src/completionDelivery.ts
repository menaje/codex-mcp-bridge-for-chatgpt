import { createHash, randomUUID } from "node:crypto";

/**
 * Completion delivery is deliberately independent from a card renderer.
 * A host can add a verified conversation-resume implementation later without
 * changing the durable outbox or the Dashboard's acknowledgement protocol.
 */
export type CompletionDeliveryRoute = "host-event" | "dashboard" | "pending";

export type CompletionDeliveryRouteInput = {
  /** True only after the host has proved it can resume the original chat. */
  verifiedHostEvent: boolean;
  /** True only for a Dashboard opened from the originating background task. */
  automaticDashboard: boolean;
};

export function selectCompletionDeliveryRoute(
  input: CompletionDeliveryRouteInput
): CompletionDeliveryRoute {
  if (input.verifiedHostEvent) return "host-event";
  if (input.automaticDashboard) return "dashboard";
  return "pending";
}

export type DashboardAutoPresentation = {
  token: string;
  scopeId: string;
  jobId: string;
  expiresAt: number;
};

type StoredDashboardAutoPresentation = DashboardAutoPresentation & {
  widgetInstanceId?: string;
};

/**
 * A short-lived opaque capability ties an automatic Dashboard presentation to
 * the originating conversation. It is intentionally in-memory: a restart
 * never invents a new automatic-delivery permission, while the outbox stays
 * durable for a later verified route or explicit recovery.
 */
export class DashboardAutoPresentationProofs {
  private readonly presentations = new Map<string, StoredDashboardAutoPresentation>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 6 * 60 * 60 * 1_000
  ) {}

  issue(input: { scopeId: string; jobId: string }): DashboardAutoPresentation {
    this.prune();
    const presentation: StoredDashboardAutoPresentation = {
      token: randomUUID(),
      scopeId: input.scopeId,
      jobId: input.jobId,
      expiresAt: this.now() + this.ttlMs
    };
    this.presentations.set(presentation.token, presentation);
    return { ...presentation };
  }

  require(input: {
    token: string;
    scopeId: string;
    hostScopeId: string | undefined;
    widgetInstanceId: string;
  }): DashboardAutoPresentation {
    this.prune();
    const presentation = this.presentations.get(input.token);
    if (
      !presentation ||
      presentation.scopeId !== input.scopeId ||
      input.hostScopeId !== input.scopeId ||
      (presentation.widgetInstanceId !== undefined &&
        presentation.widgetInstanceId !== input.widgetInstanceId)
    ) {
      throw new Error(
        "DASHBOARD_AUTOMATIC_PRESENTATION_STALE: Reopen the Dashboard from the originating background task."
      );
    }
    presentation.widgetInstanceId ??= input.widgetInstanceId;
    return {
      token: presentation.token,
      scopeId: presentation.scopeId,
      jobId: presentation.jobId,
      expiresAt: presentation.expiresAt
    };
  }

  private prune(): void {
    const now = this.now();
    for (const [token, presentation] of this.presentations) {
      if (presentation.expiresAt <= now) this.presentations.delete(token);
    }
  }
}

const presentationProofStores = new WeakMap<object, DashboardAutoPresentationProofs>();

export function dashboardAutoPresentationProofs(
  registry: object
): DashboardAutoPresentationProofs {
  let proofs = presentationProofStores.get(registry);
  if (!proofs) {
    proofs = new DashboardAutoPresentationProofs();
    presentationProofStores.set(registry, proofs);
  }
  return proofs;
}

export type CompletionDeliveryEvent = {
  outboxId: number;
  scopeId: string;
  activityId: string;
  completionVersion: number;
  channel: "notify" | "verify";
};

/** Fixed across attempts so host-side consumers can deduplicate a completion. */
export function completionDeliveryEventId(event: CompletionDeliveryEvent): string {
  return `completion-${createHash("sha256")
    .update("codex-completion-delivery/v1")
    .update("\0")
    .update(event.scopeId)
    .update("\0")
    .update(String(event.outboxId))
    .update("\0")
    .update(event.activityId)
    .update("\0")
    .update(String(event.completionVersion))
    .update("\0")
    .update(event.channel)
    .digest("hex")}`;
}

/**
 * The card sends a bounded, data-free wake-up request. The receiving model
 * reads the Dashboard for details; activity data never becomes instructions.
 */
export function completionFollowUpPrompt(
  events: readonly Pick<CompletionDeliveryEvent, "outboxId" | "scopeId" | "activityId" | "completionVersion" | "channel">[]
): string {
  const identifiers = events
    .map((event) => completionDeliveryEventId(event))
    .sort()
    .join(", ");
  return (
    "Codex completion event(s) are ready in this conversation. " +
    "Review the Dashboard before deciding whether any user-facing follow-up is needed. " +
    `Event IDs: ${identifiers}.`
  );
}
