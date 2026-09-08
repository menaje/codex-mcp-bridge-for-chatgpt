import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// Opt-in local acceptance fixture. No network access or user data is involved.
const server = new McpServer({ name: "original-control-probe", version: "1" });
server.registerTool("approval_probe", {
  description: "Harmless synthetic action for testing the original approval UI. Decline this action during the acceptance test.",
  inputSchema: {},
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
}, async () => {
  appendFileSync(process.env.ORIGINAL_CONTROL_LEDGER, "unexpected approval invocation\n", { mode: 0o600 });
  return { content: [{ type: "text", text: "PROBE_TOOL_EXECUTED" }] };
});
server.registerTool("input_probe", {
  description: "Ask the operator for a synthetic colour through the original MCP input form, then return the submitted value. No files are changed.",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
}, async () => {
  const response = await server.server.elicitInput({
    mode: "form", message: "원본 입력 검증: 파랑 또는 빨강을 선택하세요. 실제 사용자 정보는 입력하지 마세요.",
    requestedSchema: { type: "object", properties: { color: { type: "string", title: "검증 색상", enum: ["blue", "red"] } }, required: ["color"] }
  });
  return { content: [{ type: "text", text: `ORIGINAL_INPUT:${response.action}:${response.content?.color || "none"}` }] };
});
await server.connect(new StdioServerTransport());
