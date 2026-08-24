import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isPathWithinRoot, type CodexBackendKind, type SandboxMode } from "./config.js";
import type { BridgeStateStore } from "./stateStore.js";
import type { ToolResult } from "./upstream.js";
import {
  validateModelSelection,
  type ModelSelection
} from "./modelPolicy.js";
import { normalizeProjectId, normalizeProjectLabel } from "./projectRegistry.js";

export const LEGACY_SCOPE_ID = "00000000-0000-0000-0000-000000000000";
export const SCOPE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ThreadIdentity = {
  threadId: string;
  scopeId: string;
  backendKind: CodexBackendKind;
};

export type ThreadExecutionState = {
  cwd: string;
  projectId?: string;
  projectLabel?: string;
  sandbox: SandboxMode;
  selection?: ModelSelection;
  policyRevision?: number;
  updatedAt: number;
};

export type TrackedCodexSession = ThreadIdentity & ThreadExecutionState & {
  createdAt: number;
  lastUsedAt: number;
};

export type SessionMatch = {
  scopeId: string;
  cwd: string;
  sandbox: SandboxMode;
};

type PersistedSessionState = {
  version: 6;
  sessions: TrackedCodexSession[];
};

export type SessionRegistryOptions = {
  stateFile?: string;
  stateStore?: BridgeStateStore;
  allowedRoots?: string[];
  maxSessions?: number;
  now?: () => number;
};

export class SessionRegistry {
  private readonly sessions = new Map<string, TrackedCodexSession>();
  private readonly stateFile?: string;
  private readonly stateStore?: BridgeStateStore;
  private readonly allowedRoots: string[];
  private readonly maxSessions: number;
  private readonly now: () => number;

  constructor(options: SessionRegistryOptions = {}) {
    this.stateFile = options.stateFile;
    this.stateStore = options.stateStore;
    this.allowedRoots = options.allowedRoots || [];
    this.maxSessions = options.maxSessions ?? 1000;
    this.now = options.now || Date.now;
    this.load();
  }

  get persistent(): boolean {
    return Boolean(this.stateStore?.persistent || this.stateFile);
  }

  get persistencePath(): string | null {
    return this.stateStore?.persistencePath || this.stateFile || null;
  }

  record(session: TrackedCodexSession): void {
    const snapshot = [...this.sessions.entries()].map(([threadId, value]) => [threadId, { ...value }] as const);
    const existing = this.sessions.get(session.threadId);
    if ((session.projectId === undefined) !== (session.projectLabel === undefined)) {
      throw new Error("Session project metadata requires both projectId and projectLabel.");
    }
    this.sessions.delete(session.threadId);
    this.sessions.set(session.threadId, {
      threadId: session.threadId,
      scopeId: session.scopeId,
      backendKind: session.backendKind,
      cwd: session.cwd,
      ...(session.projectId && session.projectLabel
        ? {
            projectId: normalizeProjectId(session.projectId),
            projectLabel: normalizeProjectLabel(session.projectLabel)
          }
        : {}),
      sandbox: session.sandbox,
      ...(session.selection ? { selection: validateModelSelection(session.selection) } : {}),
      ...(session.policyRevision !== undefined ? { policyRevision: session.policyRevision } : {}),
      updatedAt: session.updatedAt,
      createdAt: existing?.createdAt ?? session.createdAt,
      lastUsedAt: session.lastUsedAt
    });
    const removed = this.enforceLimit();
    try {
      this.persistSession(this.sessions.get(session.threadId) || session, removed);
    } catch (error) {
      this.sessions.clear();
      for (const [threadId, value] of snapshot) this.sessions.set(threadId, value);
      throw error;
    }
  }

  get(threadId: string): TrackedCodexSession | undefined {
    const session = this.sessions.get(threadId);
    return session ? cloneSession(session) : undefined;
  }

  touch(threadId: string): void {
    const session = this.sessions.get(threadId);
    if (!session) return;
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
    if (!session) return undefined;
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
    if (!session) return undefined;
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

  findCompatible(match: SessionMatch): TrackedCodexSession[] {
    return this.list().filter(
      (session) =>
        session.scopeId === match.scopeId &&
        session.cwd === match.cwd &&
        session.sandbox === match.sandbox
    );
  }

  list(limit = this.maxSessions, offset = 0): TrackedCodexSession[] {
    return [...this.sessions.values()]
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
    return this.sessions.size;
  }

  sizeForScope(scopeId: string): number {
    return [...this.sessions.values()].filter((session) => session.scopeId === scopeId).length;
  }

  private load(): void {
    if (this.stateStore) {
      const stored = this.stateStore.listSessions();
      const decoded = stored
        .map((session) => readPersistedSession(session, 6))
        .filter((session): session is TrackedCodexSession => Boolean(session))
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
      const sessions = decoded.slice(-this.maxSessions);
      const retained = new Set(sessions.map((session) => session.threadId));
      const expired = decoded
        .filter((session) => !retained.has(session.threadId))
        .map((session) => session.threadId);
      if (expired.length > 0) {
        this.stateStore.transaction(() => {
          for (const threadId of expired) this.stateStore?.deleteSession(threadId);
        });
      }
      for (const session of sessions) {
        if (this.isAllowedCwd(session.cwd)) this.sessions.set(session.threadId, session);
      }
      // A temporarily narrowed or misconfigured allowed-root set must quarantine
      // persisted sessions, not erase them. A later restart with the original
      // operator policy must still be able to recover the exact thread state.
      this.importLegacyState();
      return;
    }
    this.loadJsonState();
  }

  private loadJsonState(): void {
    if (!this.stateFile || !existsSync(this.stateFile)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.stateFile, "utf8"));
    } catch (error) {
      throw new Error(
        `Could not read Codex session state at ${this.stateFile}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (
      !isRecord(parsed) ||
      (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3 && parsed.version !== 4 && parsed.version !== 5 && parsed.version !== 6) ||
      !Array.isArray(parsed.sessions)
    ) {
      throw new Error(`Invalid Codex session state format at ${this.stateFile}.`);
    }
    const stateVersion = parsed.version as 1 | 2 | 3 | 4 | 5 | 6;
    const sessions = parsed.sessions
      .map((session) => readPersistedSession(session, stateVersion))
      .filter((session): session is TrackedCodexSession => Boolean(session))
      .filter((session) => this.isAllowedCwd(session.cwd))
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt)
      .slice(-this.maxSessions);
    for (const session of sessions) {
      this.sessions.set(session.threadId, session);
    }
    if (stateVersion !== 5) this.persist();
  }

  private importLegacyState(): void {
    if (!this.stateStore || !this.stateFile || !existsSync(this.stateFile)) return;
    const marker = `legacy_sessions_imported:${this.stateFile}`;
    if (this.stateStore.getMeta(marker)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.stateFile, "utf8"));
    } catch (error) {
      throw new Error(
        `Could not read Codex session state at ${this.stateFile}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (
      !isRecord(parsed) ||
      (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3 && parsed.version !== 4 && parsed.version !== 5 && parsed.version !== 6) ||
      !Array.isArray(parsed.sessions)
    ) {
      throw new Error(`Invalid Codex session state format at ${this.stateFile}.`);
    }
    const stateVersion = parsed.version as 1 | 2 | 3 | 4 | 5 | 6;
    const imported = parsed.sessions
      .map((session) => readPersistedSession(session, stateVersion))
      .filter((session): session is TrackedCodexSession => Boolean(session))
      .filter((session) => this.isAllowedCwd(session.cwd))
      .filter((session) => !this.sessions.has(session.threadId));
    this.stateStore.transaction(() => {
      for (const session of imported) {
        this.sessions.set(session.threadId, session);
        this.stateStore?.upsertSession(session);
      }
      for (const threadId of this.enforceLimit()) this.stateStore?.deleteSession(threadId);
      this.stateStore?.setMeta(marker, new Date().toISOString());
    });
  }

  private persist(): void {
    if (this.stateStore) {
      this.stateStore.replaceSessions(this.list());
      return;
    }
    if (!this.stateFile) return;
    const directory = path.dirname(this.stateFile);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.stateFile}.${process.pid}.tmp`;
    const state: PersistedSessionState = {
      version: 6,
      sessions: this.list()
    };
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.stateFile);
    chmodSync(this.stateFile, 0o600);
  }

  private persistSession(session: TrackedCodexSession, removed: string[] = []): void {
    if (!this.stateStore) {
      this.persist();
      return;
    }
    this.stateStore.transaction(() => {
      this.stateStore?.upsertSession(session);
      for (const threadId of removed) this.stateStore?.deleteSession(threadId);
    });
  }

  private enforceLimit(): string[] {
    const removed: string[] = [];
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
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

function readPersistedSession(
  value: unknown,
  stateVersion: 1 | 2 | 3 | 4 | 5 | 6
): TrackedCodexSession | undefined {
  if (!isRecord(value)) return undefined;
  const sandbox = value.sandbox;
  const scopeId = stateVersion === 1 ? LEGACY_SCOPE_ID : value.scopeId;
  const backendKind = stateVersion >= 4 ? value.backendKind : "mcp-server";
  const legacySelection =
    typeof value.model === "string" &&
    value.model &&
    typeof value.reasoningEffort === "string" &&
    value.reasoningEffort
      ? { model: value.model, reasoningEffort: value.reasoningEffort }
      : undefined;
  let selection: ModelSelection | undefined;
  try {
    selection = stateVersion >= 5 && value.selection !== undefined
      ? validateModelSelection(value.selection, "persisted thread selection")
      : legacySelection;
  } catch {
    return undefined;
  }
  const policyRevision = stateVersion >= 5 ? value.policyRevision : undefined;
  const updatedAt = stateVersion >= 5 && isTimestamp(value.updatedAt)
    ? value.updatedAt
    : isTimestamp(value.lastUsedAt)
      ? value.lastUsedAt
      : 0;
  let project: { projectId: string; projectLabel: string } | undefined;
  try {
    if (stateVersion >= 6 && (value.projectId !== undefined || value.projectLabel !== undefined)) {
      if (typeof value.projectId !== "string" || typeof value.projectLabel !== "string") return undefined;
      project = {
        projectId: normalizeProjectId(value.projectId),
        projectLabel: normalizeProjectLabel(value.projectLabel)
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
    !isTimestamp(value.lastUsedAt) ||
    (backendKind !== "mcp-server" && backendKind !== "app-server") ||
    (policyRevision !== undefined && (!Number.isInteger(policyRevision) || (policyRevision as number) < 0))
  ) {
    return undefined;
  }
  return {
    threadId: value.threadId,
    scopeId: scopeId.toLowerCase(),
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
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
