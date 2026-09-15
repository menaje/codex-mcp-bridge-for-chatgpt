import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { loadConfig } from "../src/config.js";
import type { CodexModelCatalogProvider, CodexModelCatalogSnapshot } from "../src/modelCatalog.js";
import { createHttpServer } from "../src/server.js";
import { BridgeStateStore } from "../src/stateStore.js";
import type { CodexUpstream, ToolResult } from "../src/upstream.js";
import { UserSettingsStore } from "../src/userSettings.js";

const SCOPE_ID = "43434343-4343-4343-8343-434343434343";

class CountingUpstream implements CodexUpstream {
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];

  async listTools(): Promise<unknown> {
    return { tools: [{ name: "codex" }] };
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    this.calls.push({ name, args });
    return {
      structuredContent: { threadId: "thread-current-v3", content: "done" },
      content: [{ type: "text", text: "done" }]
    };
  }

  async close(): Promise<void> {}
}

class StaticModelCatalog implements CodexModelCatalogProvider {
  private readonly snapshot: CodexModelCatalogSnapshot = {
    source: "codex-cli",
    fetchedAt: "2026-09-14T00:00:00.000Z",
    validatedAt: "2026-09-14T00:00:00.000Z",
    fingerprint: "f".repeat(64),
    cached: true,
    stale: false,
    validation: "valid",
    models: [{
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ effort: "medium" }],
      isDefault: true,
      serviceTiers: [],
      inputModalities: ["text"]
    }]
  };

  async getCatalog(): Promise<CodexModelCatalogSnapshot> {
    return this.snapshot;
  }

  getCachedCatalog(): CodexModelCatalogSnapshot {
    return this.snapshot;
  }
}

function currentClient(): Client {
  return new Client(
    { name: "current-selector-replay-test", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } }
  );
}

async function connect(
  config: ReturnType<typeof loadConfig>,
  upstream: CodexUpstream,
  catalog: CodexModelCatalogProvider,
  stateStore: BridgeStateStore
): Promise<{ client: Client; close(): Promise<void> }> {
  const server = createHttpServer(config, upstream, catalog, { stateStore });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const client = currentClient();
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return {
    client,
    async close(): Promise<void> {
      await client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

describe("current task selector contract", () => {
  it("preserves the admitted v4 record but rejects a stale project selector after restart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "task-v3-replay-"));
    const originalCwd = path.join(root, "original");
    const replacementCwd = path.join(root, "replacement");
    await (await import("node:fs/promises")).mkdir(originalCwd);
    await (await import("node:fs/promises")).mkdir(replacementCwd);
    const stateFile = path.join(root, "state.sqlite");
    const config = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ROOTS: `${originalCwd},${replacementCwd}`,
      CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: stateFile,
      CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE: path.join(root, "models.json")
    });
    const upstream = new CountingUpstream();
    const catalog = new StaticModelCatalog();

    const initialStore = new BridgeStateStore({ file: stateFile });
    const initialSettings = new UserSettingsStore(config, { stateStore: initialStore });
    initialSettings.updateWithProjectOperations(
      {},
      [{ kind: "add", project: { name: "Selected Project", cwd: originalCwd } }],
      undefined,
      0
    );
    const selected = initialSettings.current.projects[0]!;
    const connection = await connect(
      config,
      upstream,
      catalog,
      initialStore
    );
    const descriptor = (await connection.client.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    const input = descriptor.inputSchema.properties as Record<string, { const?: string }>;
    const request = {
      scopeId: SCOPE_ID,
      requestId: "44444444-4444-4444-8444-444444444444",
      taskContractVersion: input.taskContractVersion?.const,
      executionEnvelopeRef: input.executionEnvelopeRef?.const,
      prompt: "prove exact current selector replay",
      selection: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
      project: {
        name: selected.name,
        projectRef: selected.projectRef,
        projectRevision: selected.projectRevision
      },
      activity: { mode: "new", title: "Current v5 replay" },
      agent: { mode: "new", name: "Replay Agent" },
      executionMode: "foreground"
    };
    expect(request.taskContractVersion).toBe("5");

    const admitted = await connection.client.callTool({ name: "codex_task", arguments: request });
    expect(admitted.isError).not.toBe(true);
    expect(admitted.structuredContent).toMatchObject({ replay: false, state: "completed" });
    const jobId = (admitted.structuredContent as { jobId: string }).jobId;
    await connection.close();
    initialStore.close();

    const restartedStore = new BridgeStateStore({ file: stateFile });
    const restartedSettings = new UserSettingsStore(config, { stateStore: restartedStore });
    const registered = restartedSettings.current.projects.find((project) => project.projectRef === selected.projectRef)!;
    restartedSettings.updateWithProjectOperations(
      {},
      [{ kind: "rename", projectId: registered.id, name: "Renamed Original" }],
      undefined,
      restartedSettings.current.registryRevision
    );
    restartedSettings.updateWithProjectOperations(
      {},
      [{ kind: "archive", projectId: registered.id }],
      undefined,
      restartedSettings.current.registryRevision
    );
    restartedSettings.updateWithProjectOperations(
      {},
      [{ kind: "add", project: { name: "Selected Project", cwd: replacementCwd } }],
      undefined,
      restartedSettings.current.registryRevision
    );
    const replayConnection = await connect(
      config,
      upstream,
      catalog,
      restartedStore
    );
    try {
      const replay = await replayConnection.client.callTool({ name: "codex_task", arguments: request });
      expect(replay.isError).toBe(true);
      expect(replay.structuredContent).toMatchObject({
        replay: false,
        jobId: null,
        error: { code: "PROJECT_REGISTRY_CHANGED" }
      });
      expect(jobId).toEqual(expect.any(String));
      expect(upstream.calls).toHaveLength(1);
    } finally {
      await replayConnection.close();
      restartedStore.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
