import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  type Stats
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const TUNNEL_ID_PATTERN = /^tunnel_[a-z0-9]{32}$/;
const API_KEY_PATTERN = /^sk-\S{16,}$/;
const MAX_PROFILE_BYTES = 256 * 1_024;
const MAX_SECRET_BYTES = 4_096;

export type TunnelSetupCandidateSource =
  | "runtime-config"
  | "environment"
  | "tunnel-client-profile";

export type TunnelSetupApiKeySource =
  | "runtime-config"
  | "control-plane-environment"
  | "openai-environment"
  | "profile-environment"
  | "profile-file"
  | "none";

export type TunnelSetupCandidate = {
  id: string;
  source: TunnelSetupCandidateSource;
  profileName: string | null;
  tunnelId: string;
  hasApiKey: boolean;
  apiKeySource: TunnelSetupApiKeySource;
};

export type TunnelSetupDiscovery = {
  kind: "setup-discovery";
  candidates: TunnelSetupCandidate[];
};

export type ResolvedTunnelSetupCandidate = TunnelSetupCandidate & {
  apiKey?: string;
};

export type TunnelSetupDiscoveryOptions = {
  environment?: NodeJS.ProcessEnv;
  runtimeValues?: Record<string, string>;
  profileDirectory?: string;
  homeDirectory?: string;
  platform?: NodeJS.Platform;
  uid?: number;
};

export function discoverTunnelSetup(
  options: TunnelSetupDiscoveryOptions = {}
): TunnelSetupDiscovery {
  return {
    kind: "setup-discovery",
    candidates: resolvedTunnelSetupCandidates(options).map(({ apiKey: _apiKey, ...candidate }) =>
      candidate
    )
  };
}

export function resolveTunnelSetupCandidate(
  candidateId: string,
  options: TunnelSetupDiscoveryOptions = {}
): ResolvedTunnelSetupCandidate | undefined {
  return resolvedTunnelSetupCandidates(options).find((candidate) => candidate.id === candidateId);
}

function resolvedTunnelSetupCandidates(
  options: TunnelSetupDiscoveryOptions
): ResolvedTunnelSetupCandidate[] {
  const environment = options.environment || process.env;
  const runtimeValues = options.runtimeValues || {};
  const platform = options.platform || process.platform;
  const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
  const candidates: ResolvedTunnelSetupCandidate[] = [];

  addValuesCandidate(candidates, {
    source: "runtime-config",
    profileName: null,
    values: runtimeValues,
    fallbackEnvironment: environment,
    ownKeySource: "runtime-config"
  });
  addValuesCandidate(candidates, {
    source: "environment",
    profileName: null,
    values: environment,
    fallbackEnvironment: {},
    ownKeySource: "control-plane-environment"
  });

  const profileDirectory = resolveProfileDirectory(options, environment);
  for (const profile of readTunnelProfiles(profileDirectory, { platform, uid })) {
    const mergedEnvironment: NodeJS.ProcessEnv = { ...environment, ...runtimeValues };
    const resolvedKey = resolveProfileApiKey(profile.apiKeyReference, mergedEnvironment, {
      platform,
      uid
    });
    const fallbackKey = resolvedKey || resolveEnvironmentApiKey(mergedEnvironment);
    candidates.push({
      id: candidateId("tunnel-client-profile", profile.name, profile.tunnelId),
      source: "tunnel-client-profile",
      profileName: profile.name,
      tunnelId: profile.tunnelId,
      hasApiKey: Boolean(fallbackKey?.value),
      apiKeySource: fallbackKey?.source || "none",
      ...(fallbackKey?.value ? { apiKey: fallbackKey.value } : {})
    });
  }

  const byTunnelId = new Map<string, ResolvedTunnelSetupCandidate>();
  for (const candidate of candidates) {
    const existing = byTunnelId.get(candidate.tunnelId);
    if (!existing || (!existing.hasApiKey && candidate.hasApiKey)) {
      byTunnelId.set(candidate.tunnelId, candidate);
    }
  }
  return [...byTunnelId.values()];
}

function addValuesCandidate(
  candidates: ResolvedTunnelSetupCandidate[],
  input: {
    source: Exclude<TunnelSetupCandidateSource, "tunnel-client-profile">;
    profileName: null;
    values: NodeJS.ProcessEnv | Record<string, string>;
    fallbackEnvironment: NodeJS.ProcessEnv | Record<string, string>;
    ownKeySource: Exclude<TunnelSetupApiKeySource, "openai-environment" | "profile-environment" | "profile-file" | "none">;
  }
): void {
  const tunnelId = input.values.CONTROL_PLANE_TUNNEL_ID?.trim();
  if (!tunnelId || !TUNNEL_ID_PATTERN.test(tunnelId)) return;
  const ownKey = validApiKey(input.values.CONTROL_PLANE_API_KEY);
  const fallbackKey = ownKey
    ? { value: ownKey, source: input.ownKeySource }
    : resolveEnvironmentApiKey(
      input.source === "environment" ? input.values : input.fallbackEnvironment
    );
  candidates.push({
    id: candidateId(input.source, null, tunnelId),
    source: input.source,
    profileName: null,
    tunnelId,
    hasApiKey: Boolean(fallbackKey?.value),
    apiKeySource: fallbackKey?.source || "none",
    ...(fallbackKey?.value ? { apiKey: fallbackKey.value } : {})
  });
}

function resolveEnvironmentApiKey(
  environment: NodeJS.ProcessEnv | Record<string, string>
): { value: string; source: TunnelSetupApiKeySource } | undefined {
  const controlPlaneKey = validApiKey(environment.CONTROL_PLANE_API_KEY);
  if (controlPlaneKey) {
    return { value: controlPlaneKey, source: "control-plane-environment" };
  }
  const openAIKey = validApiKey(environment.OPENAI_API_KEY);
  if (openAIKey) return { value: openAIKey, source: "openai-environment" };
  return undefined;
}

function resolveProfileApiKey(
  reference: string | undefined,
  environment: NodeJS.ProcessEnv,
  security: { platform: NodeJS.Platform; uid?: number }
): { value: string; source: TunnelSetupApiKeySource } | undefined {
  if (!reference) return undefined;
  if (reference.startsWith("env:")) {
    const name = reference.slice(4);
    if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(name)) return undefined;
    if (name === "OPENAI_ADMIN_KEY" || name.startsWith("CODEX_")) return undefined;
    const value = validApiKey(environment[name]);
    return value ? { value, source: "profile-environment" } : undefined;
  }
  if (!reference.startsWith("file:")) return undefined;
  const filePath = reference.slice(5);
  if (!path.isAbsolute(filePath)) return undefined;
  try {
    const stats = lstatSync(filePath);
    assertPrivateEntry(stats, filePath, "file", security);
    if (stats.size > MAX_SECRET_BYTES) return undefined;
    const value = validApiKey(readFileSync(filePath, "utf8").trim());
    return value ? { value, source: "profile-file" } : undefined;
  } catch {
    return undefined;
  }
}

function resolveProfileDirectory(
  options: TunnelSetupDiscoveryOptions,
  environment: NodeJS.ProcessEnv
): string {
  if (options.profileDirectory) return path.resolve(options.profileDirectory);
  if (environment.TUNNEL_CLIENT_PROFILE_DIR) {
    return path.resolve(environment.TUNNEL_CLIENT_PROFILE_DIR);
  }
  const homeDirectory = options.homeDirectory || homedir();
  const configHome = environment.XDG_CONFIG_HOME || path.join(homeDirectory, ".config");
  return path.resolve(configHome, "tunnel-client");
}

function readTunnelProfiles(
  directory: string,
  security: { platform: NodeJS.Platform; uid?: number }
): Array<{ name: string; tunnelId: string; apiKeyReference?: string }> {
  try {
    const directoryStats = lstatSync(directory);
    assertPrivateEntry(directoryStats, directory, "directory", security);
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name))
      .flatMap((entry) => {
        const filePath = path.join(directory, entry.name);
        try {
          const stats = lstatSync(filePath);
          assertPrivateEntry(stats, filePath, "file", security);
          if (stats.size > MAX_PROFILE_BYTES) return [];
          const parsed = parseControlPlaneProfile(readFileSync(filePath, "utf8"));
          if (!parsed?.tunnelId || !TUNNEL_ID_PATTERN.test(parsed.tunnelId)) return [];
          return [{
            name: safeProfileName(entry.name.replace(/\.ya?ml$/i, "")),
            tunnelId: parsed.tunnelId,
            ...(parsed.apiKeyReference ? { apiKeyReference: parsed.apiKeyReference } : {})
          }];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function assertPrivateEntry(
  stats: Stats,
  entryPath: string,
  kind: "file" | "directory",
  security: { platform: NodeJS.Platform; uid?: number }
): void {
  const validKind = kind === "file" ? stats.isFile() : stats.isDirectory();
  if (stats.isSymbolicLink() || !validKind) throw new Error(`Unsafe ${kind}: ${entryPath}`);
  if (security.platform === "win32") return;
  if (typeof security.uid === "number" && stats.uid !== security.uid) {
    throw new Error(`Unowned ${kind}: ${entryPath}`);
  }
  if ((stats.mode & 0o077) !== 0) throw new Error(`Over-readable ${kind}: ${entryPath}`);
}

function parseControlPlaneProfile(
  contents: string
): { tunnelId?: string; apiKeyReference?: string } | undefined {
  let controlPlaneIndent: number | undefined;
  const result: { tunnelId?: string; apiKeyReference?: string } = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const trimmed = rawLine.trim();
    if (controlPlaneIndent === undefined) {
      if (/^control_plane:\s*(?:#.*)?$/.test(trimmed)) controlPlaneIndent = indent;
      continue;
    }
    if (indent <= controlPlaneIndent) break;
    const field = trimmed.match(/^(tunnel_id|api_key):\s*(.*?)\s*$/);
    if (!field) continue;
    const value = yamlScalar(field[2]);
    if (field[1] === "tunnel_id") result.tunnelId = value;
    else result.apiKeyReference = value;
  }
  return result.tunnelId ? result : undefined;
}

function yamlScalar(rawValue: string): string {
  const value = rawValue.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === "string" ? parsed : "";
    } catch {
      return "";
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value.replace(/\s+#.*$/, "").trim();
}

function validApiKey(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  if (
    !candidate ||
    !API_KEY_PATTERN.test(candidate) ||
    /^sk-admin-/i.test(candidate) ||
    /placeholder|runtime-key/i.test(candidate)
  ) {
    return undefined;
  }
  return candidate;
}

function safeProfileName(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 128) || "tunnel-client";
}

function candidateId(
  source: TunnelSetupCandidateSource,
  profileName: string | null,
  tunnelId: string
): string {
  const digest = createHash("sha256")
    .update(`${source}\0${profileName || ""}\0${tunnelId}`)
    .digest("hex")
    .slice(0, 24);
  return `setup_${digest}`;
}
