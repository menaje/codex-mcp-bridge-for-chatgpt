import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CodexRuntimeManager } from "../src/codexRuntime.js";

const writeGate = vi.hoisted(() => ({
  started: undefined as (() => void) | undefined,
  wait: undefined as Promise<void> | undefined
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual, writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
    if (writeGate.started && typeof args[1] === "string" && args[1].includes('"startedAt"') && args[1].includes('"selection"')) {
      const started = writeGate.started, wait = writeGate.wait;
      writeGate.started = undefined;
      await actual.writeFile(args[0], "", args[2]);
      started();
      await wait;
      return actual.writeFile(args[0], args[1], { mode: 0o600, flag: "w" });
    }
    return actual.writeFile(...args);
  } };
});

const roots: string[] = [];
afterEach(async () => {
  writeGate.started = undefined;
  writeGate.wait = undefined;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("publishes a complete runtime lease before concurrent readers can observe it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "codex-lease-publication-")); roots.push(root);
  const manager = new CodexRuntimeManager({ root, discoverExternal: false, environment: {} });
  let resume!: () => void;
  writeGate.wait = new Promise<void>(resolve => { resume = resolve; });
  const started = new Promise<void>(resolve => { writeGate.started = resolve; });
  const pending = manager.lease({ id: "fixture", source: "terminal", command: "/fixture/codex",
    physicalPath: "/fixture/codex", version: "0.153.4" });
  let release: (() => Promise<void>) | undefined;
  try {
    await started;
    // A slow disk write must not make an unrelated status read or restart
    // reservation fail with CODEX_LEASE_INVALID.
    expect((await manager.snapshot()).runningVersions).toEqual([]);
    resume(); release = await pending;
    expect((await manager.snapshot()).runningVersions).toEqual(["0.153.4"]);
    expect(await readdir(path.join(root, "leases"))).toHaveLength(1);
    expect((await readdir(root)).filter(name => name.endsWith(".tmp"))).toEqual([]);
  } finally { resume(); await (release ?? await pending)(); }
});

it("still refuses a corrupt published lease instead of treating it as unused", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "codex-lease-invalid-")); roots.push(root);
  const manager = new CodexRuntimeManager({ root, discoverExternal: false, environment: {} });
  const release = await manager.lease({ id: "fixture", source: "terminal", command: "/fixture/codex",
    physicalPath: "/fixture/codex", version: "0.153.4" });
  try {
    const [name] = await readdir(path.join(root, "leases"));
    await writeFile(path.join(root, "leases", name), "{");
    await expect(manager.snapshot()).rejects.toThrow("CODEX_LEASE_INVALID");
  } finally { await release(); }
});
