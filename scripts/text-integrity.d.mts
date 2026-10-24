export class TextIntegrityScriptError extends Error {
  readonly code: string;
}

export function decodeUtf8Strict(input: Uint8Array, field?: string): string;
export function parseJsonUtf8Strict<T = unknown>(input: Uint8Array, field?: string): T;
export function parseJsonTextStrict<T = unknown>(input: string, field?: string): T;
export function assertJsonTextIntegrity(value: unknown, field?: string): void;
export function assertWellFormedUnicode(value: unknown, field?: string): asserts value is string;
