import type {
  McpServer,
  RegisteredTool
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type * as z from "zod/v4";

/**
 * Transport-facing projection update. Policy enforcement never depends on
 * delivery of this advisory descriptor notification.
 */
export type ModelPolicyChangedEvent = {
  policyRevision: number;
  catalogFingerprint?: string;
  schema: z.ZodType;
  annotations: ToolAnnotations;
  metadata?: Record<string, unknown>;
};

export type ModelPolicyProjectionStatus = {
  schemaRefreshRequested: boolean;
  schemaRefreshGuaranteed: false;
  notificationAdapter: "sdk-tools-list-changed";
};

/**
 * Isolates the current MCP SDK's tools/list_changed mechanism from the model
 * policy core. A future subscriptions/listen adapter can implement the same
 * event boundary without changing resolver behavior.
 */
export class SdkModelPolicyProjectionAdapter {
  private tool?: RegisteredTool;
  private lastSignature?: string;

  constructor(private readonly server: McpServer) {}

  attach(tool: RegisteredTool): void {
    this.tool = tool;
  }

  publish(event: ModelPolicyChangedEvent): ModelPolicyProjectionStatus {
    if (!this.tool) {
      return {
        schemaRefreshRequested: false,
        schemaRefreshGuaranteed: false,
        notificationAdapter: "sdk-tools-list-changed"
      };
    }
    const signature = `${event.policyRevision}:${event.catalogFingerprint || "unavailable"}`;
    if (signature === this.lastSignature) {
      return {
        schemaRefreshRequested: false,
        schemaRefreshGuaranteed: false,
        notificationAdapter: "sdk-tools-list-changed"
      };
    }
    // Assigning the public properties preserves strict-object semantics and lets
    // one tools/list_changed notification cover the schema, annotations, and UI
    // projection. An undefined metadata value intentionally removes a previously
    // published Task UI binding.
    this.tool.inputSchema = event.schema;
    this.tool.annotations = event.annotations;
    this.tool._meta = event.metadata;
    this.lastSignature = signature;
    this.server.sendToolListChanged();
    return {
      schemaRefreshRequested: true,
      schemaRefreshGuaranteed: false,
      notificationAdapter: "sdk-tools-list-changed"
    };
  }
}
