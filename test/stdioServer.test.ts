import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/client";
import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type {
  CodexModelCatalogProvider,
  CodexModelCatalogSnapshot
} from "../src/modelCatalog.js";
import { createStdioBridgeRuntime } from "../src/stdioServer.js";
import { BridgeStateStore } from "../src/stateStore.js";
import type { CodexUpstream, ToolResult } from "../src/upstream.js";
import { createSchema18Fixture } from "./helpers/stateSchemaFixtures.js";

describe("persistent stdio bridge", { timeout: 15_000 }, () => {
  it("records the rollback boundary after the migrated stdio transport connects", async () => {
    const stateDirectory = mkdtempSync(path.join(tmpdir(), "bridge-stdio-migrated-state-"));
    const file = path.join(stateDirectory, "state.sqlite");
    createSchema18Fixture(file);
    const stateStore = new BridgeStateStore({ file });
    const input = new PassThrough();
    const output = new PassThrough();
    const runtime = createStdioBridgeRuntime(
      loadConfig({
        CODEX_MCP_BRIDGE_NO_AUTH: "1",
        CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: file,
        CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE: path.join(stateDirectory, "models.json")
      }),
      new FakeUpstream(),
      {
        stateStore,
        modelCatalog: new StaticModelCatalog(),
        input,
        output
      }
    );
    expect(stateStore.getMeta("state_service_opened_after_migration")).toBe("0");
    try {
      await runtime.start();
      expect(stateStore.getMeta("state_service_opened_after_migration")).toBe("1");
      expect(stateStore.getMeta("state_service_opened_transport")).toBe("stdio");
    } finally {
      await runtime.close();
      stateStore.close();
    }
  });

  it("keeps the stable task descriptor across saved settings changes over framed stdio bytes", async () => {
    const stateStore = new BridgeStateStore({ file: ":memory:" });
    const stateDirectory = mkdtempSync(path.join(tmpdir(), "bridge-stdio-state-"));
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    const runtime = createStdioBridgeRuntime(
      loadConfig({
        CODEX_MCP_BRIDGE_NO_AUTH: "1", CODEX_MCP_BRIDGE_ENABLE_RECOVERY_TOOLS: "1",
        CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: path.join(stateDirectory, "state.sqlite"),
        CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE: path.join(stateDirectory, "models.json")
      }),
      new FakeUpstream(),
      {
        stateStore,
        modelCatalog: new StaticModelCatalog(),
        input: clientToServer,
        output: serverToClient
      }
    );
    const client = new Client(
      { name: "stdio-integration-client", version: "0.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } }
    );
    const clientTransport = new PairedStdioClientTransport(
      clientToServer,
      serverToClient
    );
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
      expect((before.inputSchema.properties?.taskContractVersion as { const?: string }).const).toBe("6");

      const models = await client.callTool({ name: "codex_models", arguments: { refresh: true } });
      expect(models.isError).not.toBe(true);
      expect(models.structuredContent).toMatchObject({ contractVersion: "2" });

      const after = (await client.listTools()).tools.find(
        (tool) => tool.name === "codex_task"
      )!;
      expect(after.inputSchema).toEqual(before.inputSchema);
    } finally {
      await client.close();
      await runtime.close();
      stateStore.close();
    }
  });
});

class PairedStdioClientTransport implements Transport {
  private buffer = "";
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
    const serialized = JSON.stringify(message) + "\n";
    if (this.output.write(serialized)) return;
    await new Promise<void>((resolve) => this.output.once("drain", resolve));
  }

  async close(): Promise<void> {
    this.input.off("data", this.onData);
    this.input.off("error", this.onInputError);
    this.buffer = "";
    this.onclose?.();
  }

  private readonly onData = (chunk: Buffer) => {
    this.buffer += chunk.toString("utf8");
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try { this.onmessage?.(JSON.parse(line) as JSONRPCMessage); }
      catch (error) { this.onerror?.(error instanceof Error ? error : new Error(String(error))); }
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
