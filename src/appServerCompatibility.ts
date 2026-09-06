import { hasManagedCliVerification } from "./runtimeCompatibility.js";
import { execFile } from "node:child_process";
import manifest from "../release-manifest.json" with { type: "json" };
import { MAX_JSON_RPC_TIMEOUT_MS } from "./jsonRpcProcess.js";

const CODEX_SEMVER_SOURCE = String.raw`(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`;
const CODEX_SEMVER_PATTERN = new RegExp(`^${CODEX_SEMVER_SOURCE}$`);
const CODEX_VERSION_PATTERN = new RegExp(`^codex-cli\\s+(${CODEX_SEMVER_SOURCE})$`);

export const SUPPORTED_CODEX_CLI_VERSION = manifest.toolchain.codexCli;
/** Reproducible CI pin above; user installations are a separately validated allowlist. */
export const SUPPORTED_CODEX_CLI_VERSIONS = [SUPPORTED_CODEX_CLI_VERSION, "0.153.1"] as const;
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
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      command,
      ["--version"],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        signal,
        timeout: timeoutMs,
        windowsHide: true
      },
      (error, commandStdout) => {
        if (error) {
          const timedOut = isRecord(error) && (error.killed === true || error.code === "ETIMEDOUT");
          reject(new Error(
            timedOut
              ? `Configured Codex executable version check timed out after ${timeoutMs}ms.`
              : "Configured Codex executable could not complete a version check."
          ));
          return;
        }
        resolve(commandStdout);
      }
    );
  });
  return parseCodexCliVersion(stdout);
}

export function assertSupportedCodexCliVersion(command: string, observedVersion: string): void {
  if (!CODEX_SEMVER_PATTERN.test(observedVersion)) {
    throw new Error("Configured Codex executable returned an unrecognized --version response.");
  }
  if (SUPPORTED_CODEX_CLI_VERSIONS.includes(observedVersion)) return;
  throw new Error(
    `Configured Codex executable ${JSON.stringify(command)} reported version ${observedVersion}; ` +
    `this bridge supports Codex CLI ${SUPPORTED_CODEX_CLI_VERSIONS.join(", ")} for App Server. ` +
    "Your selection was preserved. Choose a validated installation or keep using your current setup until it is supported."
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
      `within ${timeoutMs}ms; validated App Server versions: ${SUPPORTED_CODEX_CLI_VERSIONS.join(", ")}. ` +
      "Restore the chosen installation or explicitly select another one."
    );
  }
  if (await hasManagedCliVerification(command, observedVersion)) return observedVersion;
  assertSupportedCodexCliVersion(command, observedVersion);
  return observedVersion;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}
