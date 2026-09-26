import { AsyncLocalStorage } from "node:async_hooks";

// The durable Job receipt is created before crossing the execution boundary.
// Recovery subscribes to this identity; it never rebuilds/replays a turn prompt.
const identity = new AsyncLocalStorage<string>();
export const withExecutionIdentity = <T>(jobId: string, run: () => T): T =>
  identity.run(jobId, run);
export const currentExecutionIdentity = (): string | undefined => identity.getStore();
