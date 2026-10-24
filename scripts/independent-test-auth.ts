import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Live checks must use a persistent, independently signed-in test profile.
 * A copied production auth.json is not an independent login: a refresh in the
 * disposable copy can leave the production client with an obsolete token.
 */
export async function independentTestCodexHome(environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  const selected = environment.CODEX_BRIDGE_TEST_CODEX_HOME;
  if (!selected || !path.isAbsolute(selected)) {
    throw new Error("Set CODEX_BRIDGE_TEST_CODEX_HOME to an absolute, persistent Codex home with an independent test login.");
  }
  const home = await realpath(selected);
  const operational = await realpath(environment.CODEX_HOME || path.join(environment.HOME || homedir(), ".codex"))
    .catch(() => path.resolve(environment.CODEX_HOME || path.join(environment.HOME || homedir(), ".codex")));
  if (home === operational || home.startsWith(`${operational}${path.sep}`) || operational.startsWith(`${home}${path.sep}`)) {
    throw new Error("The independent test home must differ from the active Codex home and cannot contain it.");
  }
  const marker = path.join(home, ".bridge-independent-test-auth");
  const markerInfo = await stat(marker).catch(() => null);
  if (!markerInfo?.isFile()) {
    throw new Error("The test home needs a .bridge-independent-test-auth marker created when the independent test login is provisioned.");
  }
  const config = await readFile(path.join(home, "config.toml"), "utf8").catch(() => "");
  if (!/^\s*cli_auth_credentials_store\s*=\s*["']file["']\s*$/m.test(config.split(/^\s*\[/m, 1)[0])) {
    throw new Error("The independent test home must explicitly use cli_auth_credentials_store = \"file\".");
  }
  const testAuth = path.join(home, "auth.json");
  const testAuthStat = await stat(testAuth).catch(() => null);
  if (!testAuthStat?.isFile()) {
    throw new Error("Sign in separately inside the persistent test home before running live checks.");
  }
  const operationalAuthStat = await stat(path.join(operational, "auth.json")).catch(() => null);
  if (operationalAuthStat && operationalAuthStat.dev === testAuthStat.dev && operationalAuthStat.ino === testAuthStat.ino) {
    throw new Error("The independent test home cannot share the operating authentication file.");
  }
  return home;
}
