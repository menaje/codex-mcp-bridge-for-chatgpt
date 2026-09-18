import type { CodexBackendKind } from "./config.js";
import type { TrackedCodexSession } from "./sessionRegistry.js";

export type MemoryOnlyThreadImpact = {
  memoryOnlyThreads: number;
  protectedMemoryOnlyThreads: number;
  discardableMemoryOnlyThreads: number;
};

type MemoryOnlyThreadSession = Pick<
  TrackedCodexSession,
  "threadId" | "backendKind" | "persistence" | "visibleInCodexApp"
>;

/**
 * Separates memory-only contexts that merely remain resumable from contexts
 * whose unfinished Bridge work still needs the current App Server process.
 */
export function classifyMemoryOnlyThreadImpact(
  sessions: readonly MemoryOnlyThreadSession[],
  canResumeThread: (threadId: string, backendKind: CodexBackendKind) => boolean,
  hasUnfinishedWork: (threadId: string) => boolean
): MemoryOnlyThreadImpact {
  const memoryOnly = sessions.filter(session =>
    session.backendKind === "app-server" &&
    (session.persistence === "ephemeral" ||
      session.persistence !== "persistent" && session.visibleInCodexApp === false) &&
    canResumeThread(session.threadId, session.backendKind)
  );
  const protectedMemoryOnlyThreads = memoryOnly.reduce(
    (count, session) => count + Number(hasUnfinishedWork(session.threadId)),
    0
  );
  return {
    memoryOnlyThreads: memoryOnly.length,
    protectedMemoryOnlyThreads,
    discardableMemoryOnlyThreads: memoryOnly.length - protectedMemoryOnlyThreads
  };
}
