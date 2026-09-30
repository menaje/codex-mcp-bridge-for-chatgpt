import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { independentTestCodexHome } from "../scripts/independent-test-auth.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it("rejects a live test profile that is the operational home", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "independent-auth-test-")); roots.push(root);
  const shared = path.join(root, ".codex"); await mkdir(shared);
  await expect(independentTestCodexHome({ HOME: root, CODEX_BRIDGE_TEST_CODEX_HOME: shared }))
    .rejects.toThrow("must differ");
});

it("requires a persistent profile with an explicit independent login marker", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "independent-auth-test-")); roots.push(root);
  const testHome = path.join(root, "test-home"); await mkdir(testHome);
  const environment = { HOME: root, CODEX_BRIDGE_TEST_CODEX_HOME: testHome };
  await writeFile(path.join(testHome, "config.toml"), 'cli_auth_credentials_store = "file"\n');
  await writeFile(path.join(testHome, "auth.json"), "synthetic test data");
  await expect(independentTestCodexHome(environment)).rejects.toThrow("marker");
  await writeFile(path.join(testHome, ".bridge-independent-test-auth"), "separate test login\n");
  await expect(independentTestCodexHome(environment)).resolves.toBe(await realpath(testHome));
});

it("rejects a test profile that contains the operating home or shares its authentication inode", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "independent-auth-test-")); roots.push(root);
  const operating = path.join(root, ".codex"); await mkdir(operating);
  await expect(independentTestCodexHome({ HOME: root, CODEX_BRIDGE_TEST_CODEX_HOME: root }))
    .rejects.toThrow("cannot contain");
  const testHome = path.join(root, "test-home"); await mkdir(testHome);
  await writeFile(path.join(testHome, "config.toml"), 'cli_auth_credentials_store = "file"\n');
  await writeFile(path.join(testHome, ".bridge-independent-test-auth"), "independent login\n");
  await writeFile(path.join(operating, "auth.json"), "synthetic operating fixture");
  await link(path.join(operating, "auth.json"), path.join(testHome, "auth.json"));
  await expect(independentTestCodexHome({ HOME: root, CODEX_BRIDGE_TEST_CODEX_HOME: testHome }))
    .rejects.toThrow("cannot share");
});

it("keeps live probes from reintroducing a copied operational auth file", async () => {
  const scripts = fileURLToPath(new URL("../scripts/", import.meta.url));
  for (const name of await readdir(scripts)) {
    if (!name.endsWith(".ts")) continue;
    const source = await readFile(path.join(scripts, name), "utf8");
    if (!source.includes("--run-authenticated")) continue;
    expect(source, name).not.toMatch(/copyFile\s*\(/);
    expect(source, name).not.toMatch(/(?:readFile|readFileSync)\s*\([^\n]*auth\.json/);
  }
});
