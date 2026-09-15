/**
 * Strict text decoding for runtime scripts that are intentionally shipped
 * outside TypeScript's `dist/` tree. Keep this byte-boundary behavior aligned
 * with src/textIntegrity.ts; the shared vector test exercises both modules.
 */

export function decodeUtf8Strict(input, field = "text") {
  try {
    if (!(input instanceof Uint8Array)) throw new TypeError("expected bytes");
    // Preserve a BOM as content. No byte sequence is silently removed or
    // replaced before a runtime file is parsed, compared, or hashed.
    const value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input);
    assertWellFormedUnicode(value, field);
    return value;
  } catch (error) {
    if (error instanceof TextIntegrityScriptError) throw error;
    throw new TextIntegrityScriptError("TEXT_UTF8_INVALID", `${field} is not valid UTF-8.`, error);
  }
}

export function parseJsonUtf8Strict(input, field = "JSON") {
  return parseJsonTextStrict(decodeUtf8Strict(input, field), field);
}

export function parseJsonTextStrict(input, field = "JSON") {
  assertWellFormedUnicode(input, field);
  const value = JSON.parse(input);
  assertJsonTextIntegrity(value, field);
  return value;
}

export function assertWellFormedUnicode(value, field = "text") {
  if (typeof value !== "string") {
    throw new TextIntegrityScriptError("TEXT_TYPE_INVALID", `${field} must be text.`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (following >= 0xdc00 && following <= 0xdfff) {
        index += 1;
        continue;
      }
      throw new TextIntegrityScriptError(
        "TEXT_UNICODE_INVALID",
        `${field} contains an unpaired Unicode surrogate.`
      );
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TextIntegrityScriptError(
        "TEXT_UNICODE_INVALID",
        `${field} contains an unpaired Unicode surrogate.`
      );
    }
  }
}

export function assertJsonTextIntegrity(value, field = "JSON") {
  if (typeof value === "string") {
    assertWellFormedUnicode(value, field);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonTextIntegrity(entry, `${field}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      assertWellFormedUnicode(key, `${field} key`);
      assertJsonTextIntegrity(entry, `${field}.${key}`);
    }
  }
}

export class TextIntegrityScriptError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "TextIntegrityScriptError";
    this.code = code;
  }
}
