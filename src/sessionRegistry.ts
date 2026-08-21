import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SandboxMode } from "./config.js";
import type { ToolResult } from "./upstream.js";

export type TrackedCodexSession = {
  threadId: string;
  cwd: string;
  sandbox: SandboxMode;
  model?: string;
  reasoningEffort?: string;
  createdAt: number;
  lastUsedAt: number;
};

export type SessionMatch = {
  cwd: string;
  sandbox: SandboxMode;
  model?: string;
  reasoningEffort?: string;
};

type PersistedSessionState = {
  version: 1;
  sessions: TrackedCodexSession[];
};

export type SessionRegistryOptions = {
  stateFile?: string;
  allowedRoots?: string[];
  autoResumeTtlMs?: number;
  maxSessions?: number;
  now?: () => number;
};

export class SessionRegistry {
  private readonly sessions = new Map<string, TrackedCodexSession>();
  private readonly stateFile?: string;
  private readonly allowedRoots: string[];
  private readonly autoResumeTtlMs: number;
  private readonly maxSessions: number;
  private readonly now: () => number;

  constructor(options: SessionRegistryOptions = {}) {
    this.stateFile = options.stateFile;
    this.allowedRoots = options.allowedRoots || [];
    this.autoResumeTtlMs = options.autoResumeTtlMs ?? 6 * 60 * 60 * 1000;
    this.maxSessions = options.maxSessions ?? 1000;
    this.now = options.now || Date.now;
    this.load();
  }

  get persistent(): boolean {
    return Boolean(this.stateFile);
  }

  get persistencePath(): string | null {
    return this.stateFile || null;
  }

  get autoResumeWindowMs(): number {
    return this.autoResumeTtlMs;
  }

  record(session: TrackedCodexSession): void {
    const existing = this.sessions.get(session.threadId);
    this.sessions.delete(session.threadId);
    this.sessions.set(session.threadId, {
      ...session,
      createdAt: existing?.createdAt ?? session.createdAt
    });
    this.enforceLimit();
    this.persist();
  }

  get(threadId: string): TrackedCodexSession | undefined {
    return this.sessions.get(threadId);
  }

  touch(threadId: string): void {
    const session = this.sessions.get(threadId);
    if (!session) return;
    this.sessions.delete(threadId);
    this.sessions.set(threadId, {
      ...session,
      lastUsedAt: this.now()
    });
    this.persist();
  }

  findMostRecentCompatible(
    match: SessionMatch,
    autoResumeTtlMs = this.autoResumeTtlMs
  ): TrackedCodexSession | undefined {
    const cutoff = this.now() - autoResumeTtlMs;
    return this.list().find(
      (session) =>
        session.lastUsedAt >= cutoff &&
        session.cwd === match.cwd &&
        session.sandbox === match.sandbox &&
        session.model === match.model &&
        session.reasoningEffort === match.reasoningEffort
    );
  }

  list(limit = this.maxSessions): TrackedCodexSession[] {
    return [...this.sessions.values()]
      .reverse()
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      .slice(0, Math.max(0, limit))
      .map((session) => ({ ...session }));
  }

  size(): number {
    return this.sessions.size;
  }

  private load(): void {
    if (!this.stateFile || !existsSync(this.stateFile)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.stateFile, "utf8"));
    } catch (error) {
      throw new Error(
        `Could not read Codex session state at ${this.stateFile}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.sessions)) {
      throw new Error(`Invalid Codex session state format at ${this.stateFile}.`);
    }
    const sessions = parsed.sessions
      .map(readPersistedSession)
      .filter((session): session is TrackedCodexSession => Boolean(session))
      .filter((session) => this.isAllowedCwd(session.cwd))
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt)
      .slice(-this.maxSessions);
    for (const session of sessions) {
      this.sessions.set(session.threadId, session);
    }
  }

  private persist(): void {
    if (!this.stateFile) return;
    const directory = path.dirname(this.stateFile);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.stateFile}.${process.pid}.tmp`;
    const state: PersistedSessionState = {
      version: 1,
      sessions: this.list()
    };
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.stateFile);
    chmodSync(this.stateFile, 0o600);
  }

  private enforceLimit(): void {
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (!oldest) return;
      this.sessions.delete(oldest);
    }
  }

  private isAllowedCwd(cwd: string): boolean {
    if (this.allowedRoots.length === 0) return true;
    return this.allowedRoots.some((root) => cwd === root || cwd.startsWith(root + path.sep));
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
  if (
    typeof value.threadId !== "string" ||
    !value.threadId ||
    typeof value.cwd !== "string" ||
    !path.isAbsolute(value.cwd) ||
    path.normalize(value.cwd) !== value.cwd ||
    (sandbox !== "read-only" && sandbox !== "workspace-write" && sandbox !== "danger-full-access") ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.lastUsedAt) ||
    !isOptionalString(value.model) ||
    !isOptionalString(value.reasoningEffort)
  ) {
    return undefined;
  }
  return {
    threadId: value.threadId,
    cwd: value.cwd,
    sandbox,
    model: value.model,
    reasoningEffort: value.reasoningEffort,
    createdAt: value.createdAt,
    lastUsedAt: value.lastUsedAt
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
