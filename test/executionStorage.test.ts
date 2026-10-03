import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { CodexAuthSelectionManager } from "../src/codexAuthSelection.js";
import { CodexService } from "../src/codexService.js";
import { authProfileEnvironment } from "../scripts/auth-selection.mjs";
import { codexChildEnvironment, codexProcessEnvironment } from "../scripts/runtime-env.mjs";
import { createIndependentProfileStorage } from "../scripts/execution-storage.mjs";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "bridge-storage-test-")); roots.push(root);
  const manager = new CodexAuthSelectionManager(root);
  const environment = { HOME: root, CODEX_MCP_BRIDGE_RUNTIME_HOME: root };
  const candidate = (await manager.prepare("bridge-chatgpt", 0, environment)).candidate!;
  const home = path.join(root, "auth-profiles", candidate.id);
  return { root, manager, environment, candidate, home, store: path.join(root, "execution-storage") };
}

it("shares native rollout and SQLite locations across new profiles while retaining distinct credentials", async () => {
  const f = await fixture();
  await writeFile(path.join(f.home, "auth.json"), "synthetic-first-credential");
  await f.manager.cancelCandidate(f.candidate.id, 1);
  const second = (await f.manager.prepare("bridge-api", 2, f.environment)).candidate!;
  const secondHome = path.join(f.root, "auth-profiles", second.id);
  await expect(readFile(path.join(secondHome, "auth.json"))).rejects.toMatchObject({ code: "ENOENT" });
  const first = authProfileEnvironment(f.root, f.candidate.id);
  const next = authProfileEnvironment(f.root, second.id);
  expect(first.CODEX_HOME).not.toBe(next.CODEX_HOME);
  expect(first.CODEX_SQLITE_HOME).toBe(next.CODEX_SQLITE_HOME);
  await writeFile(path.join(f.home, "sessions", "preserved-rollout.jsonl"), "synthetic-context");
  expect(await readFile(path.join(secondHome, "sessions", "preserved-rollout.jsonl"), "utf8")).toBe("synthetic-context");
  expect(await realpath(path.join(f.home, "archived_sessions"))).toBe(await realpath(path.join(secondHome, "archived_sessions")));
  await f.manager.cancelCandidate(second.id, 3);
  expect(authProfileEnvironment(f.root, f.candidate.id).CODEX_SQLITE_HOME).toBe(first.CODEX_SQLITE_HOME);
  expect(await readFile(path.join(f.home, "auth.json"), "utf8")).toBe("synthetic-first-credential");
});

it("preserves an existing unbound profile and explicit external home without adopting their data", async () => {
  const f = await fixture();
  const id = randomUUID(), oldHome = path.join(f.root, "auth-profiles", id);
  await mkdir(path.join(oldHome, "sessions"), { recursive: true });
  await writeFile(path.join(oldHome, "sessions", "old.jsonl"), "old-context");
  expect(authProfileEnvironment(f.root, id)).toEqual({ CODEX_HOME: oldHome });
  const external = codexChildEnvironment(undefined, { ...f.environment, CODEX_HOME: oldHome, CODEX_SQLITE_HOME: "/explicit/sqlite" });
  expect(external).toMatchObject({ CODEX_HOME: oldHome, CODEX_SQLITE_HOME: "/explicit/sqlite", CODEX_MCP_BRIDGE_AUTH_SOURCE: "shared" });
  expect(await readFile(path.join(oldHome, "sessions", "old.jsonl"), "utf8")).toBe("old-context");
  await expect(createIndependentProfileStorage(f.root, oldHome)).rejects.toThrow("CODEX_STORAGE_PROFILE_NOT_EMPTY");
});

it.each(["rollout-link", "sqlite-config", "ownership", "state-binding"])("blocks a changed %s binding without replacing history or credentials", async change => {
  const f = await fixture();
  await writeFile(path.join(f.store, "sessions", "original.jsonl"), "original-context");
  await writeFile(path.join(f.home, "auth.json"), "original-credential");
  if (change === "rollout-link") {
    const other = path.join(f.root, "other"); await mkdir(other);
    await rm(path.join(f.home, "sessions")); await symlink(other, path.join(f.home, "sessions"));
  } else if (change === "sqlite-config") {
    await writeFile(path.join(f.home, "config.toml"), 'sqlite_home = "/another/store"\n');
  } else if (change === "ownership") {
    await rm(path.join(f.store, "bridge-storage.json"));
  } else {
    const file = path.join(f.root, "auth-selection.json");
    const state = JSON.parse(await readFile(file, "utf8")); delete state.profiles[0].storageId;
    await writeFile(file, JSON.stringify(state));
  }
  expect(() => authProfileEnvironment(f.root, f.candidate.id)).toThrow("CODEX_STORAGE_UNAVAILABLE");
  expect(await readFile(path.join(f.store, "sessions", "original.jsonl"), "utf8")).toBe("original-context");
  expect(await readFile(path.join(f.home, "auth.json"), "utf8")).toBe("original-credential");
});

it("revalidates storage before current admission and rejects a sealed worker with another SQLite location", async () => {
  const f = await fixture();
  const projected = { ...f.environment, ...authProfileEnvironment(f.root, f.candidate.id), CODEX_MCP_BRIDGE_AUTH_SOURCE: "bridge-chatgpt" };
  expect(codexProcessEnvironment(projected).CODEX_SQLITE_HOME).toBe(path.join(f.store, "sqlite"));
  expect(() => codexProcessEnvironment({ ...projected, CODEX_SQLITE_HOME: "/different/sqlite" })).toThrow("CODEX_STORAGE_UNAVAILABLE");
  const service = new CodexService(projected);
  await rm(path.join(f.home, "sessions"));
  await expect(service.assertCurrentAdmission()).rejects.toThrow("CODEX_STORAGE_UNAVAILABLE");
  expect(service.currentExecutionAuthBoundary()).toBeNull();
});

it("refuses unowned storage instead of adopting or merging existing files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bridge-storage-unowned-")); roots.push(root);
  const store = path.join(root, "execution-storage"), home = path.join(root, "new-profile");
  await mkdir(store); await mkdir(home);
  await writeFile(path.join(store, "original"), "retain");
  await expect(createIndependentProfileStorage(root, home)).rejects.toThrow("CODEX_STORAGE_UNOWNED");
  expect(await readFile(path.join(store, "original"), "utf8")).toBe("retain");
});
