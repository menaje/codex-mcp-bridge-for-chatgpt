import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createHttpServer, type BridgeHttpServer } from "../src/server.js";
import { BridgeStateStore } from "../src/stateStore.js";
import { ChildProcessStateReadService } from "../src/stateReadProcess.js";
import { UserSettingsStore } from "../src/userSettings.js";
import type {
  ProjectTarget,
  ProjectRegistryOperation,
} from "../src/projectRegistry.js";
import type { CodexModelCatalogProvider } from "../src/modelCatalog.js";
import type {
  CodexProgress,
  CodexUpstream,
  ToolResult,
  UpstreamWorkerAssignment,
} from "../src/upstream.js";

const scopeId = "11111111-1111-4111-8111-111111111111";
const selection = { model: "gpt-5.6-sol", reasoningEffort: "medium" };
const catalog: CodexModelCatalogProvider = {
  async getCatalog() {
    return {
      source: "codex-cli",
      fetchedAt: "2026-10-07T00:00:00Z",
      validatedAt: "2026-10-07T00:00:00Z",
      fingerprint: "a".repeat(64),
      cached: false,
      stale: false,
      validation: "valid",
      models: [
        {
          id: selection.model,
          displayName: "Synthetic fixture",
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [{ effort: "medium" }],
          isDefault: true,
          serviceTiers: [],
          inputModalities: ["text"],
        },
      ],
    };
  },
};

// Real HTTP/MCP and application Settings paths; execution is synthetic, with
// explicit worker/turn identities and controlled late callbacks. No model/auth,
// operational DB, installed app or original conversation is accessed.
describe("project retirement through the host boundary (#240)", () => {
  let root: string,
    cwd: string,
    file: string,
    state: BridgeStateStore,
    settings: UserSettingsStore;
  let server: BridgeHttpServer,
    client: Client,
    contract: Record<string, { const?: unknown }>;
  let calls: number, failStop: boolean;
  let reader: ChildProcessStateReadService | undefined;
  const held = new Map<
    string,
    {
      assignment: UpstreamWorkerAssignment;
      progress: (p: CodexProgress) => void;
      finish: (r: ToolResult) => void;
    }
  >();
  const stops: Array<{
    assignment: UpstreamWorkerAssignment;
    options: unknown;
  }> = [];

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "issue240-host-")));
    cwd = path.join(root, "project");
    mkdirSync(cwd);
    file = path.join(root, "state.sqlite");
    state = new BridgeStateStore({ file });
    const config = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ROOTS: root,
      CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: file,
      CODEX_MCP_BRIDGE_RUNTIME_HOME: path.join(root, "runtime"),
      CODEX_MCP_BRIDGE_SKILLS_DIRECTORY: path.join(root, "skills"),
      CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE: path.join(root, "models.json"),
    });
    settings = new UserSettingsStore(config, { stateStore: state });
    settings.update(
      {
        modelPolicy: {
          mode: "automatic",
          constraints: { allowDelegation: false },
          allowedSelections: { kind: "explicit", selections: [selection] },
        },
      },
      settings.current.revision,
    );
    calls = 0;
    failStop = false;
    reader = undefined;
    held.clear();
    stops.length = 0;
    const upstream = {
      async listTools() {
        return { tools: [{ name: "codex" }] };
      },
      async callTool(
        _name: string,
        args: Record<string, unknown>,
        progress: (p: CodexProgress) => void,
        assigned: (a: UpstreamWorkerAssignment) => void,
      ): Promise<ToolResult> {
        calls++;
        const threadId = randomUUID();
        const assignment: UpstreamWorkerAssignment = {
          backendKind: "app-server",
          workerId: "shared-synthetic-worker",
          workerGeneration: 1,
          threadId,
          upstreamRequestId: randomUUID(),
        };
        assigned(assignment);
        if (String(args.prompt).startsWith("hold"))
          return new Promise((resolve) => {
            held.set(String(args.prompt), {
              assignment,
              progress,
              finish: resolve,
            });
          });
        return result(threadId);
      },
      ownsActiveExecution: () => true,
      async forceTerminateWorker(
        assignment: UpstreamWorkerAssignment,
        _correlation: unknown,
        _grace: unknown,
        options: unknown,
      ) {
        stops.push({ assignment, options });
        if (failStop)
          throw new Error("Synthetic exact turn stop is unconfirmed");
        return {
          exited: true,
          workerExited: false,
          escalated: false,
          mode: "turn-interrupt",
        };
      },
      async releaseThreadConnection() {
        return { phase: "released", evidence: "thread-unloaded" };
      },
      async listLoadedBackgroundTerminals() {
        return [];
      },
      async close() {
        for (const value of held.values())
          value.finish(result(value.assignment.threadId!));
      },
    } as unknown as CodexUpstream;
    server = createHttpServer(config, upstream, catalog, { stateStore: state });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    client = new Client(
      { name: "issue240-isolated-host", version: "1" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(
          `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`,
        ),
      ),
    );
    contract = (await client.listTools()).tools.find(
      (tool) => tool.name === "codex_task",
    )!.inputSchema.properties as typeof contract;
  });
  afterEach(async () => {
    await reader?.close();
    for (const value of held.values())
      value.finish(result(value.assignment.threadId!));
    await client?.close();
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    state?.close();
    if (root) rmSync(root, { recursive: true });
  });
  const result = (threadId: string): ToolResult => ({
    content: [{ type: "text", text: "Synthetic completion" }],
    structuredContent: { threadId, content: "Synthetic completion" },
  });
  async function eventually(predicate: () => boolean) {
    const end = Date.now() + 5_000;
    while (!predicate()) {
      if (Date.now() >= end) throw new Error("Fixture state did not settle");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  async function mutate(operation: ProjectRegistryOperation) {
    const snapshot = await server.applicationService.settingsSnapshot();
    return server.applicationService.updateSettings({
      expectedSettingsRevision: snapshot.settings.settingsRevision,
      expectedRegistryRevision: snapshot.settings.registryRevision,
      operation: {
        kind: "patch",
        settings: { projectOperations: [operation] },
      },
    });
  }
  async function register(
    name = "Fixture",
    directory = cwd,
  ): Promise<ProjectTarget> {
    await mutate({ kind: "add", project: { name, cwd: directory } });
    return settings.current.projects.find((p) => p.name === name)!;
  }
  function args(project: ProjectTarget, prompt = "complete") {
    return {
      scopeId,
      requestId: randomUUID(),
      prompt,
      selection,
      taskContractVersion: contract.taskContractVersion!.const,
      executionEnvelopeRef: contract.executionEnvelopeRef!.const,
      project: {
        name: project.name,
        projectRef: project.projectRef,
        projectRevision: project.projectRevision,
      },
    };
  }
  async function admit(input: ReturnType<typeof args>) {
    const response = await client.callTool({
      name: "codex_task",
      arguments: input,
    });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    return response.structuredContent as {
      jobId: string;
      agentId: string;
      activityId: string;
    };
  }
  async function archive(project: ProjectTarget) {
    await mutate({ kind: "archive", projectId: project.id });
    await eventually(
      () =>
        settings.current.projects.find((p) => p.id === project.id)
          ?.archiveState === (failStop ? "unresolved" : "complete"),
    );
  }
  function checkDb() {
    const db = new Database(file, { readonly: true });
    try {
      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    } finally {
      db.close();
    }
  }

  it("repeats full HTTP admission/use/delete cycles with fresh identities and preserves real Git/files/conversation evidence", async () => {
    reader = await ChildProcessStateReadService.start(file, {
      ...process.env,
      HOME: root,
      CODEX_HOME: path.join(root, "codex"),
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ROOTS: root,
      CODEX_MCP_BRIDGE_CODEX: "/usr/bin/false",
      CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: file,
      CODEX_MCP_BRIDGE_RUNTIME_HOME: path.join(root, "runtime"),
      CODEX_MCP_BRIDGE_SKILLS_DIRECTORY: path.join(root, "skills"),
      CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE: path.join(root, "models.json"),
    });
    const git = (...a: string[]) =>
      execFileSync("git", a, { cwd, encoding: "utf8" });
    writeFileSync(path.join(cwd, "tracked.txt"), "original");
    git("init", "--quiet");
    git("add", "tracked.txt");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    );
    writeFileSync(path.join(cwd, "tracked.txt"), "user staged edit");
    git("add", "tracked.txt");
    writeFileSync(path.join(cwd, "untracked.txt"), "user evidence");
    const conversation = path.join(root, "original-conversation.json");
    writeFileSync(conversation, '{"original":true}');
    const head = git("rev-parse", "HEAD"),
      status = git("status", "--porcelain=v1"),
      index = readFileSync(path.join(cwd, ".git/index"));
    const identities = new Set<string>(),
      threads = new Set<string>();
    for (let cycle = 0; cycle < 2; cycle++)
      for (let use = 0; use < 2; use++) {
        const project = await register();
        expect(identities.has(project.id)).toBe(false);
        identities.add(project.id);
        expect(
          (await reader.settingsSnapshot()).settings.projects.map((p) => p.id),
        ).toEqual([project.id]);
        const input = args(project),
          job = await admit(input);
        await eventually(() =>
          state
            .listJobs()
            .some((j) => j.jobId === job.jobId && j.status === "completed"),
        );
        const thread = state.currentAgentThread(job.agentId)!;
        expect(threads.has(thread.threadId)).toBe(false);
        threads.add(thread.threadId);
        await archive(project);
        expect(
          (await reader.settingsSnapshot()).settings.projects[0]?.archiveState,
        ).toBe("complete");
        expect(state.currentAgentThread(job.agentId)).toBeUndefined();
        await mutate({ kind: "delete", projectId: project.id });
        expect(state.getActivity(job.activityId)).toBeUndefined();
        expect(state.listSessions()).toEqual([]);
        expect(state.threadConnections.get(thread.threadId)).toBeUndefined();
        expect(state.listJobs()).toEqual([]);
        expect(settings.current.projects).toEqual([]);
        expect((await reader.settingsSnapshot()).settings.projects).toEqual([]);
        const dashboard = await reader.dashboardSnapshot({
          inspectRuntime: false,
        });
        expect([...dashboard.activeRows, ...dashboard.terminalRows]).toEqual(
          [],
        );
        // Agent identity is reusable and may be shared. Its idle row must no
        // longer project the deleted registration, context or execution.
        for (const row of dashboard.idleRows) {
          expect(row).toMatchObject({
            projectName: null,
            activityTitle: null,
            latestTurn: null,
            history: [],
            historyCount: 0,
          });
          expect(row.codexThreadUrl).toBeUndefined();
        }
        const previousCalls = calls;
        const retry = await client.callTool({
          name: "codex_task",
          arguments: input,
        });
        expect(JSON.stringify(retry)).toContain("PROJECT_MANAGEMENT_ENDED");
        expect(calls).toBe(previousCalls);
        const oldStatus = await client.callTool({
          name: "codex_status",
          arguments: { scopeId, query: { kind: "job", id: job.jobId } },
        });
        expect(JSON.stringify(oldStatus)).toContain("PROJECT_MANAGEMENT_ENDED");
        expect(
          state.projectLifecycle.jobReceipt(job.jobId)?.request_hash,
        ).toMatch(/^[a-f0-9]{64}$/);
        checkDb();
      }
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(git("status", "--porcelain=v1")).toBe(status);
    expect(readFileSync(path.join(cwd, ".git/index"))).toEqual(index);
    expect(readFileSync(path.join(cwd, "tracked.txt"), "utf8")).toBe(
      "user staged edit",
    );
    expect(readFileSync(path.join(cwd, "untracked.txt"), "utf8")).toBe(
      "user evidence",
    );
    expect(readFileSync(conversation, "utf8")).toBe('{"original":true}');
  }, 20_000);

  it("blocks fresh/continue/fork during failed cleanup and preserves a shared worker peer across delete and late callbacks", async () => {
    const project = await register(),
      otherCwd = path.join(root, "other");
    mkdirSync(otherCwd);
    const other = await register("Other", otherCwd);
    const target = await admit(args(project, "hold target")),
      peer = await admit(args(other, "hold peer"));
    await eventually(() => held.size === 2);
    failStop = true;
    await archive(project);
    // Reproduce a concurrent stored current-thread replacement on the shared
    // Agent while the old exact turn is still awaiting confirmed termination.
    const sharedAgentThread = randomUUID();
    state.linkAgentThread({
      agentId: target.agentId,
      threadId: sharedAgentThread,
      projectId: other.id,
      projectName: other.name,
      cwd: other.cwd,
      backendKind: "app-server",
      sandbox: "read-only",
      contextMode: "fresh",
    });
    const previousCalls = calls;
    for (const context of ["fresh", "continue", "fork"]) {
      const response = await client.callTool({
        name: "codex_task",
        arguments: {
          ...args(project),
          activity: { mode: "existing", id: target.activityId },
          agent: { mode: "existing", id: target.agentId, context },
        },
      });
      expect(response.isError).toBe(true);
    }
    expect(calls).toBe(previousCalls);
    await expect(
      mutate({ kind: "delete", projectId: project.id }),
    ).rejects.toThrow("PROJECT_DELETE_REQUIRES_ARCHIVE");
    failStop = false;
    await archive(project);
    await mutate({ kind: "delete", projectId: project.id });
    const replacement = await register("Replacement");
    expect(replacement.id).not.toBe(project.id);
    held
      .get("hold target")!
      .progress({ message: "late progress" } as CodexProgress);
    held
      .get("hold target")!
      .finish(result(held.get("hold target")!.assignment.threadId!));
    await new Promise((resolve) => setImmediate(resolve));
    expect(state.listJobs().some((j) => j.jobId === target.jobId)).toBe(false);
    expect(
      state.listSessions().some((s: any) => s.projectId === replacement.id),
    ).toBe(false);
    expect(state.listJobs().find((j) => j.jobId === peer.jobId)?.status).toBe(
      "running",
    );
    expect(
      stops.every(
        (s) =>
          (s.options as { interruptOnly?: boolean }).interruptOnly === true,
      ),
    ).toBe(true);
    const peerThread = held.get("hold peer")!.assignment.threadId!;
    held.get("hold peer")!.finish(result(peerThread));
    await eventually(
      () =>
        state.listJobs().find((j) => j.jobId === peer.jobId)?.status ===
        "completed",
    );
    await archive(replacement);
    await mutate({ kind: "delete", projectId: replacement.id });
    expect(state.currentAgentThread(target.agentId)?.threadId).toBe(
      sharedAgentThread,
    );
    checkDb();
  }, 20_000);

  it("replays a lost delete response through Settings and MCP without deleting a new same-cwd identity or bypassing other CAS checks", async () => {
    const project = await register();
    await archive(project);
    const snapshot = await server.applicationService.settingsSnapshot();
    const deletion = {
      expectedRegistryRevision: snapshot.settings.registryRevision,
      operation: {
        kind: "patch" as const,
        settings: {
          projectOperations: [
            { kind: "delete" as const, projectId: project.id },
          ],
        },
      },
    };
    await server.applicationService.updateSettings(deletion);
    // Response loss retains this exact old registry revision on the caller.
    await server.applicationService.updateSettings(deletion);
    expect(settings.current.projects).toEqual([]);
    const replacement = await register();
    expect(replacement.id).not.toBe(project.id);
    const revision = settings.current.registryRevision;
    const locale = settings.current.uiLocalePreference;
    await server.applicationService.updateSettings(deletion);
    const replay = await client.callTool({
      name: "codex_update_settings",
      arguments: deletion,
    });
    expect(replay.isError, JSON.stringify(replay)).not.toBe(true);
    expect(settings.current.projects.map((p) => p.id)).toEqual([
      replacement.id,
    ]);
    expect(settings.current.registryRevision).toBe(revision);
    await expect(
      server.applicationService.updateSettings({
        ...deletion,
        expectedSettingsRevision: settings.current.settingsRevision,
        operation: {
          kind: "patch",
          settings: {
            ...deletion.operation.settings,
            uiLocalePreference: "ko",
          },
        },
      }),
    ).rejects.toThrow("PROJECT_REGISTRY_REVISION_CONFLICT");
    await expect(
      server.applicationService.updateSettings({
        ...deletion,
        operation: {
          kind: "patch",
          settings: {
            projectOperations: [
              ...deletion.operation.settings.projectOperations,
              { kind: "delete", projectId: replacement.id },
            ],
          },
        },
      }),
    ).rejects.toThrow("PROJECT_REGISTRY_REVISION_CONFLICT");
    expect(settings.current.uiLocalePreference).toBe(locale);
    expect(settings.current.projects.map((p) => p.id)).toEqual([
      replacement.id,
    ]);
    expect(settings.current.registryRevision).toBe(revision);
    expect(calls).toBe(0);
    checkDb();
  });
});
