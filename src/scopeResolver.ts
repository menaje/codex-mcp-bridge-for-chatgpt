import { createHmac, randomBytes } from "node:crypto";
import { SCOPE_ID_PATTERN } from "./sessionRegistry.js";
import type { BridgeStateStore } from "./stateStore.js";

const SCOPE_SECRET_META_KEY = "scope_hmac_secret_v1";
const SCOPE_KEY_VERSION = 1;
const SCOPE_ROTATION_POLICY = "manual-state-migration-required" as const;
const MAX_HOST_IDENTIFIER_LENGTH = 4_096;

export type ToolCallMetadata = Record<string, unknown> | undefined;

export type ScopeResolution = {
  scopeId: string;
  source: "host-metadata" | "explicit-compatibility";
  keyVersion: number;
  explicitInputIgnored: boolean;
};

export type ScopeResolverOptions = {
  stateStore?: BridgeStateStore;
  secret?: Uint8Array;
};

/**
 * Derives an opaque conversation routing key without retaining the host's raw
 * conversation, subject, or organization identifiers.
 */
export class ScopeResolver {
  private readonly secret: Buffer;

  constructor(options: ScopeResolverOptions = {}) {
    this.secret = options.secret
      ? validateSecret(Buffer.from(options.secret))
      : options.stateStore
        ? loadOrCreateSecret(options.stateStore)
        : randomBytes(32);
  }

  get keyVersion(): number {
    return SCOPE_KEY_VERSION;
  }

  get rotationPolicy(): typeof SCOPE_ROTATION_POLICY {
    return SCOPE_ROTATION_POLICY;
  }

  resolve(metadata: ToolCallMetadata, explicitScopeId?: string): ScopeResolution | undefined {
    const hostIdentity = readHostIdentity(metadata);
    if (hostIdentity) {
      return {
        scopeId: deriveScopeId(this.secret, hostIdentity),
        source: "host-metadata",
        keyVersion: SCOPE_KEY_VERSION,
        explicitInputIgnored: explicitScopeId !== undefined
      };
    }
    if (explicitScopeId === undefined) return undefined;
    const normalized = explicitScopeId.trim().toLowerCase();
    if (!SCOPE_ID_PATTERN.test(normalized)) {
      throw new Error("Expected a UUID-formatted compatibility scope id.");
    }
    return {
      scopeId: normalized,
      source: "explicit-compatibility",
      keyVersion: SCOPE_KEY_VERSION,
      explicitInputIgnored: false
    };
  }

  require(
    metadata: ToolCallMetadata,
    explicitScopeId: string | undefined,
    operation: string
  ): ScopeResolution {
    const resolution = this.resolve(metadata, explicitScopeId);
    if (resolution) return resolution;
    throw new Error(
      `${operation} requires ChatGPT conversation metadata or an explicit compatibility scopeId from a non-ChatGPT MCP host.`
    );
  }
}

type HostIdentity = {
  organization: string | null;
  subject: string | null;
  session: string;
};

function readHostIdentity(metadata: ToolCallMetadata): HostIdentity | undefined {
  if (!metadata || !Object.prototype.hasOwnProperty.call(metadata, "openai/session")) return undefined;
  const session = readIdentifier(metadata, "openai/session", true);
  return {
    organization: readIdentifier(metadata, "openai/organization", false),
    subject: readIdentifier(metadata, "openai/subject", false),
    session
  };
}

function readIdentifier(
  metadata: Record<string, unknown>,
  key: string,
  required: true
): string;
function readIdentifier(
  metadata: Record<string, unknown>,
  key: string,
  required: false
): string | null;
function readIdentifier(
  metadata: Record<string, unknown>,
  key: string,
  required: boolean
): string | null {
  if (!Object.prototype.hasOwnProperty.call(metadata, key)) {
    if (required) throw new Error(`Host metadata ${key} is required for derived scope routing.`);
    return null;
  }
  const value = metadata[key];
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_HOST_IDENTIFIER_LENGTH) {
    throw new Error(`Host metadata ${key} must be a non-empty bounded string.`);
  }
  return value;
}

function deriveScopeId(secret: Buffer, identity: HostIdentity): string {
  const digest = createHmac("sha256", secret)
    .update("codex-mcp-bridge/conversation-scope/v1\0")
    .update(JSON.stringify(identity))
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function loadOrCreateSecret(stateStore: BridgeStateStore): Buffer {
  return stateStore.transaction(() => {
    const encoded = stateStore.getMeta(SCOPE_SECRET_META_KEY);
    if (encoded !== undefined) {
      try {
        const decoded = validateSecret(Buffer.from(encoded, "base64url"));
        if (decoded.toString("base64url") !== encoded) {
          throw new Error("Conversation-scope HMAC key is not canonical base64url.");
        }
        return decoded;
      } catch (error) {
        throw new Error(
          `Invalid persisted conversation-scope HMAC key: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    const created = randomBytes(32);
    stateStore.setMeta(SCOPE_SECRET_META_KEY, created.toString("base64url"));
    return created;
  });
}

function validateSecret(secret: Buffer): Buffer {
  if (secret.length !== 32) throw new Error("Conversation-scope HMAC key must contain exactly 32 bytes.");
  return Buffer.from(secret);
}
