type UnknownRecord = Record<string, unknown>;

/**
 * Browser-safe counterpart to assertJsonTextIntegrity. Card helpers are
 * serialized into standalone HTML, so this deliberately has no module-local
 * dependency and is emitted before the functions that call it.
 */
export function uiJsonTextIsWellFormed(value: unknown): boolean {
  const seen = new Set<object>();
  const candidates: unknown[] = [value];

  while (candidates.length > 0) {
    const candidate = candidates.pop();
    if (typeof candidate === "string") {
      for (let index = 0; index < candidate.length; index += 1) {
        const codeUnit = candidate.charCodeAt(index);
        if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
          const following = candidate.charCodeAt(index + 1);
          if (following >= 0xdc00 && following <= 0xdfff) {
            index += 1;
            continue;
          }
          return false;
        }
        if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return false;
      }
      continue;
    }
    if (!candidate || typeof candidate !== "object") continue;
    if (seen.has(candidate)) continue;
    if (seen.size >= 10_000) return false;
    seen.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        for (const entry of candidate) candidates.push(entry);
        continue;
      }
      for (const [key, entry] of Object.entries(candidate)) {
        for (let index = 0; index < key.length; index += 1) {
          const codeUnit = key.charCodeAt(index);
          if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
            const following = key.charCodeAt(index + 1);
            if (following >= 0xdc00 && following <= 0xdfff) {
              index += 1;
              continue;
            }
            return false;
          }
          if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return false;
        }
        candidates.push(entry);
      }
    } catch {
      return false;
    }
  }

  return true;
}

/** Parse host-provided JSON text without admitting escaped lone surrogates. */
export function parseUiJsonTextStrict(value: string): unknown | undefined {
  if (!uiJsonTextIsWellFormed(value)) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return uiJsonTextIsWellFormed(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Normalizes the direct MCP Apps tool result and ChatGPT's compatibility
 * metadata wrappers without depending on a particular host/client version.
 *
 * These helpers are also serialized into the self-contained card HTML in
 * dependency order. Keep their dependencies browser-native.
 * OpenAI's compatibility bridge can wrap the complete MCP result in canonical
 * metadata fields; result/tool_result also cover compatible MCP Apps hosts.
 */
export function normalizeHostToolResult(value: unknown): unknown {
  const queue: unknown[] = [value];
  const seen = new Set<object>();
  let fallback: unknown = uiJsonTextIsWellFormed(value) ? value : undefined;

  while (queue.length > 0 && seen.size < 16) {
    let current = queue.shift();
    if (typeof current === "string") {
      current = parseUiJsonTextStrict(current);
    }
    if (!uiJsonTextIsWellFormed(current)) continue;
    if (!current || typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (fallback === undefined) fallback = current;

    const record = current as UnknownRecord;
    if (
      Object.prototype.hasOwnProperty.call(record, "_meta") ||
      Object.prototype.hasOwnProperty.call(record, "structuredContent") ||
      Object.prototype.hasOwnProperty.call(record, "content") ||
      Object.prototype.hasOwnProperty.call(record, "isError")
    ) {
      return record;
    }

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
