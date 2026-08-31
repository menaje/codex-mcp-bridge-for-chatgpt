import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  ReadBuffer,
  serializeMessage
} from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ToolListChangedNotificationSchema,
  type JSONRPCMessage
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type {
  CodexModelCatalogProvider,
  CodexModelCatalogSnapshot
} from "../src/modelCatalog.js";
import { createStdioBridgeRuntime } from "../src/stdioServer.js";
import { BridgeStateStore } from "../src/stateStore.js";
import type { CodexUpstream, ToolResult } from "../src/upstream.js";

describe("persistent stdio bridge", () => {
  it("keeps the stable task descriptor across saved settings changes over framed stdio bytes", async () => {
    const stateStore = new BridgeStateStore({ file: ":memory:" });
    const stateDirectory = mkdtempSync(path.join(tmpdir(), "bridge-stdio-state-"));
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    const runtime = createStdioBridgeRuntime(
      loadConfig({
        CODEX_MCP_BRIDGE_NO_AUTH: "1",
        CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: path.join(stateDirectory, "state.sqlite"),
        CODEX_MCP_BRIDGE_SETTINGS_STATE_FILE: path.join(stateDirectory, "settings.json"),
        CODEX_MCP_BRIDGE_SESSION_STATE_FILE: path.join(stateDirectory, "sessions.json"),
        CODEX_MCP_BRIDGE_JOB_STATE_FILE: path.join(stateDirectory, "jobs.json"),
        CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE: path.join(stateDirectory, "models.json")
      }),
      new FakeUpstream(),
      {
        stateStore,
        modelCatalog: new StaticModelCatalog(),
        input: clientToServer,
        output: serverToClient,
        descriptorReconcileIntervalMs: 60_000
      }
    );
    const client = new Client({ name: "stdio-integration-client", version: "0.0.0" });
    const clientTransport = new PairedStdioClientTransport(
      clientToServer,
      serverToClient
    );
    let listChanged = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      listChanged += 1;
    });

    await runtime.start();
    await client.connect(clientTransport);
    try {
      const before = (await client.listTools()).tools.find(
        (tool) => tool.name === "codex_task"
      )!;
      expect(before.inputSchema.properties).toHaveProperty("taskContractVersion");
      expect(before.inputSchema.properties).toHaveProperty("executionEnvelopeRef");
      expect(before.inputSchema.properties).toHaveProperty("selection");
      expect(before.inputSchema.properties).not.toHaveProperty("executionPolicyRef");
      expect(runtime.descriptorCoordinator.status).toMatchObject({
        bindingCount: 1,
        notificationEligibleBindingCount: 1,
        clientRelistObservationCount: 1,
        clientRelistedSessionCount: 1
      });

      const updateResult = await client.callTool({
        name: "codex_update_settings",
        arguments: {
          expectedSettingsRevision: 0,
          operation: {
            kind: "patch",
            settings: {
              modelPolicy: {
                mode: "fixed",
                selection: {
                  model: "gpt-5.6-sol",
                  reasoningEffort: "max"
                },
                constraints: { allowDelegation: true }
              }
            }
          }
        }
      });
      if (updateResult.isError) {
        throw new Error(`stdio settings update failed: ${JSON.stringify(updateResult)}`);
      }
      expect(runtime.descriptorCoordinator.status).toMatchObject({
        descriptorEpoch: 1,
        notificationAttemptCount: 0,
        clientRelistedSessionCount: 1
      });
      expect(listChanged).toBe(0);

      const after = (await client.listTools()).tools.find(
        (tool) => tool.name === "codex_task"
      )!;
      expect(after).toEqual(before);
      expect(runtime.descriptorCoordinator.status).toMatchObject({
        clientRelistObservationCount: 2,
        clientRelistedSessionCount: 1,
        lastClientRelistedEpoch: runtime.descriptorCoordinator.status.descriptorEpoch
      });

      const diagnostics = await client.callTool({
        name: "codex_diagnostics",
        arguments: {}
      });
      expect(diagnostics.structuredContent).toMatchObject({
        descriptorDiscovery: {
          notificationAttempts: 0,
          clientRelistObservations: 2,
          currentEpochRelistedSessions: 1,
          adoptionState: "unknown"
        }
      });
    } finally {
      await client.close();
      await runtime.close();
      stateStore.close();
    }
  });
});

class PairedStdioClientTransport implements Transport {
  private readonly readBuffer = new ReadBuffer();
  private started = false;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(
    private readonly output: PassThrough,
    private readonly input: PassThrough
  ) {}

  async start(): Promise<void> {
    if (this.started) throw new Error("Paired stdio client is already started.");
    this.started = true;
    this.input.on("data", this.onData);
    this.input.on("error", this.onInputError);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const serialized = serializeMessage(message);
    if (this.output.write(serialized)) return;
    await new Promise<void>((resolve) => this.output.once("drain", resolve));
  }

  async close(): Promise<void> {
    this.input.off("data", this.onData);
    this.input.off("error", this.onInputError);
    this.readBuffer.clear();
    this.onclose?.();
  }

  private readonly onData = (chunk: Buffer) => {
    this.readBuffer.append(chunk);
    while (true) {
      try {
        const message = this.readBuffer.readMessage();
        if (message === null) return;
        this.onmessage?.(message);
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  };

  private readonly onInputError = (error: Error) => this.onerror?.(error);
}

class FakeUpstream implements CodexUpstream {
  async listTools(): Promise<unknown> {
    return { tools: [] };
  }

  async callTool(_name: string, _args: Record<string, unknown>): Promise<ToolResult> {
    return {
      structuredContent: { threadId: "stdio-thread", content: "done" },
      content: [{
        type: "text",
        text: JSON.stringify({ threadId: "stdio-thread", content: "done" })
      }]
    };
  }

  async close(): Promise<void> {}
}

class StaticModelCatalog implements CodexModelCatalogProvider {
  private readonly catalog: CodexModelCatalogSnapshot = {
    source: "codex-cli",
    fetchedAt: "2026-08-31T00:00:00.000Z",
    validatedAt: "2026-08-31T00:00:00.000Z",
    fingerprint: "f".repeat(64),
    cached: true,
    stale: false,
    validation: "valid",
    models: [{
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      description: "Test model.",
      defaultReasoningEffort: "max",
      supportedReasoningEfforts: [{ effort: "max", description: "Test effort." }],
      isDefault: true,
      serviceTiers: [],
      inputModalities: ["text"],
      supportedInApi: true
    }]
  };

  async getCatalog(): Promise<CodexModelCatalogSnapshot> {
    return { ...this.catalog, cached: false };
  }

  getCachedCatalog(): CodexModelCatalogSnapshot {
    return this.catalog;
  }
}

async function eventually(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 2_000) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for persistent stdio state.");
}
