import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type {
  CodexModelCatalogProvider,
  CodexModelCatalogSnapshot
} from "../src/modelCatalog.js";
import { createBridgeMcpServer } from "../src/server.js";
import { SessionRegistry } from "../src/sessionRegistry.js";
import { BridgeStateStore } from "../src/stateStore.js";
import { CodexJobRegistry } from "../src/tools.js";
import type { CodexUpstream, ToolResult } from "../src/upstream.js";
import { UserSettingsStore } from "../src/userSettings.js";

const SCOPE_ID = "43434343-4343-4343-8343-434343434343";

class CountingUpstream implements CodexUpstream {
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];

  async listTools(): Promise<unknown> {
    return { tools: [{ name: "codex" }, { name: "codex-reply" }] };
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    this.calls.push({ name, args });
    const threadId = this.calls.length === 1
      ? "thread-current-v7"
      : `thread-current-v7-${this.calls.length}`;
    return {
      structuredContent: { threadId, content: "done" },
      content: [{
        type: "text",
        text: JSON.stringify({ threadId, content: "done" })
      }]
    };
  }

  async close(): Promise<void> {}
}

class StaticModelCatalog implements CodexModelCatalogProvider {
  private snapshot(cached: boolean): CodexModelCatalogSnapshot {
    return {
      source: "codex-cli",
      fetchedAt: "2026-08-31T00:00:00.000Z",
      validatedAt: "2026-08-31T00:00:00.000Z",
      fingerprint: "f".repeat(64),
      cached,
      stale: false,
      validation: "valid",
      models: [{
        id: "gpt-5.6-sol",
        displayName: "GPT-5.6 Sol",
        description: "Test model.",
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [{ effort: "medium", description: "Test effort." }],
        isDefault: true,
        serviceTiers: [],
        inputModalities: ["text"],
        supportedInApi: true
      }]
    };
  }

  async getCatalog(): Promise<CodexModelCatalogSnapshot> {
    return this.snapshot(false);
  }

  getCachedCatalog(): CodexModelCatalogSnapshot {
    return this.snapshot(true);
  }
}

describe("current project-selector replay", () => {
  it("replays the same persisted stable-v7 task after restart, rename, archive, and name reuse", async () => {
    const originalCwd = mkdtempSync(path.join(tmpdir(), "bridge-v7-project-original-"));
    const replacementCwd = mkdtempSync(path.join(tmpdir(), "bridge-v7-project-replacement-"));
    const stateDirectory = mkdtempSync(path.join(tmpdir(), "bridge-v7-replay-state-"));
    const stateFile = path.join(stateDirectory, "state.sqlite");
    const config = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ROOTS: `${originalCwd},${replacementCwd}`
    });
    const upstream = new CountingUpstream();
    const modelCatalog = new StaticModelCatalog();

    const firstState = new BridgeStateStore({ file: stateFile });
    const firstSettings = new UserSettingsStore(config, { stateStore: firstState });
    firstSettings.updateWithProjectOperations(
      {},
      [{ kind: "add", project: { name: "Selected Project", cwd: originalCwd } }],
      undefined,
      0
    );
    const selectedProject = firstSettings.current.projects[0]!;
    const originalSelector = {
      name: selectedProject.name,
      projectRef: selectedProject.projectRef,
      projectRevision: selectedProject.projectRevision
    };
    const firstJobs = jobRegistry(config, firstState);
    const firstConnection = await connect(
      config,
      upstream,
      modelCatalog,
      firstSettings,
      firstJobs,
      new SessionRegistry({ allowedRoots: config.allowedRoots, stateStore: firstState })
    );
    const taskDescriptor = (await firstConnection.client.listTools()).tools.find(
      (tool) => tool.name === "codex_task"
    )!;
    const executionEnvelopeRef = (
      taskDescriptor.inputSchema.properties?.executionEnvelopeRef as { const?: string } | undefined
    )?.const;
    expect(executionEnvelopeRef).toMatch(/^[0-9a-f]{64}$/);
    const request = {
      scopeId: SCOPE_ID,
      requestId: "44444444-4444-4444-8444-444444444444",
      taskContractVersion: "2",
      executionEnvelopeRef,
      prompt: "prove exact current selector replay",
      project: originalSelector,
      activity: { mode: "new" as const, title: "Current v7 replay Activity" },
      agent: { mode: "new" as const, name: "Current v7 replay Agent" },
      executionMode: "foreground" as const
    };

    const admitted = parseTask(await firstConnection.client.callTool({
      name: "codex_task",
      arguments: request
    }));
    expect(admitted).toMatchObject({
      replay: false,
      state: "completed",
      threadId: "thread-current-v7",
      projectName: "Selected Project"
    });
    expect(firstJobs.get(admitted.jobId as string)).toMatchObject({
      requestHashVersion: 7,
      projectId: selectedProject.id,
      projectRequest: originalSelector
    });
    expect(upstream.calls).toHaveLength(1);
    await firstConnection.close();
    firstState.close();

    const restartedState = new BridgeStateStore({ file: stateFile });
    const restartedSettings = new UserSettingsStore(config, { stateStore: restartedState });
    const persistedOriginal = restartedSettings.current.projects.find(
      (project) => project.id === selectedProject.id
    )!;
    restartedSettings.updateWithProjectOperations(
      {},
      [{ kind: "rename", projectId: persistedOriginal.id, name: "Renamed Original" }],
      undefined,
      restartedSettings.current.registryRevision
    );
    restartedSettings.updateWithProjectOperations(
      {},
      [
        { kind: "archive", projectId: persistedOriginal.id },
        { kind: "add", project: { name: "Selected Project", cwd: replacementCwd } }
      ],
      undefined,
      restartedSettings.current.registryRevision
    );
    const reusedNameProject = restartedSettings.current.projects.find(
      (project) => project.name === originalSelector.name && project.archivedAt === undefined
    )!;
    expect(reusedNameProject.projectRef).not.toBe(originalSelector.projectRef);
    expect(restartedSettings.current.projects.find(
      (project) => project.id === selectedProject.id
    )).toMatchObject({
      name: "Renamed Original",
      archivedAt: expect.any(Number)
    });

    const restartedJobs = jobRegistry(config, restartedState);
    const restartedSessions = new SessionRegistry({
      allowedRoots: config.allowedRoots,
      stateStore: restartedState
    });
    const restartedConnection = await connect(
      config,
      upstream,
      modelCatalog,
      restartedSettings,
      restartedJobs,
      restartedSessions
    );
    const replayed = parseTask(await restartedConnection.client.callTool({
      name: "codex_task",
      arguments: request
    }));

    expect(replayed).toMatchObject({
      replay: true,
      state: "completed",
      jobId: admitted.jobId,
      activityId: admitted.activityId,
      agentId: admitted.agentId,
      threadId: admitted.threadId,
      projectName: "Selected Project"
    });
    expect(restartedJobs.listForScope(SCOPE_ID)).toHaveLength(1);
    expect(restartedJobs.activityCount(SCOPE_ID)).toBe(1);
    expect(restartedJobs.agentCount(SCOPE_ID, true)).toBe(1);
    expect(restartedSessions.listForScope(SCOPE_ID)).toEqual([
      expect.objectContaining({
        threadId: admitted.threadId,
        projectId: selectedProject.id,
        projectLabel: "Selected Project"
      })
    ]);
    expect(upstream.calls).toHaveLength(1);

    await restartedConnection.close();
    restartedState.close();
  });

  it("uses one cached v2 descriptor after settings and project changes in the same conversation", async () => {
    const firstCwd = mkdtempSync(path.join(tmpdir(), "bridge-v2-stable-first-"));
    const secondCwd = mkdtempSync(path.join(tmpdir(), "bridge-v2-stable-second-"));
    const config = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ROOTS: `${firstCwd},${secondCwd}`,
      CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS: "1"
    });
    const state = new BridgeStateStore({ file: ":memory:" });
    const settings = new UserSettingsStore(config, { stateStore: state });
    settings.updateWithProjectOperations(
      {},
      [{ kind: "add", project: { name: "First Project", cwd: firstCwd } }],
      undefined,
      0
    );
    const firstProject = settings.current.projects[0]!;
    const firstSelector = {
      name: firstProject.name,
      projectRef: firstProject.projectRef,
      projectRevision: firstProject.projectRevision
    };
    const upstream = new CountingUpstream();
    const jobs = jobRegistry(config, state);
    const connection = await connect(
      config,
      upstream,
      new StaticModelCatalog(),
      settings,
      jobs,
      new SessionRegistry({ allowedRoots: config.allowedRoots, stateStore: state })
    );
    let listChanged = 0;
    connection.client.setNotificationHandler(
      ToolListChangedNotificationSchema,
      () => { listChanged += 1; }
    );

    const descriptor = (await connection.client.listTools()).tools.find(
      (tool) => tool.name === "codex_task"
    )!;
    const taskContractVersion = (
      descriptor.inputSchema.properties?.taskContractVersion as { const?: string }
    ).const!;
    const executionEnvelopeRef = (
      descriptor.inputSchema.properties?.executionEnvelopeRef as { const?: string }
    ).const!;
    const originalRequest = {
      scopeId: SCOPE_ID,
      requestId: "45454545-4545-4545-8545-454545454545",
      taskContractVersion,
      executionEnvelopeRef,
      prompt: "run under the original saved settings",
      project: firstSelector,
      activity: { mode: "new" as const, title: "Stable contract original" },
      agent: { mode: "new" as const, name: "Stable contract original Agent" },
      executionMode: "foreground" as const
    };
    const original = parseTask(await connection.client.callTool({
      name: "codex_task",
      arguments: originalRequest
    }));
    expect(original).toMatchObject({
      replay: false,
      state: "completed",
      sandbox: "read-only",
      projectName: "First Project"
    });

    const saved = await connection.client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedSettingsRevision: 0,
        expectedRegistryRevision: 1,
        operation: {
          kind: "patch",
          settings: {
            accessStrategy: "always-full",
            showBridgeThreadsInCodexApp: true,
            modelPolicy: {
              mode: "fixed",
              selection: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
              constraints: { allowDelegation: true }
            },
            projectOperations: [
              { kind: "add", project: { name: "Second Project", cwd: secondCwd } }
            ]
          }
        }
      }
    });
    if (saved.isError) throw new Error(`Settings update failed: ${JSON.stringify(saved)}`);
    expect(saved.isError).not.toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(listChanged).toBe(0);
    const descriptorAfterSave = (await connection.client.listTools()).tools.find(
      (tool) => tool.name === "codex_task"
    )!;
    expect(descriptorAfterSave).toEqual(descriptor);

    const lookup = await connection.client.callTool({
      name: "codex_task",
      arguments: {
        scopeId: SCOPE_ID,
        requestId: "46464646-4646-4646-8646-464646464646",
        taskContractVersion,
        executionEnvelopeRef,
        prompt: "resolve the newly added project without admitting work",
        projectLookup: { name: "Second Project" }
      }
    });
    expect(lookup).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: "PROJECT_SELECTION_REQUIRED", retryable: true }
      }
    });
    const secondProject = settings.current.projects.find(
      (project) => project.name === "Second Project"
    )!;
    const secondSelector = {
      name: secondProject.name,
      projectRef: secondProject.projectRef,
      projectRevision: secondProject.projectRevision
    };
    const lookupAction = (parseTask(lookup).nextActions as string[])[0]!;
    expect(lookupAction).toContain(JSON.stringify(secondSelector));
    expect(upstream.calls).toHaveLength(1);

    const current = parseTask(await connection.client.callTool({
      name: "codex_task",
      arguments: {
        scopeId: SCOPE_ID,
        requestId: "47474747-4747-4747-8747-474747474747",
        taskContractVersion,
        executionEnvelopeRef,
        prompt: "run with the current settings and newly added project",
        project: secondSelector,
        activity: { mode: "new", title: "Stable contract current" },
        agent: { mode: "new", name: "Stable contract current Agent" },
        executionMode: "foreground"
      }
    }));
    expect(current).toMatchObject({
      replay: false,
      state: "completed",
      sandbox: "danger-full-access",
      actualModel: "gpt-5.6-sol",
      actualReasoningEffort: "medium",
      projectName: "Second Project"
    });
    expect(upstream.calls[1]).toMatchObject({
      name: "codex",
      args: {
        cwd: secondProject.cwd,
        sandbox: "danger-full-access",
        model: "gpt-5.6-sol"
      }
    });

    const replay = parseTask(await connection.client.callTool({
      name: "codex_task",
      arguments: originalRequest
    }));
    expect(replay).toMatchObject({
      replay: true,
      jobId: original.jobId,
      sandbox: "read-only",
      projectName: "First Project"
    });
    expect(upstream.calls).toHaveLength(2);
    expect(jobs.listForScope(SCOPE_ID)).toHaveLength(2);

    await connection.close();
    state.close();
  });
});

function jobRegistry(
  config: ReturnType<typeof loadConfig>,
  stateStore: BridgeStateStore
): CodexJobRegistry {
  return new CodexJobRegistry({
    maxConcurrentJobs: config.maxConcurrentJobs,
    ttlMs: config.jobTtlMs,
    maxJobs: config.maxRetainedJobs,
    maxResultBytes: config.maxJobResultBytes,
    staleAfterMs: config.jobStaleAfterMs,
    allowedRoots: config.allowedRoots,
    stateStore
  });
}

async function connect(
  config: ReturnType<typeof loadConfig>,
  upstream: CodexUpstream,
  modelCatalog: CodexModelCatalogProvider,
  settings: UserSettingsStore,
  jobs: CodexJobRegistry,
  sessions: SessionRegistry
): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createBridgeMcpServer(
    config,
    upstream,
    sessions,
    jobs,
    modelCatalog,
    settings
  );
  const client = new Client({ name: "current-selector-replay-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    }
  };
}

function parseTask(result: unknown): Record<string, unknown> {
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) {
    throw new Error(`Task result omitted structuredContent: ${JSON.stringify(result)}`);
  }
  return structured as Record<string, unknown>;
}
