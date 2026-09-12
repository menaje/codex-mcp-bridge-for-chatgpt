import { describe, expect, it } from "vitest";
import {
  hostToolResultMetadata,
  normalizeHostToolResult
} from "../src/uiHostToolResult.js";

describe("ChatGPT host tool-result normalization", () => {
  const dashboardMetadata = {
    "codex/dashboardView@1": {
      kind: "codex/dashboardView",
      version: 1
    }
  };

  it("keeps a legacy raw metadata map intact", () => {
    expect(hostToolResultMetadata(dashboardMetadata)).toBe(dashboardMetadata);
  });

  it("keeps a direct MCP tool result and exposes its private metadata", () => {
    const result = {
      structuredContent: { kind: "activity" },
      _meta: dashboardMetadata
    };

    expect(normalizeHostToolResult(result)).toBe(result);
    expect(hostToolResultMetadata(result)).toBe(dashboardMetadata);
  });

  it("unwraps the canonical mcp_tool_result envelope", () => {
    const result = {
      structuredContent: { kind: "dashboard" },
      _meta: dashboardMetadata
    };
    const wrapped = {
      status: "complete",
      call_tool_result: { ignored: true },
      mcp_tool_result: result
    };

    expect(normalizeHostToolResult(wrapped)).toBe(result);
    expect(hostToolResultMetadata(wrapped)).toBe(dashboardMetadata);
  });

  it("unwraps JSON-encoded and nested compatibility results", () => {
    const result = {
      content: [{ type: "text", text: "{}" }],
      _meta: dashboardMetadata
    };
    const wrapped = {
      call_tool_result: JSON.stringify({ result })
    };

    expect(normalizeHostToolResult(wrapped)).toEqual(result);
    expect(hostToolResultMetadata(wrapped)).toEqual(dashboardMetadata);
  });

  it("unwraps a nested tool_result compatibility envelope", () => {
    const result = {
      content: [{ type: "text", text: "{}" }],
      _meta: dashboardMetadata
    };

    expect(normalizeHostToolResult({ result: { tool_result: result } })).toBe(result);
  });

  it("bounds cyclic wrapper traversal and returns a usable fallback", () => {
    const wrapped: Record<string, unknown> = { status: "complete" };
    wrapped.result = wrapped;

    expect(normalizeHostToolResult(wrapped)).toBe(wrapped);
    expect(hostToolResultMetadata(wrapped)).toBe(wrapped);
  });
});
