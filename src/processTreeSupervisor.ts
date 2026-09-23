import { spawn } from "node:child_process";
import type { JsonRpcProcessIdentity } from "./jsonRpcProcess.js";
import { decodeUtf8Strict } from "./textIntegrity.js";

const PROCESS_TABLE_MAX_BYTES = 4 * 1024 * 1024;
const PROCESS_TABLE_TIMEOUT_MS = 1_000;
const PROCESS_TABLE_LATE_TIMER_TOLERANCE_MS = 250;
const PROCESS_TABLE_RESUME_GRACE_MS = 5_000;
const PROCESS_EXIT_POLL_MS = 25;
const MAX_SUPERVISED_PROCESSES_PER_TREE = 4_096;

export type SupervisedProcessIdentity = {
  pid: number;
  parentPid: number;
  processGroupId: number;
};

export type SupervisedProcessTreeSnapshot = {
  root: JsonRpcProcessIdentity;
  processes: SupervisedProcessIdentity[];
};

type ProcessTableEntry = SupervisedProcessIdentity & {
  state: string;
};

type SupervisedProcessTree = {
  root: JsonRpcProcessIdentity;
  captured: Map<number, SupervisedProcessIdentity>;
};

/**
 * Retains an independently owned process-tree ledger for App Server workers.
 *
 * A Unix child may create another process group, so the App Server's original
 * PGID is not sufficient cleanup evidence. While the root is alive, this
 * registry continuously folds descendants into a durable in-memory ledger.
 * Cleanup then verifies every captured PID/PGID and every owned group before
 * allowing the execution service to replace the worker generation.
 */
export class SupervisedProcessTreeRegistry {
  private readonly trees = new Map<string, SupervisedProcessTree>();
  private tail: Promise<void> = Promise.resolve();

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
      processes: [...tree.captured.values()].map((entry) => ({ ...entry }))
    }));
  }

  merge(snapshot: SupervisedProcessTreeSnapshot): void {
    const tree = this.trees.get(supervisedProcessKey(snapshot.root));
    if (!tree || snapshot.processes.length > MAX_SUPERVISED_PROCESSES_PER_TREE) return;
    for (const entry of snapshot.processes) {
      if (!validProcessIdentity(entry)) continue;
      tree.captured.set(entry.pid, { ...entry });
    }
  }

  forget(identity: JsonRpcProcessIdentity): void {
    this.trees.delete(supervisedProcessKey(identity));
  }

  register(identity: JsonRpcProcessIdentity): Promise<void> {
    validateRootIdentity(identity);
    const key = supervisedProcessKey(identity);
    if (!this.trees.has(key)) {
      this.trees.set(key, {
        root: { ...identity },
        captured: new Map([
          [identity.pid, {
            pid: identity.pid,
            parentPid: 0,
            processGroupId: identity.processGroupId ?? identity.pid
          }]
        ])
      });
    }
    return this.enqueue(async () => {
      if (process.platform === "win32") return;
      const tree = this.trees.get(key);
      if (!tree) return;
      const rows = await readProcessTable();
      observeTree(tree, rows);
      const root = rows.find((entry) => entry.pid === identity.pid);
      if (!root || root.processGroupId !== identity.processGroupId || isZombie(root)) {
        throw new Error(
          `SUPERVISED_PROCESS_REGISTRATION_LOST: Worker ${identity.pid} exited before registration.`
        );
      }
    });
  }

  refresh(): Promise<void> {
    if (this.trees.size === 0 || process.platform === "win32") return Promise.resolve();
    return this.enqueue(async () => {
      if (this.trees.size === 0) return;
      const rows = await readProcessTable();
      for (const tree of this.trees.values()) observeTree(tree, rows);
    });
  }

  release(identity: JsonRpcProcessIdentity, graceMs: number): Promise<boolean> {
    const key = supervisedProcessKey(identity);
    return this.enqueue(async () => {
      const tree = this.trees.get(key);
      if (!tree) return true;
      const exited = await terminateTree(tree, graceMs);
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
          const exited = await terminateTree(tree, graceMs);
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

export function supervisedProcessKey(identity: JsonRpcProcessIdentity): string {
  return `${identity.pid}:${identity.processGroupId ?? "process"}`;
}

async function terminateTree(
  tree: SupervisedProcessTree,
  graceMs: number
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

  let rows = await readProcessTable();
  observeTree(tree, rows);
  let running = runningTreeProcesses(tree, rows);
  if (running.length === 0) return true;
  signalTreeProcesses(running, rows, "SIGTERM");
  running = await waitForTreeExit(tree, graceMs);
  if (running.length === 0) return true;
  rows = await readProcessTable();
  observeTree(tree, rows);
  running = runningTreeProcesses(tree, rows);
  signalTreeProcesses(running, rows, "SIGKILL");
  return (await waitForTreeExit(tree, graceMs)).length === 0;
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
  if (tree.root.processGroupId !== null) ownedGroups.add(tree.root.processGroupId);
  for (const captured of tree.captured.values()) {
    const observed = current.get(captured.pid);
    if (observed && observed.processGroupId === captured.processGroupId && !isZombie(observed)) {
      pending.push(observed.pid);
      ownedGroups.add(observed.processGroupId);
    }
  }

  // A root can exit before its same-group children. The group is still owned
  // even when no surviving process retains the root as its PPID.
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
      throw new Error("Supervised process tree exceeded its bounded identity ledger.");
    }
    tree.captured.set(row.pid, {
      pid: row.pid,
      parentPid: row.parentPid,
      processGroupId: row.processGroupId
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
  const capturedGroups = new Set<number>();
  if (tree.root.processGroupId !== null) capturedGroups.add(tree.root.processGroupId);
  for (const entry of tree.captured.values()) capturedGroups.add(entry.processGroupId);
  return rows.filter((row) => {
    if (isZombie(row)) return false;
    if (capturedGroups.has(row.processGroupId)) return true;
    const captured = tree.captured.get(row.pid);
    return captured?.processGroupId === row.processGroupId;
  });
}

async function waitForTreeExit(
  tree: SupervisedProcessTree,
  timeoutMs: number
): Promise<ProcessTableEntry[]> {
  const deadline = Date.now() + timeoutMs;
  let running: ProcessTableEntry[] = [];
  do {
    const rows = await readProcessTable();
    running = runningTreeProcesses(tree, rows);
    if (running.length === 0) return running;
    if (Date.now() >= deadline) return running;
    await delay(PROCESS_EXIT_POLL_MS);
  } while (true);
}

function signalTreeProcesses(
  running: readonly ProcessTableEntry[],
  rows: readonly ProcessTableEntry[],
  signal: NodeJS.Signals
): void {
  const supervisorGroup = rows.find((entry) => entry.pid === process.pid)?.processGroupId;
  const groups = new Set(running.map((entry) => entry.processGroupId));
  const individuallySignaled = new Set<number>();
  for (const group of groups) {
    if (group <= 1 || group === supervisorGroup) {
      for (const entry of running) {
        if (entry.processGroupId !== group || individuallySignaled.has(entry.pid)) continue;
        signalPid(entry.pid, signal);
        individuallySignaled.add(entry.pid);
      }
      continue;
    }
    try {
      process.kill(-group, signal);
    } catch (error) {
      if (!isNoSuchProcess(error) && !isPermissionDenied(error)) throw error;
    }
  }
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

/** @internal Exported for the suspend/resume regression of the live probe. */
export function readProcessTable(): Promise<ProcessTableEntry[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/ps", ["-axo", "pid=,ppid=,pgid=,stat="], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;
    let expectedTimeoutAt = Date.now() + PROCESS_TABLE_TIMEOUT_MS;
    let timeout: NodeJS.Timeout;
    const onTimeout = () => {
      if (Date.now() - expectedTimeoutAt > PROCESS_TABLE_LATE_TIMER_TOLERANCE_MS) {
        // /bin/ps and its supervisor can both be suspended with the machine.
        // A late timer firing on wake is not proof that process observation
        // failed. Give this same bounded probe a short post-resume interval.
        expectedTimeoutAt = Date.now() + PROCESS_TABLE_RESUME_GRACE_MS;
        timeout = setTimeout(onTimeout, PROCESS_TABLE_RESUME_GRACE_MS);
        timeout.unref();
        return;
      }
      timedOut = true;
      child.kill("SIGKILL");
    };
    timeout = setTimeout(onTimeout, PROCESS_TABLE_TIMEOUT_MS);
    timeout.unref();
    const capture = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > PROCESS_TABLE_MAX_BYTES) {
        child.kill("SIGKILL");
        return;
      }
      target.push(chunk);
    };
    child.stdout?.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.once("error", error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error("Process table observation timed out."));
        return;
      }
      if (outputBytes > PROCESS_TABLE_MAX_BYTES) {
        reject(new Error("Process table output exceeded the supervision limit."));
        return;
      }
      if (code !== 0) {
        let detail = "";
        try {
          detail = decodeUtf8Strict(Buffer.concat(stderr), "Process table stderr").trim();
        } catch {
          reject(new Error("Process table emitted invalid UTF-8 diagnostics."));
          return;
        }
        reject(new Error(detail || `/bin/ps exited with status ${code ?? "unknown"}.`));
        return;
      }
      try {
        const entries = decodeUtf8Strict(Buffer.concat(stdout), "Process table stdout")
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => line.split(/\s+/, 4))
          .map(([pid, parentPid, processGroupId, state]) => ({
            pid: Number(pid),
            parentPid: Number(parentPid),
            processGroupId: Number(processGroupId),
            state: state || ""
          }))
          .filter((entry): entry is ProcessTableEntry =>
            Number.isSafeInteger(entry.pid) && entry.pid > 0 &&
            Number.isSafeInteger(entry.parentPid) && entry.parentPid >= 0 &&
            Number.isSafeInteger(entry.processGroupId) && entry.processGroupId > 0 &&
            typeof entry.state === "string" && entry.state.length > 0
          );
        resolve(entries);
      } catch (error) {
        reject(error);
      }
    });
  });
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
