import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { loadConfig } from "../src/config.js";
import { createHttpServer, type BridgeHttpServer } from "../src/server.js";
import { BridgeStateStore } from "../src/stateStore.js";
import type { CodexUpstream, ToolResult } from "../src/upstream.js";

const metadata = { "openai/session": "question-contract-test" };

class FixtureUpstream implements CodexUpstream {
  async listTools(): Promise<unknown> {
    return { tools: [] };
  }

  async callTool(): Promise<ToolResult> {
    return { content: [{ type: "text", text: "fixture" }] };
  }

  async close(): Promise<void> {}
}

describe("current Codex input contract", () => {
  let state: BridgeStateStore;
  let server: BridgeHttpServer;
  let client: Client;

  beforeEach(async () => {
    state = new BridgeStateStore({ file: ":memory:" });
    const config = loadConfig({ CODEX_MCP_BRIDGE_NO_AUTH: "1" });
    server = createHttpServer(
      config,
      new FixtureUpstream(),
      undefined,
      { stateStore: state }
    );
    client = new Client(
      { name: "question-contract-test", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } }
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  });

  afterEach(async () => {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    state.close();
  });

  it("uses codex_status and codex_answer while keeping questions in the host conversation", async () => {
    const names = new Set((await client.listTools()).tools.map((tool) => tool.name));
    expect(names.has("codex_status")).toBe(true);
    expect(names.has("codex_answer")).toBe(true);
    for (const retired of ["codex_ask_user", "codex_user_answer", "codex_question_action"]) {
      expect(names.has(retired)).toBe(false);
    }

    const missingInput = await client.callTool({
      name: "codex_status",
      arguments: { query: { kind: "input", jobId: "missing-job" } },
      _meta: metadata
    });
    expect(missingInput.isError).toBe(true);
    expect(JSON.stringify(missingInput)).toContain("INPUT_JOB_UNAVAILABLE");

    const missingAnswer = await client.callTool({
      name: "codex_answer",
      arguments: {
        requestId: randomUUID(),
        jobId: "missing-job",
        questionRef: "a".repeat(64),
        answers: { color: ["Blue"] }
      },
      _meta: metadata
    });
    expect(missingAnswer.isError).toBe(true);
    expect(JSON.stringify(missingAnswer)).toContain("INPUT_JOB_UNAVAILABLE");

    const questionRead = await client.callTool({
      name: "codex_ui_read",
      arguments: { view: "question", widgetInstanceId: randomUUID() },
      _meta: metadata
    });
    expect(questionRead.isError).toBe(true);
    expect(JSON.stringify(questionRead)).toMatch(/Invalid arguments|view/i);

    const resources = await client.listResources();
    expect(resources.resources.map((resource) => resource.name)).not.toContain("codex-question-card");
  });

  it("does not register retired question aliases", async () => {
    const names = new Set((await client.listTools()).tools.map((tool) => tool.name));
    for (const retired of [
      "codex_question_card",
      "codex_question_submit",
      "codex_question_notify",
      "codex_ask_user",
      "codex_user_answer",
      "codex_question_action"
    ]) {
      expect(names.has(retired)).toBe(false);
    }
  });
});
