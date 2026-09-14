import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { loadConfig } from "../src/config.js";
import { createHttpServer, type BridgeHttpServer } from "../src/server.js";
import { BridgeStateStore } from "../src/stateStore.js";
import { USER_QUESTION_META } from "../src/questionTools.js";
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

describe("current question-card contract", () => {
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

  it("uses codex_ui_read and codex_question_action for the full card lifecycle", async () => {
    const created = await client.callTool({
      name: "codex_ask_user",
      arguments: {
        requestId: randomUUID(),
        title: "Color",
        questions: [{
          id: "color",
          header: "Color",
          question: "Which color?",
          isOther: false,
          options: [{ label: "Blue", description: "Blue" }, { label: "Red", description: "Red" }]
        }]
      },
      _meta: metadata
    });
    expect(created.isError, JSON.stringify(created)).not.toBe(true);
    const question = (created._meta as Record<string, any>)[USER_QUESTION_META];
    const proof = {
      questionId: question.questionId,
      revision: question.revision,
      presentationToken: question.presentationToken,
      scopeId: question.scopeId
    };
    expect(proof).toMatchObject({ questionId: expect.any(String), revision: 1, presentationToken: expect.any(String) });

    const card = await client.callTool({
      name: "codex_ui_read",
      arguments: { view: "question", ...proof },
      _meta: metadata
    });
    expect(card.isError, JSON.stringify({ card, proof })).not.toBe(true);
    expect(card.structuredContent).toEqual({ kind: "user-question-card", status: "pending" });

    const submitted = await client.callTool({
      name: "codex_question_action",
      arguments: {
        ...proof,
        operation: { kind: "submit", response: { answers: { color: ["Blue"] } } }
      },
      _meta: metadata
    });
    expect(submitted.isError).not.toBe(true);
    const responseRef = (submitted._meta as Record<string, any>)[USER_QUESTION_META].responseRef;
    expect(responseRef).toEqual(expect.any(String));

    const answer = await client.callTool({
      name: "codex_user_answer",
      arguments: { responseRef },
      _meta: metadata
    });
    expect(answer.isError).not.toBe(true);
    expect(answer.structuredContent).toMatchObject({
      kind: "user-answers",
      responses: [{ responseRef, answers: [{ questionId: "color", values: ["Blue"] }] }]
    });
  });

  it("does not register retired question tool aliases", async () => {
    const names = new Set((await client.listTools()).tools.map((tool) => tool.name));
    for (const retired of ["codex_question_card", "codex_question_submit", "codex_question_notify"]) {
      expect(names.has(retired)).toBe(false);
    }
  });
});
