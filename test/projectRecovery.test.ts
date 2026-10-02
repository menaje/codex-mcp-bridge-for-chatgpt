import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { BridgeStateStore } from "../src/stateStore.js";
import { UserSettingsStore } from "../src/userSettings.js";
import type { ProjectRegistryOperation } from "../src/projectRegistry.js";
import { tombstoneProjectForTest } from "./helpers/sqliteSettings.js";

const SCOPE = "11111111-1111-4111-8111-111111111111";

describe("project deletion and tombstone recovery (#224)", () => {
  let directory: string;
  let file: string;
  let state: BridgeStateStore;
  let settings: UserSettingsStore;

  beforeEach(() => {
    directory = realpathSync(mkdtempSync(path.join(tmpdir(), "project-recovery-")));
    file = path.join(directory, "state.sqlite");
    state = new BridgeStateStore({ file });
    settings = new UserSettingsStore(loadConfig({ CODEX_MCP_BRIDGE_NO_AUTH: "1" }), { stateStore: state });
  });
  afterEach(() => { state.close(); rmSync(directory, { recursive: true }); });

  function apply(...operations: ProjectRegistryOperation[]) {
    return settings.updateWithProjectOperations({}, operations, undefined, settings.current.registryRevision);
  }
  function register(name = "Original", folder = "original") {
    const cwd = path.join(directory, folder);
    mkdirSync(cwd);
    apply({ kind: "add", project: { name, cwd } });
    return settings.current.projects.find(project => project.cwd === cwd)!;
  }
  function mutate(sql: string, ...parameters: Array<string | number>) {
    const database = new Database(file);
    try { database.prepare(sql).run(...parameters); } finally { database.close(); }
  }
  function activity(project = settings.current.projects[0]!) {
    return state.createActivity({ scopeId: SCOPE, projectId: project.id,
      projectName: project.name, projectCwd: project.cwd, now: 1 });
  }
  function thread(project = settings.current.projects[0]!) {
    const agent = state.createAgent({ scopeId: SCOPE, agentName: "Retained", now: 1 });
    const threadId = randomUUID();
    state.linkAgentThread({ agentId: agent.agentId, threadId, projectId: project.id,
      projectName: project.name, cwd: project.cwd, backendKind: "mcp-server",
      sandbox: "read-only", contextMode: "fresh", now: 2 });
    return { agent, threadId };
  }

  it.each(["open", "sealed", "terminating"])("rejects deletion with a %s Activity without advancing CAS", lifecycle => {
    const project = register();
    const retained = activity(project);
    mutate("UPDATE activities SET lifecycle = ? WHERE activity_id = ?", lifecycle, retained.activityId);
    apply({ kind: "archive", projectId: project.id });
    const before = settings.current;
    expect(() => apply({ kind: "delete", projectId: project.id })).toThrow("PROJECT_DELETE_STILL_PINNED");
    expect(settings.current).toEqual(before);
    expect(settings.recoverableProjects).toEqual([]);
    expect(state.getActivityProjectAdmission(retained.activityId)?.projectId).toBe(project.id);
  });

  it("rejects deletion with a current idle Agent thread, then allows it after that context is released", () => {
    const project = register();
    const retained = thread(project);
    apply({ kind: "archive", projectId: project.id });
    expect(() => apply({ kind: "delete", projectId: project.id })).toThrow("PROJECT_DELETE_STILL_PINNED");
    state.setAgentExecutionState(retained.agent.agentId, "orphaned", { orphanedReason: "Context explicitly released" });
    apply({ kind: "delete", projectId: project.id });
    expect(settings.current.projects).toEqual([]);
    apply({ kind: "add", project: { name: project.name, cwd: project.cwd } });
    expect(settings.current.projects[0]!.id).not.toBe(project.id);
  });

  it("rolls back other project and ordinary settings changes when a pinned delete fails", () => {
    const project = register();
    activity(project);
    const other = register("Other", "other");
    apply({ kind: "archive", projectId: project.id });
    const before = settings.current;
    expect(() => settings.updateWithProjectOperations({ maxConcurrentJobs: 8 }, [
      { kind: "rename", projectId: other.id, name: "Changed" },
      { kind: "delete", projectId: project.id }
    ], before.settingsRevision, before.registryRevision)).toThrow("PROJECT_DELETE_STILL_PINNED");
    expect(settings.current).toEqual(before);
  });

  it.each(["running", "terminating", "termination-failed"])("protects a %s Job even with a legacy terminal Activity", status => {
    const project = register();
    const retained = activity(project);
    state.upsertJob({ jobId: randomUUID(), requestId: randomUUID(), scopeId: SCOPE,
      activityId: retained.activityId, projectId: project.id, projectName: project.name,
      cwd: project.cwd, status, updatedAt: 3 });
    mutate("UPDATE activities SET lifecycle = 'completed' WHERE activity_id = ?", retained.activityId);
    apply({ kind: "archive", projectId: project.id });
    expect(() => apply({ kind: "delete", projectId: project.id })).toThrow("PROJECT_DELETE_STILL_PINNED");
  });

  it("restores a legacy tombstone with the same UUID/ref and all retained work links, including across restart", () => {
    const project = register();
    const retainedActivity = activity(project);
    const retainedThread = thread(project);
    const jobId = randomUUID();
    state.upsertJob({ jobId, requestId: randomUUID(), scopeId: SCOPE,
      activityId: retainedActivity.activityId, projectId: project.id, projectName: project.name,
      cwd: project.cwd, status: "completed", updatedAt: 3 });
    apply({ kind: "archive", projectId: project.id });
    tombstoneProjectForTest(file, project.id);
    expect(settings.current.projects).toEqual([]);
    expect(() => settings.resolveProject()).toThrow("PROJECT_SETUP_REQUIRED");
    expect(settings.recoverableProjects).toHaveLength(1);
    expect(() => apply({ kind: "add", project: { name: project.name, cwd: project.cwd } }))
      .toThrow("PROJECT_CWD_STILL_PINNED");
    const revision = settings.current.registryRevision;
    const ordinaryRevision = settings.current.settingsRevision;
    expect(() => settings.updateWithProjectOperations({}, [{ kind: "restore", projectId: project.id }], undefined, revision - 1))
      .toThrow("PROJECT_REGISTRY_REVISION_CONFLICT");
    apply({ kind: "restore", projectId: project.id });
    expect(settings.current).toMatchObject({ registryRevision: revision + 1, settingsRevision: ordinaryRevision });
    expect(settings.current.projects[0]).toMatchObject({ id: project.id, projectRef: project.projectRef,
      projectRevision: project.projectRevision + 2 });
    expect(settings.recoverableProjects).toEqual([]);
    expect(settings.resolveProject({ name: project.name, projectRef: project.projectRef,
      projectRevision: settings.current.projects[0]!.projectRevision }).id).toBe(project.id);
    expect(state.getActivityProjectAdmission(retainedActivity.activityId)?.projectId).toBe(project.id);
    expect(state.listSessions()).toContainEqual(expect.objectContaining({
      threadId: retainedThread.threadId, projectId: project.id
    }));
    expect(state.getAgentForThread(retainedThread.threadId)?.agentId).toBe(retainedThread.agent.agentId);
    const database = new Database(file, { readonly: true });
    try {
      expect(database.prepare("SELECT activity_id FROM jobs WHERE job_id = ?").get(jobId))
        .toEqual({ activity_id: retainedActivity.activityId });
    } finally { database.close(); }
    state.close();
    state = new BridgeStateStore({ file });
    settings = new UserSettingsStore(loadConfig({ CODEX_MCP_BRIDGE_NO_AUTH: "1" }), { stateStore: state });
    expect(settings.current.projects[0]).toMatchObject({ id: project.id, projectRef: project.projectRef });
    expect(() => apply({ kind: "archive", projectId: project.id }, { kind: "delete", projectId: project.id }))
      .toThrow("PROJECT_OPERATION_CONFLICT");
  });

  it("checks active name conflicts and rolls back failed recovery", () => {
    const project = register();
    activity(project);
    tombstoneProjectForTest(file, project.id);
    register(project.name, "replacement");
    const revision = settings.current.registryRevision;
    expect(() => apply({ kind: "restore", projectId: project.id })).toThrow("PROJECT_NAME_CONFLICT");
    expect(settings.current.registryRevision).toBe(revision);
    expect(settings.recoverableProjects[0]!.id).toBe(project.id);
    apply({ kind: "restore", projectId: project.id, name: "Recovered" });
    expect(settings.current.projects.find(entry => entry.id === project.id)?.name).toBe("Recovered");
  });

  it("allows cwd reuse after all resumable context is finished, but checks active cwd conflicts on recovery", () => {
    const project = register();
    const retained = activity(project);
    state.completeActivity(retained.activityId, undefined, 2);
    apply({ kind: "archive", projectId: project.id });
    apply({ kind: "delete", projectId: project.id });
    apply({ kind: "add", project: { name: "Replacement", cwd: project.cwd } });
    const replacement = settings.current.projects[0]!;
    expect(replacement.id).not.toBe(project.id);
    expect(settings.recoverableProjects).toEqual([]);
    expect(() => apply({ kind: "restore", projectId: project.id })).toThrow("PROJECT_CWD_CONFLICT");
    expect(state.getActivityProjectAdmission(retained.activityId)?.projectId).toBe(project.id);
    expect(() => apply({ kind: "rename", projectId: project.id, name: "Hidden" })).toThrow("PROJECT_NOT_FOUND");
  });

  it("also protects the old identity after its registered folder was relocated", () => {
    const project = register();
    activity(project);
    const destination = path.join(directory, "moved");
    mkdirSync(destination);
    apply({ kind: "relocate", projectId: project.id, cwd: destination });
    apply({ kind: "archive", projectId: project.id });
    expect(() => apply({ kind: "delete", projectId: project.id })).toThrow("PROJECT_DELETE_STILL_PINNED");
    apply({ kind: "restore", projectId: project.id, cwd: project.cwd });
    expect(settings.current.projects[0]!.cwd).toBe(project.cwd);
  });
});
