import { execFile } from "node:child_process";
import manifest from "../release-manifest.json" with { type: "json" };
import { MAX_JSON_RPC_TIMEOUT_MS } from "./jsonRpcProcess.js";

const CODEX_SEMVER_SOURCE = String.raw`(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`;
const CODEX_SEMVER_PATTERN = new RegExp(`^${CODEX_SEMVER_SOURCE}$`);
const CODEX_VERSION_PATTERN = new RegExp(`^codex-cli\\s+(${CODEX_SEMVER_SOURCE})$`);

/** Reproducible schema-test baseline; never an admission allowlist. */
export const CODEX_CLI_TEST_VERSION = manifest.toolchain.codexCli;
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

export async function verifyCodexCli(
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
      `within ${timeoutMs}ms. ` +
      "Restore the chosen installation or explicitly select another one."
    );
  }
  if (!CODEX_SEMVER_PATTERN.test(observedVersion)) throw new Error("Configured Codex executable returned an unrecognized --version response.");
  return observedVersion;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}
