import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspectClientRequestContract } from "../src/cliProtocol.js";
import protocolContract from "./fixtures/app-server-request-contract.json";
import { afterEach, describe, expect, it } from "vitest";
import { CodexRuntimeManager, type RuntimeInstaller, type RuntimeManagerOptions } from "../src/codexRuntime.js";

const temporary: string[] = [];
afterEach(async () => { for (const file of temporary.splice(0)) await rm(file, { recursive: true, force: true }); });
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-runtime-test-")); temporary.push(directory);
  const root = path.join(directory, "managed"), bin = path.join(directory, "bin");
  await mkdir(bin);
  const probe = async (file: string) => readFile(file, "utf8").then(value => /^version=(\d+\.\d+\.\d+)$/.exec(value)?.[1] || null).catch(() => null);
  const installer: RuntimeInstaller = async ({ directory: target, version, onProgress }) => {
    await onProgress("verifying"); const command = path.join(target, "codex"); await writeFile(command, `version=${version}`, { mode: 0o700 }); return command;
  };
  const options: RuntimeManagerOptions = { root, environment: { PATH: bin }, appPaths: [], probe, installer, protocolProbe: async () => inspectClientRequestContract(protocolContract),
    defaultVersion: "0.153.3", latestVersion: async () => "0.153.4" };
  const manager = new CodexRuntimeManager(options);
  const external = async (name = "codex", version = "0.153.3") => {
    const command = path.join(bin, name); await writeFile(command, `version=${version}`, { mode: 0o700 }); return command;
  };
  return { directory, root, bin, options, manager, external };
}

describe("Codex installation ownership and selection", () => {
  it("freezes the activation target across pending CLI application and checks it under the state lock", async () => {
    const f = await fixture(); await f.manager.install();
    const lease = await f.manager.acquire();
    const external = await f.external();
    const candidate = (await f.manager.discover()).find(item => item.command === external)!;
    await f.manager.select(candidate.id);
    const target = await f.manager.activationTarget();
    await expect(f.manager.applyPending(target)).rejects.toThrow("CODEX_APPLY_PENDING");
    await lease.release();
    await f.manager.applyPending(target);
    expect(await f.manager.activationTarget()).toEqual(target);
    expect((await f.manager.snapshot()).selection?.command).toBe(external);
    await f.manager.select(candidate.id);
    await expect(f.manager.applyPending(target)).rejects.toThrow("LIFECYCLE_TARGET_CHANGED");
  });
  it("marks a version-valid but permission-incompatible installation unavailable for execution", async () => {
    const f = await fixture(); await f.external();
    const support = inspectClientRequestContract(protocolContract);
    const manager = new CodexRuntimeManager({ ...f.options, protocolProbe: async () => ({ ...support, compatible: false, missingCore: ["thread/resume.sandbox"] }) });
    expect((await manager.snapshot()).selection).toMatchObject({ available: true, compatible: false });
    await expect(manager.resolve()).rejects.toThrow("thread/resume.sandbox");
  });

  it("persists a single installation and does not replace it when another appears or discovery order changes", async () => {
    const f = await fixture(); const command = await f.external();
    expect((await f.manager.snapshot()).selection?.command).toBe(command);
    const second = await f.external("app-codex");
    const reentered = new CodexRuntimeManager({ ...f.options, appPaths: [second] });
    expect((await reentered.snapshot()).selection?.command).toBe(command);
    await rm(command);
    await expect(reentered.resolve()).rejects.toThrow("CODEX_SELECTION_UNAVAILABLE");
    expect((await reentered.snapshot()).selection?.command).toBe(command);
  });
  it("deduplicates symlinks but keeps independent copies of the same version", async () => {
    const f = await fixture(); const app = await f.external("app");
    await symlink(app, path.join(f.bin, "codex"));
    const manager = new CodexRuntimeManager({ ...f.options, appPaths: [app] });
    expect((await manager.snapshot()).candidates).toHaveLength(1);
    expect((await manager.snapshot()).selection?.source).toBe("app");
    const other = await f.external("another-app");
    expect(await new CodexRuntimeManager({ ...f.options, appPaths: [app, other] }).discover()).toHaveLength(2);
  });
  it("asks for a choice between independent external installations and never selects the highest version", async () => {
    const f = await fixture(); await f.external(); const app = await f.external("app", "0.153.4");
    const manager = new CodexRuntimeManager({ ...f.options, appPaths: [app] });
    const snapshot = await manager.snapshot();
    expect(snapshot.selection).toBeNull(); expect(snapshot.selectionRequired).toBe(true);
    await manager.select(snapshot.candidates[1].id);
    expect((await manager.resolve()).version).toBe("0.153.3");
  });
  it("respects explicit paths without replacing a saved choice", async () => {
    const f = await fixture(); const original = await f.external(); await f.manager.snapshot();
    const explicit = await f.external("custom");
    expect((await f.manager.resolve(explicit)).command).toBe(explicit);
    expect((await f.manager.resolve()).command).toBe(original);
    await expect(f.manager.resolve("missing-codex")).rejects.toThrow("CODEX_SELECTION_UNAVAILABLE");
  });
  it("uses the same explicit installation for status and execution without mutating the saved selection", async () => {
    const f = await fixture(); await f.manager.install(); await f.manager.checkUpdates();
    const saved = (await f.manager.snapshot()).selection!;
    const command = await f.external();
    const manager = new CodexRuntimeManager({ ...f.options, environment: { ...f.options.environment, CODEX_MCP_BRIDGE_CODEX: command } });
    const snapshot = await manager.snapshot();
    expect(snapshot.selection?.command).toBe(command);
    expect(snapshot.configuredCommand).toBe(command);
    expect(snapshot.actions.update).toBe(false);
    expect(snapshot.actions.install).toBe(false);
    const acquired = await manager.acquire();
    expect(acquired.selection.command).toBe(command);
    await acquired.release();
    await expect(manager.select(saved.id)).rejects.toThrow("CODEX_EXPLICIT_OVERRIDE");
    await rm(command);
    expect((await manager.snapshot()).selection?.available).toBe(false);
    await expect(manager.resolve()).rejects.toThrow("CODEX_SELECTION_UNAVAILABLE");
    expect((await f.manager.resolve()).command).toBe(saved.command);
  });
  it("protects an explicitly referenced managed version even when a newer managed version is active", async () => {
    const f = await fixture(); await f.manager.install(); const original = await f.manager.resolve();
    await f.manager.checkUpdates(); await f.manager.install("update");
    const alias = path.join(f.bin, "codex"); await symlink(original.command, alias);
    const manager = new CodexRuntimeManager({ ...f.options, explicitCommand: alias });
    expect((await manager.discover()).every(item => item.source === "bridge")).toBe(true);
    expect((await manager.snapshot()).selection).toMatchObject({ source: "bridge", version: "0.153.3", available: true });
    expect((await manager.snapshot()).actions.remove).toBe(false);
    await expect(manager.remove()).rejects.toThrow("CODEX_EXPLICIT_OVERRIDE");
    await manager.cleanup();
    expect((await manager.resolve()).command).toBe(original.command);
  });
  it("deduplicates the current npm layout and notices native updates without launcher changes", async () => {
    const f = await fixture();
    const packageRoot = path.join(f.directory, "npm", "@openai", "codex");
    const target = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-${process.platform === "darwin" ? "apple-darwin" : process.platform === "win32" ? "pc-windows-msvc" : "unknown-linux-musl"}`;
    const native = path.join(packageRoot, "vendor", target, "bin", process.platform === "win32" ? "codex.exe" : "codex");
    const launcher = path.join(packageRoot, "bin", "codex.js");
    await mkdir(path.dirname(native), { recursive: true }); await mkdir(path.dirname(launcher));
    await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@openai/codex" }));
    await writeFile(native, "version=0.153.3", { mode: 0o700 });
    await writeFile(launcher, "npm launcher fixture", { mode: 0o700 });
    await symlink(launcher, path.join(f.bin, "codex"));
    const manager = new CodexRuntimeManager({ ...f.options, appPaths: [native], probe: async () => f.options.probe!(native) });
    expect((await manager.snapshot()).candidates).toHaveLength(1);
    const terminal = new CodexRuntimeManager({ ...f.options, probe: async () => f.options.probe!(native) });
    expect((await terminal.discover())[0]).toMatchObject({ physicalPath: await realpath(native), version: "0.153.3" });
    // The real launcher reads its native executable; only that executable changed.
    await writeFile(`${native}.next`, "version=0.153.4", { mode: 0o700 });
    await rename(`${native}.next`, native);
    expect((await terminal.discover())[0].version).toBe("0.153.4");
  });
  it("never updates, removes or repairs an external installation", async () => {
    const f = await fixture(); const original = await f.external(); await f.manager.checkUpdates();
    const snapshot = await f.manager.snapshot();
    expect(snapshot.actions.update).toBe(false); expect(snapshot.actions.remove).toBe(false); expect(snapshot.actions.reinstall).toBe(false);
    await expect(f.manager.remove()).rejects.toThrow("CODEX_NOT_BRIDGE_OWNED");
    expect(await readFile(original, "utf8")).toBe("version=0.153.3");
  });
  it.each(["app", "terminal"] as const)("refreshes a replaced %s binary without changing the saved choice or a live lease", async source => {
    const f = await fixture();
    const command = await f.external();
    const manager = new CodexRuntimeManager({ ...f.options, appPaths: source === "app" ? [command] : [] });
    const before = (await manager.snapshot()).selection!;
    expect(before.source).toBe(source);
    const lease = await manager.acquire();
    try {
      await writeFile(`${command}.next`, "version=99.0.0", { mode: 0o700 });
      await rename(`${command}.next`, command);
      const after = await manager.snapshot();
      expect(after.selection).toMatchObject({ id: before.id, source, command, version: "99.0.0", available: true });
      expect(after.installedVersion).toBe("99.0.0");
      expect(after.runningVersions).toEqual(["0.153.3"]);
      expect(lease.selection.version).toBe("0.153.3");
      expect((await manager.resolve()).version).toBe("99.0.0");
      expect(after.actions.update).toBe(false);
      expect(after.actions.remove).toBe(false);
    } finally { await lease.release(); }
    expect((await manager.snapshot()).runningVersions).toEqual([]);
  });
  it("fails closed on damaged state instead of choosing an external installation", async () => {
    const f = await fixture(); await f.external(); await mkdir(f.root); await writeFile(path.join(f.root, "cli-state.json"), "{}");
    await expect(f.manager.resolve()).rejects.toThrow("CODEX_STATE_INVALID");
  });
});

describe("Bridge-owned version lifecycle", () => {
  it("uses the same selected identity as discovery through a symlinked runtime directory", async () => {
    const f = await fixture();
    await mkdir(f.root);
    const alias = path.join(f.directory, "managed-alias");
    await symlink(f.root, alias);
    const manager = new CodexRuntimeManager({ ...f.options, root: alias });
    const installed = await manager.install();
    const candidate = installed.candidates.find(item => item.command === installed.selection?.command)!;
    expect(installed.selection?.id).toBe(candidate.id);
    expect(installed.selection?.physicalPath).toBe(candidate.physicalPath);
    expect((await new CodexRuntimeManager({ ...f.options, root: alias }).snapshot()).selection?.id).toBe(candidate.id);
  });
  it("does not offer a modified managed binary as a selectable installation even if its version still matches", async () => {
    const f = await fixture();
    const manager = new CodexRuntimeManager({ ...f.options, probe: file => readFile(file, "utf8")
      .then(value => /^version=(\d+\.\d+\.\d+)/.exec(value)?.[1] || null).catch(() => null) });
    const installed = await manager.install();
    await writeFile(installed.selection!.command, "version=0.153.3\nmodified executable");
    const broken = await manager.snapshot();
    expect(broken.selection?.available).toBe(false);
    const candidate = broken.candidates.find(item => item.source === "bridge")!;
    expect(candidate.available).toBe(false);
    await expect(manager.select(candidate.id)).rejects.toThrow("CODEX_SELECTION_UNAVAILABLE");
    expect(broken.actions.reinstall).toBe(true);
  });
  it("does not download an already staged update again while waiting for a running version to finish", async () => {
    const f = await fixture(); await f.manager.install();
    const acquired = await f.manager.acquire();
    try {
      await f.manager.checkUpdates();
      const pending = await f.manager.install("update");
      expect(pending.stagedVersion).toBe("0.153.4");
      expect(pending.actions.update).toBe(false);
      await expect(f.manager.install("update")).rejects.toThrow("CODEX_ACTION_UNAVAILABLE");
      expect((await f.manager.snapshot()).managedVersions).toHaveLength(2);
    } finally { await acquired.release(); }
    await f.manager.applyPending();
    expect((await f.manager.snapshot()).installedVersion).toBe("0.153.4");
  });
  it("offers rollback only when the recovery executable remains intact", async () => {
    const f = await fixture();
    const installed = await f.manager.install();
    await f.manager.checkUpdates(); await f.manager.install("update");
    expect((await f.manager.snapshot()).actions.rollback).toBe(true);
    await rm(installed.selection!.command);
    const brokenRecovery = await f.manager.snapshot();
    expect(brokenRecovery.actions.rollback).toBe(false);
    expect(brokenRecovery.selection?.available).toBe(true);
    await expect(f.manager.rollback()).rejects.toThrow("CODEX_ACTION_UNAVAILABLE");
  });
  it("rechecks a staged update under the state lock when another request used an older snapshot", async () => {
    const f = await fixture(); await f.manager.install(); await f.manager.checkUpdates();
    const acquired = await f.manager.acquire();
    try {
      const before = await f.manager.snapshot();
      await f.manager.install("update");
      const read = f.manager.snapshot.bind(f.manager);
      let first = true;
      f.manager.snapshot = async () => {
        if (first) { first = false; return before; }
        return read();
      };
      await expect(f.manager.install("update")).rejects.toThrow("already waiting to be applied");
      expect((await f.manager.snapshot()).managedVersions).toHaveLength(2);
    } finally { await acquired.release(); }
  });
  it("retains a verified staged installation when activation fails and retries without downloading it again", async () => {
    const f = await fixture(); await f.manager.install(); await f.manager.checkUpdates();
    const activate = f.manager.applyPending.bind(f.manager);
    f.manager.applyPending = async () => { throw new Error("activation write failed"); };
    await expect(f.manager.install("update")).rejects.toThrow("CODEX_APPLY_FAILED");
    const failed = await f.manager.snapshot();
    expect(failed.installedVersion).toBe("0.153.3");
    expect(failed.stagedVersion).toBe("0.153.4");
    expect(failed.operation).toMatchObject({ action: "apply", phase: "failed" });
    f.manager.applyPending = activate;
    const retried = await f.manager.retry();
    expect(retried.installedVersion).toBe("0.153.4");
    expect(retried.managedVersions).toHaveLength(2);
    expect(retried.actions.retry).toBe(false);
  });
  it("keeps a newer explicit source choice when an earlier installation finishes later", async () => {
    const f = await fixture(); await f.external();
    let proceed!: () => void;
    const wait = new Promise<void>(resolve => { proceed = resolve; });
    const manager = new CodexRuntimeManager({ ...f.options, installer: async options => { await wait; return f.options.installer!(options); } });
    const external = (await manager.snapshot()).selection!;
    const installing = manager.install();
    await expect.poll(async () => (await manager.snapshot()).operation?.phase).toBe("downloading");
    await manager.select(external.id);
    proceed(); await installing;
    expect((await manager.resolve()).command).toBe(external.command);
    expect((await manager.snapshot()).candidates.some(item => item.source === "bridge")).toBe(true);
  });
  it("protects acquired installations until their release and honors a pin set while an update waits", async () => {
    const f = await fixture(); await f.manager.install();
    const acquired = await f.manager.acquire();
    await f.manager.checkUpdates(); await f.manager.install("update");
    await f.manager.setPreferences({ pinnedVersion: acquired.selection.version });
    await acquired.release(); await f.manager.applyPending();
    expect((await f.manager.resolve()).version).toBe("0.153.3");
    expect((await f.manager.snapshot()).stagedVersion).toBeNull();
    expect((await f.manager.snapshot()).actions.cleanup).toBe(true);
    await f.manager.cleanup();
    expect((await f.manager.snapshot()).reclaimableBytes).toBe(0);
  });
  it("can remove an unused managed installation while preserving the selected external CLI", async () => {
    const f = await fixture(); const command = await f.external(); await f.manager.install();
    const candidate = (await f.manager.discover()).find(item => item.command === command)!;
    await f.manager.select(candidate.id);
    const acquired = await f.manager.acquire();
    expect((await f.manager.snapshot()).actions.remove).toBe(true);
    await f.manager.remove();
    expect((await f.manager.resolve()).command).toBe(command);
    expect(await readFile(command, "utf8")).toContain("0.153.3");
    await acquired.release();
  });
  it("persists a failed update check and retries that operation without reinstalling", async () => {
    const f = await fixture(); await f.manager.install(); const command = (await f.manager.resolve()).command;
    const successful = await f.manager.checkUpdates();
    expect(successful.lastSuccessfulCheckAt).toBe(successful.checkedAt);
    const offline = new CodexRuntimeManager({ ...f.options, latestVersion: async () => { throw new Error("PRIVATE network details"); } });
    await expect(offline.checkUpdates()).rejects.toThrow("CODEX_UPDATE_CHECK_FAILED");
    expect(await offline.snapshot()).toMatchObject({ latestVersion: "0.153.4", lastSuccessfulCheckAt: successful.lastSuccessfulCheckAt, updateCheckError: "CODEX_UPDATE_CHECK_FAILED" });
    expect((await offline.snapshot()).operation).toMatchObject({ action: "check-updates", phase: "failed", error: "CODEX_UPDATE_CHECK_FAILED" });
    expect((await f.manager.retry()).actions.retry).toBe(false);
    expect((await f.manager.snapshot()).updateCheckError).toBeNull();
    expect((await f.manager.resolve()).command).toBe(command);
  });
  it("installs explicitly even with an external CLI, and removal preserves user data and the no-auto-selection choice", async () => {
    const f = await fixture(); const external = await f.external(); await f.manager.snapshot();
    const before = await f.manager.install(); expect(before.selection?.source).toBe("bridge");
    const auth = path.join(f.root, "profiles", "api-key", "auth.json"); await mkdir(path.dirname(auth), { recursive: true }); await writeFile(auth, "private");
    await f.manager.remove();
    expect((await new CodexRuntimeManager(f.options).snapshot()).selection).toBeNull();
    expect(await readFile(external, "utf8")).toContain("0.153.3"); expect(await readFile(auth, "utf8")).toBe("private");
  });
  it("stages updates while a runtime is alive, reports installed and running versions, then supports rollback", async () => {
    const f = await fixture(); await f.manager.install(); const old = await f.manager.resolve(); const release = await f.manager.lease(old);
    await f.manager.checkUpdates(); const pending = await f.manager.install("update");
    expect(pending.installedVersion).toBe("0.153.3"); expect(pending.runningVersions).toEqual(["0.153.3"]);
    expect(pending.stagedVersion).toBe("0.153.4"); expect(pending.operation?.phase).toBe("pending");
    await expect(f.manager.remove()).rejects.toThrow("CODEX_IN_USE");
    await release(); await f.manager.applyPending();
    expect((await f.manager.resolve()).version).toBe("0.153.4");
    expect((await f.manager.rollback()).installedVersion).toBe("0.153.3");
  });
  it("preserves pins, skipped versions and notifications across restarts without any install during update checks", async () => {
    const f = await fixture(); await f.manager.install(); await f.manager.checkUpdates();
    await f.manager.setPreferences({ pinnedVersion: "0.153.3", notifications: false });
    const restart = new CodexRuntimeManager(f.options);
    expect((await restart.snapshot()).updateVersion).toBeNull();
    expect((await restart.snapshot()).preferences.notifications).toBe(false);
    await restart.setPreferences({ pinnedVersion: null, skippedVersion: "0.153.4" });
    expect((await restart.snapshot()).actions.update).toBe(false);
    await restart.setPreferences({ skippedVersion: null });
    expect((await restart.snapshot()).updateVersion).toBe("0.153.4");
    expect((await restart.snapshot()).installedVersion).toBe("0.153.3");
  });
  it("offers repair only for a damaged executable and clears retry state after a successful retry", async () => {
    const f = await fixture(); await f.manager.install(); const selected = await f.manager.resolve();
    expect((await f.manager.snapshot()).actions.reinstall).toBe(false);
    await rm(selected.command);
    expect((await f.manager.snapshot()).actions.reinstall).toBe(true);
    const broken = new CodexRuntimeManager({ ...f.options, installer: async () => { throw new Error("private secret failure"); } });
    await expect(broken.install("reinstall")).rejects.toThrow("CODEX_INSTALL_FAILED");
    expect((await broken.snapshot()).operation?.error).toBe("CODEX_INSTALL_FAILED");
    const repaired = await f.manager.retry();
    expect(repaired.selection?.available).toBe(true); expect(repaired.actions.retry).toBe(false);
  });
  it("allows an unknown newer stable release while preserving explicit user update control", async () => {
    const f = await fixture(); await f.manager.install();
    const manager = new CodexRuntimeManager({ ...f.options, latestVersion: async () => "99.0.0" });
    const snapshot = await manager.checkUpdates();
    expect(snapshot.latestVersion).toBe("99.0.0"); expect(snapshot.actions.update).toBe(true);
    expect((await manager.install("update")).installedVersion).toBe("99.0.0");
  });
  it("queues a user selection while running and never changes the executable used by the live process", async () => {
    const f = await fixture(); await f.external(); const selected = await f.manager.resolve(); const release = await f.manager.lease(selected);
    await f.manager.install();
    const pending = await f.manager.snapshot(); expect(pending.selection?.source).toBe("terminal");
    expect(pending.stagedVersion).toBe("0.153.3");
    await release(); await f.manager.applyPending(); expect((await f.manager.resolve()).source).toBe("bridge");
  });
});


describe("latest stable installation admission", () => {
  it("resolves the initial latest version and validates it before activation", async () => {
    const f = await fixture(), verified: string[] = [];
    const manager = new CodexRuntimeManager({ ...f.options, defaultVersion: undefined,
      validationId: "test-contract", validateInstall: async (_command, version) => { verified.push(version); } });
    const result = await manager.install();
    expect(verified).toEqual(["0.153.4"]); expect(result.selection).toMatchObject({ version: "0.153.4", compatible: true });
    expect((await new CodexRuntimeManager({ ...f.options, validationId: "test-contract" }).snapshot()).selection?.available).toBe(true);
  });
  it("honors an existing version pin and an explicit compatible installation choice", async () => {
    const f = await fixture();
    const manager = new CodexRuntimeManager({ ...f.options, defaultVersion: undefined });
    await manager.setPreferences({ pinnedVersion: "0.153.3" });
    expect((await manager.install()).installedVersion).toBe("0.153.3");
    await manager.remove(); await manager.setPreferences({ pinnedVersion: null });
    expect((await manager.install("install", "0.153.3")).installedVersion).toBe("0.153.3");
  });
  it("preserves the selected installation on failed verification and does not activate an unverified latest version", async () => {
    const f = await fixture(); await f.manager.install(); await f.manager.checkUpdates();
    const selected = await f.manager.resolve();
    const manager = new CodexRuntimeManager({ ...f.options,  validateInstall: async () => { throw new Error("incompatible"); } });
    await expect(manager.install("update")).rejects.toThrow("CODEX_INSTALL_FAILED");
    expect((await manager.snapshot()).selection?.command).toBe(selected.command);
    expect((await manager.snapshot()).stagedVersion).toBeNull();
    expect(await readFile(selected.command, "utf8")).toBe("version=0.153.3");
  });
  it("records an unavailable registry as retryable without silently installing a bundled version", async () => {
    const f = await fixture();
    const manager = new CodexRuntimeManager({ ...f.options, defaultVersion: undefined, latestVersion: async () => { throw new Error("offline"); } });
    await expect(manager.install()).rejects.toThrow("CODEX_UPDATE_CHECK_FAILED");
    const result = await manager.snapshot(); expect(result.actions.retry).toBe(true); expect(result.installedVersion).toBeNull();
  });
});


it("preserves a user source change while the latest-version request is still in flight", async () => {
  const f = await fixture(); await f.external(); await f.manager.snapshot();
  const app = await f.external("app");
  let finish!: (version: string) => void, entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const manager = new CodexRuntimeManager({ ...f.options, appPaths: [app], defaultVersion: undefined,
    latestVersion: () => { entered(); return new Promise(resolve => { finish = resolve; }); } });
  const installing = manager.install(); await enteredPromise;
  const candidate = (await manager.discover()).find(item => item.source === "app")!;
  await manager.select(candidate.id); finish("0.153.4");
  const result = await installing;
  expect(result.selection).toMatchObject({ source: "app", command: app });
  expect(result.managedVersions.some(item => item.version === "0.153.4")).toBe(true);
});

it("does not replace another installation's progress with a failed version lookup", async () => {
  const f = await fixture();
  let rejectVersion!: (error: Error) => void, entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const first = new CodexRuntimeManager({ ...f.options, defaultVersion: undefined,
    latestVersion: () => { entered(); return new Promise((_resolve, reject) => { rejectVersion = reject; }); } });
  const resolving = first.install(); await enteredPromise;
  let release!: () => void, installing!: () => void;
  const installingPromise = new Promise<void>(resolve => { installing = resolve; });
  const second = new CodexRuntimeManager({ ...f.options, installer: async args => {
    await args.onProgress("installing"); installing(); await new Promise<void>(resolve => { release = resolve; });
    return f.options.installer!(args);
  } });
  const pending = second.install(); await installingPromise;
  rejectVersion(new Error("offline")); await expect(resolving).rejects.toThrow("CODEX_UPDATE_CHECK_FAILED");
  expect((await second.snapshot()).operation?.phase).toBe("installing");
  release(); expect((await pending).installedVersion).toBe("0.153.3");
});
