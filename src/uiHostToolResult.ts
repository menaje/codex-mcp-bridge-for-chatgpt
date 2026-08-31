type UnknownRecord = Record<string, unknown>;

/**
 * Normalizes the direct MCP Apps tool result and ChatGPT's compatibility
 * metadata wrappers without depending on a particular host/client version.
 *
 * This function is also serialized into the self-contained card HTML. Keep it
 * free of module-local dependencies.
 */
export function normalizeHostToolResult(value: unknown): unknown {
  const queue: unknown[] = [value];
  const seen = new Set<object>();
  let fallback: unknown = value;

  while (queue.length > 0 && seen.size < 16) {
    let current = queue.shift();
    if (typeof current === "string") {
      try {
        current = JSON.parse(current);
      } catch {
        continue;
      }
    }
    if (!current || typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (fallback === value) fallback = current;

    const record = current as UnknownRecord;
    if (
      Object.prototype.hasOwnProperty.call(record, "_meta") ||
      Object.prototype.hasOwnProperty.call(record, "structuredContent") ||
      Object.prototype.hasOwnProperty.call(record, "content") ||
      Object.prototype.hasOwnProperty.call(record, "isError")
    ) {
      return record;
    }

    // OpenAI's compatibility bridge can place the complete MCP result under
    // either canonical field. `result` and `tool_result` cover nested bridge
    // responses used by compatible MCP Apps hosts.
    for (const key of ["mcp_tool_result", "call_tool_result", "result", "tool_result"]) {
      if (Object.prototype.hasOwnProperty.call(record, key)) queue.push(record[key]);
    }
  }

  return fallback;
}

/**
 * Returns private MCP result metadata from either a complete result envelope
 * or ChatGPT's canonical compatibility metadata wrapper. A raw metadata map is
 * returned unchanged for older hosts.
 */
export function hostToolResultMetadata(value: unknown): UnknownRecord {
  const normalized = normalizeHostToolResult(value);
  if (!normalized || typeof normalized !== "object") return {};
  const record = normalized as UnknownRecord;
  const metadata = record._meta;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as UnknownRecord
    : record;
}
