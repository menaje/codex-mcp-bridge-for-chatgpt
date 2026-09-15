/**
 * Text policy shared by every Bridge-skill ingress and storage boundary.
 *
 * Human metadata is canonicalized to NFC. Markdown bodies remain byte-stable
 * UTF-8 text because normalization can change code, paths, and examples.
 */

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function strictUtf8Decode(bytes: Uint8Array, label: string): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8 text.`);
  }
}

export function assertVerbatimUtf8Text(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  const encoded = Buffer.from(value, "utf8");
  if (strictUtf8Decode(encoded, label) !== value) {
    throw new Error(`${label} contains an invalid Unicode scalar value.`);
  }
  return value;
}

export function canonicalHumanText(value: unknown, label: string): string {
  return assertVerbatimUtf8Text(value, label).normalize("NFC");
}

export function canonicalSearchKey(value: string): string {
  return canonicalHumanText(value, "Search text").toLocaleLowerCase("en-US");
}

