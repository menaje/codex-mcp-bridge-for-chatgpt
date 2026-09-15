/**
 * Explicit text-boundary policy shared by bridge features.
 *
 * A JavaScript string is not automatically a safe UTF-8 value: it can contain
 * unpaired UTF-16 surrogates, which Node silently encodes as U+FFFD.  Keep the
 * check here, before a value is persisted, hashed, compared, or sent onward.
 *
 * This module intentionally does not offer a global `normalizeText()` helper.
 * Callers must state whether their field is human text, a derived search key,
 * verbatim content, or an opaque identifier.
 */

export type TextIntegrityErrorCode =
  | "TEXT_TYPE_INVALID"
  | "TEXT_UTF8_INVALID"
  | "TEXT_UNICODE_INVALID"
  | "TEXT_EMPTY"
  | "TEXT_TOO_LONG"
  | "TEXT_TOO_LARGE"
  | "TEXT_CONTROL_CHARACTER"
  | "TEXT_NUL";

export class TextIntegrityError extends Error {
  constructor(
    readonly code: TextIntegrityErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "TextIntegrityError";
  }
}

export type TextIntegrityOptions = {
  /** Human-readable field name used only in a local validation error. */
  field?: string;
  /** Empty values are rejected unless explicitly allowed. */
  allowEmpty?: boolean;
  /** Bound Unicode scalar values, rather than UTF-16 code units. */
  maxCharacters?: number;
  /** Bound exact UTF-8 bytes after the selected policy is applied. */
  maxUtf8Bytes?: number;
  /** Reject C0/C1 control characters. */
  rejectControlCharacters?: boolean;
  /** Reject U+0000 independently of the broader control-character rule. */
  rejectNul?: boolean;
  /** Apply trim after NFC normalization. Only meaningful for human text. */
  trim?: boolean;
  /** Fold Unicode whitespace runs to one ASCII space after NFC normalization. */
  collapseWhitespace?: boolean;
};

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const UNICODE_WHITESPACE = /\p{White_Space}+/gu;

/**
 * Decode an external byte boundary without Node's replacement-character
 * fallback.  The decoded text itself is also checked for well-formed UTF-16
 * before callers can serialize it again.
 */
export function decodeUtf8Strict(
  input: Uint8Array,
  field = "text"
): string {
  try {
    // `ignoreBOM: true` retains a BOM as content rather than silently removing
    // a byte sequence from verbatim values.
    const value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input);
    assertWellFormedUnicode(value, field);
    return value;
  } catch (error) {
    if (error instanceof TextIntegrityError) throw error;
    throw new TextIntegrityError(
      "TEXT_UTF8_INVALID",
      `${field} is not valid UTF-8.`,
      { cause: error }
    );
  }
}

/** Assert that a JavaScript string can round-trip as UTF-8 without mutation. */
export function assertWellFormedUnicode(value: unknown, field = "text"): asserts value is string {
  if (typeof value !== "string") {
    throw new TextIntegrityError("TEXT_TYPE_INVALID", `${field} must be text.`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (following >= 0xdc00 && following <= 0xdfff) {
        index += 1;
        continue;
      }
      throw new TextIntegrityError(
        "TEXT_UNICODE_INVALID",
        `${field} contains an unpaired Unicode surrogate.`
      );
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TextIntegrityError(
        "TEXT_UNICODE_INVALID",
        `${field} contains an unpaired Unicode surrogate.`
      );
    }
  }
}

/**
 * Check every text value in an already-decoded JSON-shaped value. JSON can
 * spell an unpaired surrogate as `\\ud800`; byte-level UTF-8 validation alone
 * therefore is not enough after JSON.parse().
 */
export function assertJsonTextIntegrity(value: unknown, field = "JSON"): void {
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

/**
 * Parse JSON received as bytes without allowing a lossy UTF-8 conversion or
 * an escaped unpaired surrogate to enter a bridge-owned record.
 */
export function parseJsonUtf8Strict<T = unknown>(
  input: Uint8Array,
  field = "JSON"
): T {
  const text = decodeUtf8Strict(input, field);
  return parseJsonTextStrict<T>(text, field);
}

/** Parse already-decoded text while retaining the escaped-surrogate check. */
export function parseJsonTextStrict<T = unknown>(
  input: string,
  field = "JSON"
): T {
  assertWellFormedUnicode(input, field);
  const value = JSON.parse(input) as unknown;
  assertJsonTextIntegrity(value, field);
  return value as T;
}

/** Exact byte length after verifying that UTF-8 encoding cannot replace data. */
export function utf8ByteLength(value: string, field = "text"): number {
  assertWellFormedUnicode(value, field);
  return Buffer.byteLength(value, "utf8");
}

/**
 * Canonical text for names, descriptions, tags, and other display/searchable
 * fields where canonically equivalent Unicode spellings mean the same thing.
 */
export function canonicalHumanText(value: unknown, options: TextIntegrityOptions = {}): string {
  const field = options.field || "text";
  assertWellFormedUnicode(value, field);
  let result = value.normalize("NFC");
  if (options.collapseWhitespace) result = result.replace(UNICODE_WHITESPACE, " ");
  if (options.trim) result = result.trim();
  assertTextConstraints(result, {
    ...options,
    field,
    allowEmpty: options.allowEmpty ?? false,
    rejectControlCharacters: options.rejectControlCharacters ?? true,
    rejectNul: options.rejectNul ?? true
  });
  return result;
}

/**
 * Verbatim content for prompts, Markdown, code, paths, command lines, hashes,
 * and opaque external values. This validates encoding and optional field
 * bounds but never normalizes, trims, folds whitespace, or changes line ends.
 */
export function verbatimText(value: unknown, options: TextIntegrityOptions = {}): string {
  const field = options.field || "text";
  assertWellFormedUnicode(value, field);
  assertTextConstraints(value, {
    ...options,
    field,
    allowEmpty: options.allowEmpty ?? false,
    rejectNul: options.rejectNul ?? true
  });
  return value;
}

/**
 * Opaque identifiers are validated for UTF-8 fidelity only. They intentionally
 * receive no Unicode or case normalization because they may be protocol IDs,
 * filesystem names, hashes, or credentials.
 */
export function opaqueIdentifier(value: unknown, options: TextIntegrityOptions = {}): string {
  return verbatimText(value, options);
}

/**
 * Derived comparison key.  NFC is enough for canonical-equivalence matching;
 * NFKC is deliberately not used because it can merge distinct identifiers.
 * This never changes the caller's stored presentation value.
 */
export function searchKey(value: unknown, options: TextIntegrityOptions = {}): string {
  const canonical = canonicalHumanText(value, {
    ...options,
    allowEmpty: options.allowEmpty ?? true,
    collapseWhitespace: options.collapseWhitespace ?? true,
    trim: options.trim ?? true
  });
  return canonical.toLocaleLowerCase("en-US").normalize("NFC");
}

function assertTextConstraints(value: string, options: TextIntegrityOptions): void {
  const field = options.field || "text";
  const allowEmpty = options.allowEmpty ?? false;
  if (!allowEmpty && value.length === 0) {
    throw new TextIntegrityError("TEXT_EMPTY", `${field} cannot be empty.`);
  }
  if (options.maxCharacters !== undefined && Array.from(value).length > options.maxCharacters) {
    throw new TextIntegrityError(
      "TEXT_TOO_LONG",
      `${field} exceeds ${options.maxCharacters} characters.`
    );
  }
  if (options.maxUtf8Bytes !== undefined && utf8ByteLength(value, field) > options.maxUtf8Bytes) {
    throw new TextIntegrityError(
      "TEXT_TOO_LARGE",
      `${field} exceeds ${options.maxUtf8Bytes} UTF-8 bytes.`
    );
  }
  if (options.rejectNul && value.includes("\u0000")) {
    throw new TextIntegrityError("TEXT_NUL", `${field} cannot contain NUL.`);
  }
  if (options.rejectControlCharacters && CONTROL_CHARACTERS.test(value)) {
    throw new TextIntegrityError(
      "TEXT_CONTROL_CHARACTER",
      `${field} cannot contain control characters.`
    );
  }
}
