import { spawn, type ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { JsonRpcProcessIdentity } from "./jsonRpcProcess.js";
import { decodeUtf8Strict } from "./textIntegrity.js";

const PROCESS_TABLE_MAX_BYTES = 4 * 1024 * 1024;
// /bin/ps is normally quick, but the installed runtime has observed genuine
// 1.1-1.2 second probes under concurrent Codex work. Keep a finite bound while
// allowing a transient scheduler/process-table delay to settle.
const PROCESS_TABLE_TIMEOUT_MS = 3_000;
const PROCESS_TABLE_LATE_TIMER_TOLERANCE_MS = 250;
const PROCESS_TABLE_RESUME_GRACE_MS = 5_000;
const PROCESS_TABLE_SETTLE_MS = 100;
const OBSERVATION_DIAGNOSTIC_MAX_MS = 86_400_000;
const PROCESS_EXIT_POLL_MS = 100;
const MAX_SUPERVISED_PROCESSES_PER_TREE = 4_096;

export type SupervisedProcessIdentity = {
  pid: number;
  parentPid: number;
  processGroupId: number;
  /** OS process birth stamp, compared before signaling retained descendants. */
  startedAt?: string;
};

export type SupervisedProcessTreeSnapshot = {
  root: JsonRpcProcessIdentity;
  processes: SupervisedProcessIdentity[];
  rootExited?: boolean;
};

type ProcessTableEntry = SupervisedProcessIdentity & {
  state: string;
};

type SupervisedProcessTree = {
  root: JsonRpcProcessIdentity;
  captured: Map<number, SupervisedProcessIdentity>;
  ownedRoot: boolean;
  rootExited: boolean;
};

export type ProcessObservationFailure = {
  kind: "ps-timeout" | "ps-spawn" | "ps-exit" | "ps-output-limit" |
    "ps-output-invalid" | "ledger-limit" | "registration-lost" | "unknown";
  durationMs: number;
  timerLatenessMs: number;
  psExitCode: number | null;
  osCode: string | null;
};

class ProcessObservationError extends Error {
  constructor(readonly failure: ProcessObservationFailure) {
    super(`Process observation failed: ${failure.kind}.`);
  }
}

export function processObservationFailure(error: unknown): ProcessObservationFailure {
  return error instanceof ProcessObservationError ? error.failure : {
    kind: "unknown",
    durationMs: 0,
    timerLatenessMs: 0,
    psExitCode: null,
    osCode: null
  };
}

/**
 * Auxiliary, bounded ledger for owned worker descendants. Spawn/exit events
 * establish root lifetime; process-table snapshots add birth-verified children.
 * No observation result grants authority to fail a Job or kill the executor.
 * Detached children never observed before reparenting cannot be proven owned.
 */
export class SupervisedProcessTreeRegistry {
  private readonly trees = new Map<string, SupervisedProcessTree>();
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly readTable: () => Promise<ProcessTableEntry[]> = readProcessTable) {}

  get size(): number {
    return this.trees.size;
  }

  get capturedProcessCount(): number {
    return [...this.trees.values()].reduce(
      (total, tree) => total + tree.captured.size,
      0
    );
  }

  has(identity: JsonRpcProcessIdentity): boolean {
    return this.trees.has(supervisedProcessKey(identity));
  }

  snapshots(): SupervisedProcessTreeSnapshot[] {
    return [...this.trees.values()].map((tree) => ({
      root: { ...tree.root },
      rootExited: tree.rootExited,
      processes: [...tree.captured.values()].map((entry) => ({ ...entry }))
    }));
  }

  merge(snapshot: SupervisedProcessTreeSnapshot): void {
    const tree = this.trees.get(supervisedProcessKey(snapshot.root));
    if (!tree || snapshot.processes.length > MAX_SUPERVISED_PROCESSES_PER_TREE) return;
    tree.rootExited ||= snapshot.rootExited === true;
    for (const entry of snapshot.processes) {
      if (!validProcessIdentity(entry)) continue;
      tree.captured.set(entry.pid, { ...entry });
    }
  }

  forget(identity: JsonRpcProcessIdentity): void {
    this.trees.delete(supervisedProcessKey(identity));
  }

  remember(identity: JsonRpcProcessIdentity, ownedRoot = false): void {
    validateRootIdentity(identity);
    const key = supervisedProcessKey(identity);
    if (this.trees.has(key)) return;
    this.trees.set(key, { root: { ...identity }, ownedRoot, rootExited: false,
      captured: new Map([[identity.pid, { pid: identity.pid, parentPid: 0,
        processGroupId: identity.processGroupId ?? identity.pid }]]) });
  }

  markExited(identity: JsonRpcProcessIdentity): void {
    const tree = this.trees.get(supervisedProcessKey(identity));
    if (tree) { tree.rootExited = true; tree.ownedRoot = false; }
  }

  register(identity: JsonRpcProcessIdentity): Promise<void> {
    validateRootIdentity(identity);
    const key = supervisedProcessKey(identity);
    this.remember(identity, true);
    return this.enqueue(async () => {
      if (process.platform === "win32") return;
      const tree = this.trees.get(key);
      if (!tree) return;
      const startedAt = performance.now();
      try {
        const rows = await this.readTable();
        observeTree(tree, rows);
        const root = rows.find((entry) => entry.pid === identity.pid);
        if (!root || root.processGroupId !== identity.processGroupId || isZombie(root)) {
          throw new ProcessObservationError({
            kind: "registration-lost", durationMs: 0, timerLatenessMs: 0,
            psExitCode: null, osCode: null
          });
        }
      } catch (error) {
        throw withObservationDuration(error, startedAt);
      }
    });
  }

  refresh(): Promise<void> {
    if (this.trees.size === 0 || process.platform === "win32") return Promise.resolve();
    return this.enqueue(async () => {
      if (this.trees.size === 0) return;
      const startedAt = performance.now();
      try {
        const rows = await this.readTable();
        for (const tree of this.trees.values()) observeTree(tree, rows);
      } catch (error) {
        throw withObservationDuration(error, startedAt);
      }
    });
  }

  release(identity: JsonRpcProcessIdentity, graceMs: number): Promise<boolean> {
    const key = supervisedProcessKey(identity);
    return this.enqueue(async () => {
      const tree = this.trees.get(key);
      if (!tree) return true;
      const exited = await terminateTree(tree, graceMs, this.readTable);
      if (exited) this.trees.delete(key);
      return exited;
    });
  }

  cleanupAll(graceMs: number): Promise<boolean> {
    return this.enqueue(async () => {
      const entries = [...this.trees.entries()];
      if (entries.length === 0) return true;
      const results = await Promise.all(entries.map(async ([key, tree]) => {
        try {
          const exited = await terminateTree(tree, graceMs, this.readTable);
          if (exited) this.trees.delete(key);
          return exited;
        } catch {
          return false;
        }
      }));
      return results.every(Boolean) && this.trees.size === 0;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function withObservationDuration(error: unknown, startedAt: number): ProcessObservationError {
  const failure = processObservationFailure(error);
  if (failure.kind.startsWith("ps-") && error instanceof ProcessObservationError) return error;
  return new ProcessObservationError({
    ...failure,
    durationMs: boundedObservationMs(performance.now() - startedAt)
  });
}

export function supervisedProcessKey(identity: JsonRpcProcessIdentity): string {
  return `${identity.pid}:${identity.processGroupId ?? "process"}`;
}

async function terminateTree(
  tree: SupervisedProcessTree,
  graceMs: number,
  readTable: () => Promise<ProcessTableEntry[]> = readProcessTable
): Promise<boolean> {
  if (!Number.isSafeInteger(graceMs) || graceMs < 0) {
    throw new Error("Invalid supervised process termination grace period.");
  }
  if (process.platform === "win32") {
    if (!processAlive(tree.root.pid)) return true;
    signalPid(tree.root.pid, "SIGTERM");
    if (await waitForPidExit(tree.root.pid, graceMs)) return true;
    signalPid(tree.root.pid, "SIGKILL");
    return waitForPidExit(tree.root.pid, graceMs);
  }

  let rows = await readTable();
  observeTree(tree, rows);
  let running = runningTreeProcesses(tree, rows);
  if (running.length === 0) {
    // An unobserved root/group is not verified cleanup and retains its slot.
    return !rows.some(row => !isZombie(row) && row.processGroupId === tree.root.processGroupId);
  }
  signalTreeProcesses(running, rows, "SIGTERM");
  running = await waitForTreeExit(tree, graceMs, readTable);
  if (running.length === 0) return true;
  rows = await readTable();
  observeTree(tree, rows);
  running = runningTreeProcesses(tree, rows);
  signalTreeProcesses(running, rows, "SIGKILL");
  return (await waitForTreeExit(tree, graceMs, readTable)).length === 0;
}

function observeTree(
  tree: SupervisedProcessTree,
  rows: readonly ProcessTableEntry[]
): void {
  const current = new Map(rows.map((entry) => [entry.pid, entry] as const));
  const children = new Map<number, ProcessTableEntry[]>();
  for (const row of rows) {
    if (isZombie(row)) continue;
    const entries = children.get(row.parentPid) || [];
    entries.push(row);
    children.set(row.parentPid, entries);
  }

  const pending: number[] = [];
  const ownedGroups = new Set<number>();
  for (const captured of tree.captured.values()) {
    const observed = current.get(captured.pid);
    const ownedLiveRoot = captured.pid === tree.root.pid && tree.ownedRoot && !tree.rootExited;
    if (observed && observed.processGroupId === captured.processGroupId && !isZombie(observed) &&
        (ownedLiveRoot || captured.startedAt !== undefined && captured.startedAt === observed.startedAt)) {
      pending.push(observed.pid);
      ownedGroups.add(observed.processGroupId);
    }
  }

  // Only a currently verified member establishes group ownership. A stored
  // numeric PGID alone is not authority after PID/PGID reuse.
  for (const row of rows) {
    if (!isZombie(row) && ownedGroups.has(row.processGroupId)) pending.push(row.pid);
  }

  const visited = new Set<number>();
  while (pending.length > 0) {
    const pid = pending.shift();
    if (pid === undefined || visited.has(pid)) continue;
    visited.add(pid);
    const row = current.get(pid);
    if (!row || isZombie(row)) continue;
    if (!tree.captured.has(row.pid) &&
        tree.captured.size >= MAX_SUPERVISED_PROCESSES_PER_TREE) {
      throw new ProcessObservationError({
        kind: "ledger-limit", durationMs: 0, timerLatenessMs: 0,
        psExitCode: null, osCode: null
      });
    }
    tree.captured.set(row.pid, {
      pid: row.pid,
      parentPid: row.parentPid,
      processGroupId: row.processGroupId,
      startedAt: row.startedAt
    });
    if (!ownedGroups.has(row.processGroupId)) {
      ownedGroups.add(row.processGroupId);
      for (const candidate of rows) {
        if (!isZombie(candidate) && candidate.processGroupId === row.processGroupId) {
          pending.push(candidate.pid);
        }
      }
    }
    for (const child of children.get(row.pid) || []) pending.push(child.pid);
  }
}

function runningTreeProcesses(
  tree: SupervisedProcessTree,
  rows: readonly ProcessTableEntry[]
): ProcessTableEntry[] {
  observeTree(tree, rows);
  return rows.filter((row) => {
    if (isZombie(row)) return false;
    const captured = tree.captured.get(row.pid);
    return captured?.processGroupId === row.processGroupId &&
      captured.startedAt !== undefined && captured.startedAt === row.startedAt;
  });
}

async function waitForTreeExit(
  tree: SupervisedProcessTree,
  timeoutMs: number,
  readTable: () => Promise<ProcessTableEntry[]>
): Promise<ProcessTableEntry[]> {
  const deadline = Date.now() + timeoutMs;
  let running: ProcessTableEntry[] = [];
  do {
    const rows = await readTable();
    running = runningTreeProcesses(tree, rows);
    if (running.length === 0) return running;
    if (Date.now() >= deadline) return running;
    await delay(PROCESS_EXIT_POLL_MS);
  } while (true);
}

function signalTreeProcesses(
  running: readonly ProcessTableEntry[],
  _rows: readonly ProcessTableEntry[],
  signal: NodeJS.Signals
): void {
  // Signal only birth-verified PIDs. A remembered numeric process group may
  // have gained unrelated members; group-wide signaling would include them.
  for (const entry of running) signalPid(entry.pid, signal);
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isSafeInteger(pid) || pid < 2 || pid === process.pid) {
    throw new Error(`Refusing to signal unsafe supervised process ${pid}.`);
  }
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (!isNoSuchProcess(error) && !isPermissionDenied(error)) throw error;
  }
}

/** @internal Exported for bounded probe and suspend/resume regressions. */
export function readProcessTable(
  spawnProbe: () => ChildProcess = () =>
    spawn("/bin/ps", ["-axo", "pid=,ppid=,pgid=,stat=,lstart="], {
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"]
    })
): Promise<ProcessTableEntry[]> {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    let child;
    try {
      child = spawnProbe();
    } catch (error) {
      reject(new ProcessObservationError({
        kind: "ps-spawn", durationMs: boundedObservationMs(performance.now() - startedAt),
        timerLatenessMs: 0, psExitCode: null, osCode: safeOsCode(error)
      }));
      return;
    }
    const stdout: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let timerLatenessMs = 0;
    let expectedTimeoutAt = performance.now() + PROCESS_TABLE_TIMEOUT_MS;
    let stage: "initial" | "settle" | "resume" = "initial";
    let timeout: NodeJS.Timeout;
    const failure = (
      kind: ProcessObservationFailure["kind"],
      psExitCode: number | null = null,
      osCode: string | null = null
    ) => new ProcessObservationError({
      kind,
      durationMs: boundedObservationMs(performance.now() - startedAt),
      timerLatenessMs,
      psExitCode,
      osCode
    });
    const schedule = (ms: number) => {
      expectedTimeoutAt = performance.now() + ms;
      timeout = setTimeout(onTimeout, ms);
      timeout.unref();
    };
    const onTimeout = () => {
      timerLatenessMs = Math.max(timerLatenessMs,
        boundedObservationMs(performance.now() - expectedTimeoutAt));
      if (stage !== "resume" &&
          timerLatenessMs > PROCESS_TABLE_LATE_TIMER_TOLERANCE_MS) {
        // /bin/ps and its supervisor can both be suspended with the machine.
        // A late timer firing on wake is not proof that process observation
        // failed. Give this same bounded probe a short post-resume interval.
        stage = "resume";
        schedule(PROCESS_TABLE_RESUME_GRACE_MS);
        return;
      }
      if (stage === "initial") {
        // A completed ps may have a queued close event behind this timer when
        // the owner event loop resumes near the original deadline.
        stage = "settle";
        schedule(PROCESS_TABLE_SETTLE_MS);
        return;
      }
      timedOut = true;
      child.kill("SIGKILL");
      reject(failure("ps-timeout"));
    };
    schedule(PROCESS_TABLE_TIMEOUT_MS);
    const capture = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > PROCESS_TABLE_MAX_BYTES) {
        outputLimitExceeded = true;
        child.kill("SIGKILL");
        reject(failure("ps-output-limit"));
        return;
      }
      target.push(chunk);
    };
    child.stdout?.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => capture([], chunk));
    child.once("error", error => {
      clearTimeout(timeout);
      reject(failure("ps-spawn", null, safeOsCode(error)));
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(failure("ps-timeout"));
        return;
      }
      if (outputLimitExceeded) {
        reject(failure("ps-output-limit"));
        return;
      }
      if (code !== 0) {
        reject(failure("ps-exit", code));
        return;
      }
      try {
        const entries = decodeUtf8Strict(Buffer.concat(stdout), "Process table stdout")
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => line.split(/\s+/))
          .map(([pid, parentPid, processGroupId, state, ...birth]) => ({
            pid: Number(pid),
            parentPid: Number(parentPid),
            processGroupId: Number(processGroupId),
            state: state || "",
            startedAt: birth.length ? birth.join(" ") : undefined
          }));
        if (entries.length === 0 || !entries.every((entry) =>
            Number.isSafeInteger(entry.pid) && entry.pid > 0 &&
            Number.isSafeInteger(entry.parentPid) && entry.parentPid >= 0 &&
            Number.isSafeInteger(entry.processGroupId) && entry.processGroupId > 0 &&
            typeof entry.state === "string" && entry.state.length > 0
          )) throw new Error("Invalid process table rows.");
        resolve(entries);
      } catch {
        reject(failure("ps-output-invalid"));
      }
    });
  });
}

function safeOsCode(error: unknown): string | null {
  const code = error && typeof error === "object" ? (error as NodeJS.ErrnoException).code : undefined;
  return typeof code === "string" && /^[A-Z0-9_]{1,24}$/u.test(code) ? code : null;
}

function boundedObservationMs(durationMs: number): number {
  return Math.min(OBSERVATION_DIAGNOSTIC_MAX_MS, Math.max(0, Math.round(durationMs)));
}

function validateRootIdentity(identity: JsonRpcProcessIdentity): void {
  if (
    !Number.isSafeInteger(identity.pid) || identity.pid < 2 ||
    (identity.processGroupId !== null &&
      (!Number.isSafeInteger(identity.processGroupId) || identity.processGroupId < 2))
  ) {
    throw new Error("Invalid supervised root process identity.");
  }
}

function validProcessIdentity(identity: SupervisedProcessIdentity): boolean {
  return Number.isSafeInteger(identity.pid) && identity.pid >= 2 &&
    Number.isSafeInteger(identity.parentPid) && identity.parentPid >= 0 &&
    Number.isSafeInteger(identity.processGroupId) && identity.processGroupId >= 2;
}

function isZombie(entry: ProcessTableEntry): boolean {
  return entry.state.startsWith("Z");
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isPermissionDenied(error);
  }
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!processAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await delay(PROCESS_EXIT_POLL_MS);
  } while (true);
}

function isNoSuchProcess(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    (error as NodeJS.ErrnoException).code === "ESRCH";
}

function isPermissionDenied(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    (error as NodeJS.ErrnoException).code === "EPERM";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
