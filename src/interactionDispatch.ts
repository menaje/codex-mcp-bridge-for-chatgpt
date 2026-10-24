/** The original interaction was rejected before the upstream send was invoked. */
export class InteractionNotDispatchedError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "The original Codex interaction is unavailable.", { cause });
    this.name = "InteractionNotDispatchedError";
  }
}
