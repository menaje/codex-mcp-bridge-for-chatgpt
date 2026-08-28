import type { CallToolResult, ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import type * as z from "zod/v4";

/**
 * The four result projections intentionally have different trust and audience
 * boundaries. A canonical value is never returned directly: it must first be
 * projected into one authoritative structured channel and one bounded
 * compatibility channel.
 */
export type AuthoritativeProjectionChannel =
  | "model-orchestrator-semantic"
  | "app-hydration"
  | "operator-diagnostic";

export type ResultProjectionChannel =
  | AuthoritativeProjectionChannel
  | "text-protocol-compatibility";

export type CompatibilityCompleteness =
  | "summary-only"
  | "documented-support-level"
  | "primary-payload";

export type ToolResultContract<Schema extends z.ZodType> = Readonly<{
  toolName: string;
  channel: AuthoritativeProjectionChannel;
  outputSchema: Schema;
  structured: Readonly<{
    maxBytes: number;
  }>;
  privateMeta?: Readonly<{
    maxBytes: number;
  }>;
  compatibility: Readonly<{
    channel: "text-protocol-compatibility";
    format: "plain-text" | "compact-json";
    maxBytes: number;
    completeness: CompatibilityCompleteness;
  }>;
}>;

export type CanonicalResultProjection<Canonical, Structured> = Readonly<{
  canonical: Canonical;
  authoritative: Readonly<{
    channel: AuthoritativeProjectionChannel;
    value: Structured;
  }>;
  compatibility: Readonly<{
    channel: "text-protocol-compatibility";
    text?: string;
    content?: ContentBlock[];
  }>;
  appHydration?: Readonly<Record<string, unknown>>;
  protocolMeta?: Readonly<Record<string, unknown>>;
  isError?: boolean;
}>;

export const TOOL_CONTENT_BYTE_CAPS = Object.freeze({
  codex_status: 1_024,
  codex_models: 512,
  codex_settings: 768,
  codex_activity: 1_024,
  codex_agent: 512,
  codex_cancel: 768,
  codex_activity_update: 512,
  codex_activity_cancel: 768,
  codex_task_state: 1_024,
  codex_task_error: 1_536,
  codex_diagnostics: 512,
  app_only_mutation: 512,
  app_only_hydration: 1_024
} as const);

export const TOOL_STRUCTURED_BYTE_CAPS = Object.freeze({
  codex_status: 512 * 1_024,
  codex_models: 256 * 1_024,
  codex_settings: 32 * 1_024,
  codex_activity: 512 * 1_024,
  codex_agent: 128 * 1_024,
  codex_cancel: 128 * 1_024,
  codex_activity_update: 128 * 1_024,
  codex_activity_cancel: 256 * 1_024,
  codex_task: 32 * 1_024,
  codex_diagnostics: 128 * 1_024,
  app_only_mutation: 256 * 1_024,
  app_only_hydration: 1_024 * 1_024
} as const);

export function defineToolResultContract<Schema extends z.ZodType>(
  contract: ToolResultContract<Schema>
): ToolResultContract<Schema> {
  if (!Number.isSafeInteger(contract.compatibility.maxBytes) || contract.compatibility.maxBytes < 1) {
    throw new Error(`${contract.toolName} has an invalid compatibility text byte cap.`);
  }
  if (!Number.isSafeInteger(contract.structured.maxBytes) || contract.structured.maxBytes < 1) {
    throw new Error(`${contract.toolName} has an invalid structured-content byte cap.`);
  }
  if (
    contract.privateMeta &&
    (!Number.isSafeInteger(contract.privateMeta.maxBytes) || contract.privateMeta.maxBytes < 1)
  ) {
    throw new Error(`${contract.toolName} has an invalid private-metadata byte cap.`);
  }
  return Object.freeze(contract);
}

/**
 * Validate the authoritative projection before it crosses the MCP result
 * boundary. This is intentionally independent of SDK-side output validation:
 * persisted replays and structured error results pass through the same gate.
 */
export function projectToolResult<Schema extends z.ZodType, Canonical>(
  contract: ToolResultContract<Schema>,
  projection: CanonicalResultProjection<Canonical, z.input<Schema>>
): CallToolResult {
  if (projection.authoritative.channel !== contract.channel) {
    throw new Error(
      `${contract.toolName} projected ${projection.authoritative.channel} through a ${contract.channel} contract.`
    );
  }
  if (
    projection.compatibility.channel !== "text-protocol-compatibility" ||
    contract.compatibility.channel !== "text-protocol-compatibility"
  ) {
    throw new Error(`${contract.toolName} used an invalid compatibility projection channel.`);
  }
  let structuredContent: Record<string, unknown>;
  try {
    structuredContent = contract.outputSchema.parse(projection.authoritative.value) as Record<
      string,
      unknown
    >;
  } catch (error) {
    const detail = error instanceof Error ? error.stack || error.message : String(error);
    throw new Error(`${contract.toolName} output contract rejected its runtime projection: ${detail}`);
  }
  const structuredBytes = Buffer.byteLength(JSON.stringify(structuredContent), "utf8");
  if (structuredBytes > contract.structured.maxBytes) {
    throw new Error(
      `${contract.toolName} structured content is ${structuredBytes} bytes, above its ${contract.structured.maxBytes}-byte contract.`
    );
  }
  const content = compatibilityContent(contract, projection.compatibility);
  const privateMeta = projection.appHydration || projection.protocolMeta
    ? {
        ...(projection.protocolMeta || {}),
        ...(projection.appHydration || {})
      }
    : undefined;
  if (privateMeta) {
    if (!contract.privateMeta) {
      throw new Error(`${contract.toolName} projected private metadata without a metadata contract.`);
    }
    const privateMetaBytes = Buffer.byteLength(JSON.stringify(privateMeta), "utf8");
    if (privateMetaBytes > contract.privateMeta.maxBytes) {
      throw new Error(
        `${contract.toolName} private metadata is ${privateMetaBytes} bytes, above its ${contract.privateMeta.maxBytes}-byte contract.`
      );
    }
  }
  return {
    ...(projection.isError ? { isError: true } : {}),
    content,
    structuredContent,
    ...(privateMeta ? { _meta: privateMeta } : {})
  };
}

export function boundedUtf8Text(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const suffix = "\n… [truncated by output contract]";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  if (suffixBytes >= maxBytes) {
    let marker = "";
    let markerBytes = 0;
    for (const symbol of "… [truncated]") {
      const bytes = Buffer.byteLength(symbol, "utf8");
      if (markerBytes + bytes > maxBytes) break;
      marker += symbol;
      markerBytes += bytes;
    }
    return marker || ".".repeat(maxBytes);
  }
  const targetBytes = Math.max(0, maxBytes - suffixBytes);
  let output = "";
  let used = 0;
  for (const symbol of text) {
    const bytes = Buffer.byteLength(symbol, "utf8");
    if (used + bytes > targetBytes) break;
    output += symbol;
    used += bytes;
  }
  return `${output}${suffix}`;
}

export function contentTextBytes(content: readonly ContentBlock[]): number {
  return content.reduce(
    (total, item) => total + (item.type === "text" ? Buffer.byteLength(item.text, "utf8") : 0),
    0
  );
}

function compatibilityContent<Schema extends z.ZodType>(
  contract: ToolResultContract<Schema>,
  compatibility: CanonicalResultProjection<unknown, unknown>["compatibility"]
): ContentBlock[] {
  if (compatibility.content) {
    const content = [...compatibility.content];
    const textBytes = contentTextBytes(content);
    if (textBytes <= contract.compatibility.maxBytes) return content;
    if (contract.compatibility.completeness === "primary-payload") {
      throw new Error(
        `${contract.toolName} primary content is ${textBytes} bytes, above its ${contract.compatibility.maxBytes}-byte contract.`
      );
    }
    let remaining = contract.compatibility.maxBytes;
    return content.map((item) => {
      if (item.type !== "text") return item;
      const bounded = boundedUtf8Text(item.text, remaining);
      remaining = Math.max(0, remaining - Buffer.byteLength(bounded, "utf8"));
      return { ...item, text: bounded };
    });
  }
  const text = boundedUtf8Text(compatibility.text || "", contract.compatibility.maxBytes);
  return [{ type: "text", text }];
}
