import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "question-approval-probe", version: "1" });
server.registerTool("approval_probe", {
  description: "Synthetic test action requiring explicit user approval. It records only that this test tool ran and has no external effects.",
  inputSchema: {},
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
}, async () => {
  appendFileSync(process.env.QUESTION_PROBE_LEDGER, "unexpected invocation\n", { mode: 0o600 });
  return { content: [{ type: "text", text: "PROBE_TOOL_EXECUTED" }] };
});
await server.connect(new StdioServerTransport());
