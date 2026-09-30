import path from "node:path";
import { isPathWithinRoot, type CodexBackendKind, type SandboxMode } from "./config.js";
import type { BridgeStateStore } from "./stateStore.js";
import type { ThreadPersistence } from "./threadConnections.js";
import type { ToolResult } from "./upstream.js";
import {
  validateModelSelection,
  type ModelSelection
} from "./modelPolicy.js";
import { normalizeProjectId, normalizeProjectName } from "./projectRegistry.js";
import { parseJsonTextStrict } from "./textIntegrity.js";

export const LEGACY_SCOPE_ID = "00000000-0000-0000-0000-000000000000";
export const SCOPE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ThreadIdentity = {
  threadId: string;
  scopeId: string;
  backendKind: CodexBackendKind;
  sessionId?: string;
  forkedFromThreadId?: string;
};

export type ThreadExecutionState = {
  cwd: string;
  projectId?: string;
  projectName?: string;
  sandbox: SandboxMode;
  selection?: ModelSelection;
  policyRevision?: number;
  updatedAt: number;
};

export type TrackedCodexSession = ThreadIdentity & ThreadExecutionState & {
  /** Non-secret correlation to the Codex auth home/account used at creation. */
  authBoundary?: string;
  persistence?: ThreadPersistence;
  /** Whether this non-ephemeral App Server thread was created for Codex app visibility. */
  visibleInCodexApp?: boolean;
  createdAt: number;
  lastUsedAt: number;
};

export type SessionMatch = {
  scopeId: string;
  cwd: string;
  sandbox: SandboxMode;
};

export type SessionRegistryOptions = {
  stateStore?: BridgeStateStore;
  allowedRoots?: string[];
  maxSessions?: number;
  now?: () => number;
  projectionOnly?: boolean;
  authBoundary?: { key: string; allowLegacyShared: boolean } | (() => { key: string; allowLegacyShared: boolean });
};

export class SessionRegistry {
  private readonly sessions = new Map<string, TrackedCodexSession>();
  private readonly stateStore?: BridgeStateStore;
  private readonly allowedRoots: string[];
  private readonly maxSessions: number;
  private readonly now: () => number;
  private readonly projectionOnly: boolean;
  private readonly authBoundary?: SessionRegistryOptions["authBoundary"];
  private projectedProjectRevision: number | undefined;

  constructor(options: SessionRegistryOptions = {}) {
    this.stateStore = options.stateStore;
    this.allowedRoots = options.allowedRoots || [];
    this.maxSessions = options.maxSessions ?? 1000;
    this.now = options.now || Date.now;
    this.projectionOnly = options.projectionOnly === true;
    this.authBoundary = options.authBoundary;
    this.load();
  }

  get persistent(): boolean {
    return Boolean(this.stateStore?.persistent);
  }

  get persistencePath(): string | null {
    return this.stateStore?.persistencePath || null;
  }

  /** Internal composition hook for shared registry/admission persistence. */
  get admissionStateStore(): BridgeStateStore | undefined {
    return this.stateStore;
  }

  record(session: TrackedCodexSession): void {
    this.recordAtBoundary(session, this.currentAuthBoundary(), false);
  }

  /** Persist a result under the owner fixed when its Job was admitted. */
  recordForJob(session: TrackedCodexSession, jobAuthBoundary: string | undefined): void {
    if (!this.authBoundary) {
      this.record(session);
      return;
    }
    if (!jobAuthBoundary) {
      throw new Error("CODEX_AUTH_THREAD_BOUNDARY: The Job has no confirmed authentication owner.");
    }
    this.recordAtBoundary(session, { key: jobAuthBoundary, allowLegacyShared: false }, true);
  }

  private recordAtBoundary(
    session: TrackedCodexSession,
    boundary: { key: string; allowLegacyShared: boolean } | undefined,
    fromJob: boolean
  ): void {
    const snapshot = [...this.sessions.entries()].map(([threadId, value]) => [threadId, { ...value }] as const);
    const existing = this.sessions.get(session.threadId);
    if (existing && (fromJob
      ? existing.authBoundary !== boundary?.key
      : !this.matchesBoundary(existing, boundary))) {
      throw new Error("CODEX_AUTH_THREAD_BOUNDARY: The thread belongs to another authentication connection.");
    }
    if (boundary && session.authBoundary && session.authBoundary !== boundary.key) {
      throw new Error("CODEX_AUTH_THREAD_BOUNDARY: The thread belongs to another authentication connection.");
    }
    const sessionId = normalizeOptionalLineageId(
      session.sessionId ?? existing?.sessionId,
      "sessionId"
    );
    const forkedFromThreadId = normalizeOptionalLineageId(
      session.forkedFromThreadId ?? existing?.forkedFromThreadId,
      "forkedFromThreadId"
    );
    const visibleInCodexApp = session.visibleInCodexApp ?? existing?.visibleInCodexApp;
    const persistence = session.persistence ?? existing?.persistence;
    if ((session.projectId === undefined) !== (session.projectName === undefined)) {
      throw new Error("Session project metadata requires both projectId and projectName.");
    }
    const projectId = session.projectId ?? existing?.projectId;
    const projectName = session.projectName ?? existing?.projectName;
    this.sessions.delete(session.threadId);
    this.sessions.set(session.threadId, {
      threadId: session.threadId,
      scopeId: session.scopeId,
      backendKind: session.backendKind,
      ...(boundary ? { authBoundary: boundary.key } : session.authBoundary ? { authBoundary: session.authBoundary } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(forkedFromThreadId ? { forkedFromThreadId } : {}),
      ...(visibleInCodexApp !== undefined ? { visibleInCodexApp } : {}),
      ...(persistence ? { persistence } : {}),
      cwd: session.cwd,
      ...(projectId && projectName
        ? {
            projectId: normalizeProjectId(projectId),
            projectName: normalizeProjectName(projectName)
          }
        : {}),
      sandbox: session.sandbox,
      ...(session.selection ? { selection: validateModelSelection(session.selection) } : {}),
      ...(session.policyRevision !== undefined ? { policyRevision: session.policyRevision } : {}),
      updatedAt: session.updatedAt,
      createdAt: existing?.createdAt ?? session.createdAt,
      lastUsedAt: session.lastUsedAt
    });
    const removed = this.enforceLimit(boundary);
    try {
      this.persistSession(this.sessions.get(session.threadId) || session, removed);
    } catch (error) {
      this.sessions.clear();
      for (const [threadId, value] of snapshot) this.sessions.set(threadId, value);
      throw error;
    }
  }

  get(threadId: string): TrackedCodexSession | undefined {
    this.refreshProjectIdentities();
    const session = this.sessions.get(threadId);
    return session && this.isVisible(session) ? cloneSession(session) : undefined;
  }

  /** Internal Job completion lookup; never substitutes the current login for the Job owner. */
  getForJob(threadId: string, jobAuthBoundary: string | undefined): TrackedCodexSession | undefined {
    if (!this.authBoundary) return this.get(threadId);
    if (!jobAuthBoundary) return undefined;
    this.refreshProjectIdentities();
    const session = this.sessions.get(threadId);
    return session?.authBoundary === jobAuthBoundary ? cloneSession(session) : undefined;
  }

  /** Distinguish an auth-hidden thread from an absent thread without exposing its data. */
  belongsToAnotherAuthentication(threadId: string): boolean {
    const session = this.sessions.get(threadId);
    return Boolean(session && !this.isVisible(session));
  }

  touch(threadId: string): void {
    const session = this.sessions.get(threadId);
    if (!session || !this.isVisible(session)) return;
    const updated = {
      ...session,
      lastUsedAt: this.now()
    };
    this.sessions.delete(threadId);
    this.sessions.set(threadId, updated);
    try {
      this.persistSession(updated);
    } catch (error) {
      this.restoreInMemory(threadId, session);
      throw error;
    }
  }

  updateExecution(
    threadId: string,
    selection: ModelSelection,
    policyRevision: number
  ): TrackedCodexSession | undefined {
    const session = this.sessions.get(threadId);
    if (!session || !this.isVisible(session)) return undefined;
    const updated: TrackedCodexSession = {
      ...session,
      selection: validateModelSelection(selection),
      policyRevision,
      updatedAt: this.now(),
      lastUsedAt: this.now()
    };
    this.sessions.delete(threadId);
    this.sessions.set(threadId, updated);
    try {
      this.persistSession(updated);
    } catch (error) {
      this.restoreInMemory(threadId, session);
      throw error;
    }
    return cloneSession(updated);
  }

  adopt(threadId: string, scopeId: string): TrackedCodexSession | undefined {
    const session = this.sessions.get(threadId);
    if (!session || !this.isVisible(session)) return undefined;
    const adopted = {
      ...session,
      scopeId,
      lastUsedAt: this.now()
    };
    this.sessions.delete(threadId);
    this.sessions.set(threadId, adopted);
    try {
      this.persistSession(adopted);
    } catch (error) {
      this.restoreInMemory(threadId, session);
      throw error;
    }
    return cloneSession(adopted);
  }

  restoreInMemory(threadId: string, session?: TrackedCodexSession): void {
    this.sessions.delete(threadId);
    if (session) this.sessions.set(threadId, cloneSession(session));
  }

  /** Undo a shared state transaction without losing another session evicted by the record limit. */
  captureInMemory(): () => void {
    const snapshot = [...this.sessions.entries()].map(([threadId, value]) => [threadId, cloneSession(value)] as const);
    return () => {
      this.sessions.clear();
      for (const [threadId, value] of snapshot) this.sessions.set(threadId, cloneSession(value));
    };
  }

  findCompatible(match: SessionMatch): TrackedCodexSession[] {
    return this.list().filter(
      (session) =>
        session.scopeId === match.scopeId &&
        session.cwd === match.cwd &&
        session.sandbox === match.sandbox
    );
  }

  list(limit = this.maxSessions, offset = 0): TrackedCodexSession[] {
    this.refreshProjectIdentities();
    const boundary = this.currentAuthBoundary();
    return [...this.sessions.values()]
      .filter(session => this.matchesBoundary(session, boundary))
      .reverse()
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      .slice(Math.max(0, offset), Math.max(0, offset) + Math.max(0, limit))
      .map(cloneSession);
  }

  listForScope(scopeId: string, limit = this.maxSessions, offset = 0): TrackedCodexSession[] {
    return this.list(this.maxSessions)
      .filter((session) => session.scopeId === scopeId)
      .slice(Math.max(0, offset), Math.max(0, offset) + Math.max(0, limit));
  }

  size(): number {
    const boundary = this.currentAuthBoundary();
    return [...this.sessions.values()].filter(session => this.matchesBoundary(session, boundary)).length;
  }

  sizeForScope(scopeId: string): number {
    const boundary = this.currentAuthBoundary();
    return [...this.sessions.values()].filter((session) => this.matchesBoundary(session, boundary) && session.scopeId === scopeId).length;
  }

  private isVisible(session: TrackedCodexSession): boolean {
    return this.matchesBoundary(session, this.currentAuthBoundary());
  }

  private matchesBoundary(session: TrackedCodexSession,
    boundary: { key: string; allowLegacyShared: boolean } | undefined): boolean {
    if (!boundary) return true;
    // A legacy row has no evidence of its creator's account. Keep it in
    // storage for history, but never authorize resume under a current login.
    return session.authBoundary === boundary.key;
  }

  private currentAuthBoundary(): { key: string; allowLegacyShared: boolean } | undefined {
    return typeof this.authBoundary === "function" ? this.authBoundary() : this.authBoundary;
  }

  private load(): void {
    if (!this.stateStore) return;
    const stored = this.stateStore.listSessions();
    const decoded = stored
      .map(readPersistedSession)
      .filter((session): session is TrackedCodexSession => Boolean(session))
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    const boundary = this.currentAuthBoundary();
    const visible = decoded.filter(session => this.matchesBoundary(session, boundary));
    const sessions = this.authBoundary ? decoded : visible.slice(-this.maxSessions);
    const retained = new Set(sessions.map((session) => session.threadId));
    const expired = this.authBoundary ? [] : visible
      .filter((session) => !retained.has(session.threadId))
      .map((session) => session.threadId);
    if (!this.projectionOnly && expired.length > 0) {
      this.stateStore.transaction(() => {
        for (const threadId of expired) this.stateStore?.deleteSession(threadId);
      });
    }
    for (const session of sessions) {
      if (this.isAllowedCwd(session.cwd)) this.sessions.set(session.threadId, session);
    }
    // A temporarily narrowed or misconfigured allowed-root set quarantines
    // persisted sessions without erasing their execution context.
  }

  private persistSession(session: TrackedCodexSession, removed: string[] = []): void {
    if (!this.stateStore) return;
    this.stateStore.transaction(() => {
      this.stateStore?.upsertSession(session);
      for (const threadId of removed) this.stateStore?.deleteSession(threadId);
    });
  }

  private refreshProjectIdentities(): void {
    if (!this.stateStore) return;
    const revision = this.stateStore.getProjectRegistryRevision();
    if (revision === this.projectedProjectRevision) return;
    const current = new Map(
      this.stateStore.listSessionProjectIdentities().map((identity) => [
        identity.threadId,
        identity
      ])
    );
    for (const [threadId, session] of this.sessions) {
      const identity = current.get(threadId);
      if (identity?.projectId && identity.projectName) {
        session.projectId = identity.projectId;
        session.projectName = identity.projectName;
      } else {
        delete session.projectId;
        delete session.projectName;
      }
    }
    this.projectedProjectRevision = revision;
  }

  private enforceLimit(boundary: { key: string; allowLegacyShared: boolean } | undefined): string[] {
    const removed: string[] = [];
    while ([...this.sessions.values()].filter(session => this.matchesBoundary(session, boundary)).length > this.maxSessions) {
      const oldest = [...this.sessions.values()].find(session => this.matchesBoundary(session, boundary))?.threadId;
      if (!oldest) return removed;
      this.sessions.delete(oldest);
      removed.push(oldest);
    }
    return removed;
  }

  private isAllowedCwd(cwd: string): boolean {
    if (this.allowedRoots.length === 0) return true;
    return this.allowedRoots.some((root) => isPathWithinRoot(cwd, root));
  }
}

export function extractThreadId(result: ToolResult): string | undefined {
  const structured = readThreadId((result as { structuredContent?: unknown }).structuredContent);
  if (structured) return structured;

  for (const item of Array.isArray(result.content) ? result.content : []) {
    if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
      const parsed = parseJson(item.text);
      const fromJson = readThreadId(parsed);
      if (fromJson) return fromJson;
    }
  }

  return undefined;
}

function readPersistedSession(value: unknown): TrackedCodexSession | undefined {
  if (!isRecord(value)) return undefined;
  const sandbox = value.sandbox;
  const scopeId = value.scopeId;
  const backendKind = value.backendKind;
  let selection: ModelSelection | undefined;
  try {
    selection = value.selection !== undefined
      ? validateModelSelection(value.selection, "persisted thread selection")
      : undefined;
  } catch {
    return undefined;
  }
  const policyRevision = value.policyRevision;
  const sessionId = normalizePersistedLineageId(value.sessionId);
  const forkedFromThreadId = normalizePersistedLineageId(value.forkedFromThreadId);
  const visibleInCodexApp = typeof value.visibleInCodexApp === "boolean"
    ? value.visibleInCodexApp
    : undefined;
  if (
    (value.authBoundary !== undefined && (typeof value.authBoundary !== "string" || !/^[a-f0-9]{64}$/.test(value.authBoundary))) ||
    (value.sessionId !== undefined && !sessionId) ||
    (value.forkedFromThreadId !== undefined && !forkedFromThreadId) ||
    (value.visibleInCodexApp !== undefined && typeof value.visibleInCodexApp !== "boolean")
  ) return undefined;
  const updatedAt = isTimestamp(value.updatedAt)
    ? value.updatedAt
    : isTimestamp(value.lastUsedAt)
      ? value.lastUsedAt
      : undefined;
  let project: { projectId: string; projectName: string } | undefined;
  try {
    if (value.projectId !== undefined || value.projectName !== undefined) {
      if (typeof value.projectId !== "string" || typeof value.projectName !== "string") return undefined;
      project = {
        projectId: normalizeProjectId(value.projectId),
        projectName: normalizeProjectName(value.projectName)
      };
    }
  } catch {
    return undefined;
  }
  if (
    typeof value.threadId !== "string" ||
    !value.threadId ||
    typeof scopeId !== "string" ||
    !SCOPE_ID_PATTERN.test(scopeId) ||
    typeof value.cwd !== "string" ||
    !path.isAbsolute(value.cwd) ||
    path.normalize(value.cwd) !== value.cwd ||
    (sandbox !== "read-only" && sandbox !== "workspace-write" && sandbox !== "danger-full-access") ||
    !isTimestamp(value.createdAt) ||
    updatedAt === undefined ||
    !isTimestamp(value.lastUsedAt) ||
    (backendKind !== "mcp-server" && backendKind !== "app-server" && backendKind !== "codex-sdk") ||
    (policyRevision !== undefined && (!Number.isInteger(policyRevision) || (policyRevision as number) < 0))
  ) {
    return undefined;
  }
  return {
    threadId: value.threadId,
    ...(typeof value.authBoundary === "string" ? { authBoundary: value.authBoundary } : {}),
    scopeId: scopeId.toLowerCase(),
    ...(sessionId ? { sessionId } : {}),
    ...(forkedFromThreadId ? { forkedFromThreadId } : {}),
    ...(visibleInCodexApp !== undefined ? { visibleInCodexApp } : {}),
    ...(["persistent", "ephemeral", "unknown"].includes(String(value.persistence)) ? { persistence: value.persistence as ThreadPersistence } : {}),
    cwd: value.cwd,
    ...(project || {}),
    sandbox,
    ...(selection ? { selection } : {}),
    ...(typeof policyRevision === "number" ? { policyRevision } : {}),
    updatedAt,
    backendKind,
    createdAt: value.createdAt,
    lastUsedAt: value.lastUsedAt
  };
}

function cloneSession(session: TrackedCodexSession): TrackedCodexSession {
  return {
    ...session,
    ...(session.selection ? { selection: { ...session.selection } } : {})
  };
}

function readThreadId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.threadId === "string" ? value.threadId : undefined;
}

function parseJson(text: string): unknown {
  try {
    return parseJsonTextStrict(text, "Stored session");
  } catch {
    return undefined;
  }
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function normalizeOptionalLineageId(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = normalizePersistedLineageId(value);
  if (!normalized) throw new Error(`Session ${label} must be a non-empty string of at most 200 characters.`);
  return normalized;
}

function normalizePersistedLineageId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= 200 ? normalized : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
