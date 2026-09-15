import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  decodeUtf8Strict as decodeRuntimeScriptUtf8Strict,
  parseJsonUtf8Strict as parseRuntimeScriptJsonUtf8Strict
} from "../scripts/text-integrity.mjs";
import {
  TextIntegrityError,
  assertJsonTextIntegrity,
  canonicalHumanText,
  decodeUtf8Strict,
  parseJsonUtf8Strict,
  parseJsonTextStrict,
  searchKey,
  utf8ByteLength,
  verbatimText
} from "../src/textIntegrity.js";

type Vectors = {
  utf8: Array<{ name: string; hex: string; valid: boolean; text?: string }>;
  canonicalHumanText: Array<{
    input: string;
    expected: string;
    collapseWhitespace?: boolean;
    trim?: boolean;
  }>;
  verbatimText: Array<{ input: string; expected: string }>;
  searchKey: Array<{ input: string; expected: string }>;
};

const vectors = JSON.parse(readFileSync("locales/text-integrity-vectors.json", "utf8")) as Vectors;

describe("text integrity policy", () => {
  it("passes the shared Node/Swift UTF-8 and normalization vectors", () => {
    for (const vector of vectors.utf8) {
      const decode = () => decodeUtf8Strict(Buffer.from(vector.hex, "hex"), vector.name);
      const decodeRuntimeScript = () => decodeRuntimeScriptUtf8Strict(
        Buffer.from(vector.hex, "hex"),
        vector.name
      );
      if (vector.valid) expect(decode()).toBe(vector.text);
      if (vector.valid) expect(decodeRuntimeScript()).toBe(vector.text);
      else {
        expect(decode).toThrow(TextIntegrityError);
        expect(decodeRuntimeScript).toThrow(/valid UTF-8/i);
      }
    }
    for (const vector of vectors.canonicalHumanText) {
      expect(canonicalHumanText(vector.input, {
        collapseWhitespace: vector.collapseWhitespace,
        trim: vector.trim
      })).toBe(vector.expected);
    }
    for (const vector of vectors.verbatimText) {
      expect(verbatimText(vector.input)).toBe(vector.expected);
    }
    for (const vector of vectors.searchKey) {
      expect(searchKey(vector.input)).toBe(vector.expected);
    }
  });

  it("rejects JSON escaped unpaired surrogates before persistence or forwarding", () => {
    expect(() => assertJsonTextIntegrity(JSON.parse('"\\ud800"'))).toThrow(/unpaired Unicode surrogate/i);
    expect(() => parseJsonUtf8Strict(Buffer.from('"\\ud800"'), "fixture JSON"))
      .toThrow(/unpaired Unicode surrogate/i);
    expect(() => parseJsonTextStrict('"\\ud800"', "fixture JSON"))
      .toThrow(/unpaired Unicode surrogate/i);
    expect(() => parseRuntimeScriptJsonUtf8Strict(Buffer.from('"\\ud800"'), "fixture JSON"))
      .toThrow(/unpaired Unicode surrogate/i);
    expect(parseJsonUtf8Strict<{ value: string }>(Buffer.from('{"value":"각"}')))
      .toEqual({ value: "각" });
  });

  it("counts and preserves the exact UTF-8 text selected for storage", () => {
    const raw = "Café\r\n`./각`";
    expect(verbatimText(raw)).toBe(raw);
    expect(utf8ByteLength(raw)).toBe(Buffer.byteLength(raw, "utf8"));
    expect(canonicalHumanText("Café")).toBe("Café");
  });

  it("counts Unicode scalars rather than grapheme clusters for field limits", () => {
    const emojiWithModifier = "👍🏽";
    expect(() => canonicalHumanText(emojiWithModifier, { maxCharacters: 1 }))
      .toThrow(/exceeds 1 characters/i);
    expect(canonicalHumanText(emojiWithModifier, { maxCharacters: 2 }))
      .toBe(emojiWithModifier);
  });
});
