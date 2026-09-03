import manifest from "../release-manifest.json" with { type: "json" };
import { executeCommandText } from "./crossPlatformCommand.js";
import { MAX_JSON_RPC_TIMEOUT_MS } from "./jsonRpcProcess.js";

const CODEX_SEMVER_SOURCE = String.raw`(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`;
const CODEX_SEMVER_PATTERN = new RegExp(`^${CODEX_SEMVER_SOURCE}$`);
const CODEX_VERSION_PATTERN = new RegExp(`^codex-cli\\s+(${CODEX_SEMVER_SOURCE})$`);

export const SUPPORTED_CODEX_CLI_VERSION = manifest.toolchain.codexCli;
export const DEFAULT_CODEX_VERSION_CHECK_TIMEOUT_MS = 5_000;

export type CodexCliVersionProbe = (
  command: string,
  timeoutMs: number,
  signal?: AbortSignal
) => Promise<string>;

export function parseCodexCliVersion(stdout: string): string {
  const match = CODEX_VERSION_PATTERN.exec(stdout.trim());
  if (!match) {
    throw new Error("Configured Codex executable returned an unrecognized --version response.");
  }
  return match[1]!;
}

export async function probeCodexCliVersion(
  command: string,
  timeoutMs = DEFAULT_CODEX_VERSION_CHECK_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<string> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_JSON_RPC_TIMEOUT_MS) {
    throw new Error(`Codex CLI version probe timeout must be between 1 and ${MAX_JSON_RPC_TIMEOUT_MS}ms.`);
  }
  const { stdout } = await executeCommandText(command, ["--version"], {
    timeoutMs,
    maxBuffer: 64 * 1024,
    signal
  });
  return parseCodexCliVersion(stdout);
}

export function assertSupportedCodexCliVersion(command: string, observedVersion: string): void {
  if (!CODEX_SEMVER_PATTERN.test(observedVersion)) {
    throw new Error("Configured Codex executable returned an unrecognized --version response.");
  }
  if (observedVersion === SUPPORTED_CODEX_CLI_VERSION) return;
  throw new Error(
    `Configured Codex executable ${JSON.stringify(command)} reported version ${observedVersion}; ` +
    `this bridge supports exactly Codex CLI ${SUPPORTED_CODEX_CLI_VERSION} for App Server. ` +
    `Install @openai/codex@${SUPPORTED_CODEX_CLI_VERSION} or point CODEX_MCP_BRIDGE_CODEX to that executable.`
  );
}

export async function verifySupportedCodexCli(
  command: string,
  timeoutMs = DEFAULT_CODEX_VERSION_CHECK_TIMEOUT_MS,
  probe: CodexCliVersionProbe = probeCodexCliVersion,
  signal?: AbortSignal
): Promise<string> {
  let observedVersion: string;
  try {
    observedVersion = await probe(command, timeoutMs, signal);
  } catch {
    throw new Error(
      `Configured Codex executable ${JSON.stringify(command)} could not be verified with --version ` +
      `within ${timeoutMs}ms; App Server requires exactly Codex CLI ${SUPPORTED_CODEX_CLI_VERSION}. ` +
      `Install @openai/codex@${SUPPORTED_CODEX_CLI_VERSION} or update CODEX_MCP_BRIDGE_CODEX.`
    );
  }
  assertSupportedCodexCliVersion(command, observedVersion);
  return observedVersion;
}
