import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { extractVerifiedArchive } from "../src/runtimeDownloads.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "bridge-archive-")); roots.push(root);
  const input = path.join(root, "input"), output = path.join(root, "output"), archive = path.join(root, "archive.tgz");
  await mkdir(input); await writeFile(path.join(input, "codex"), "verified fixture");
  return { input, output, archive };
}
describe("runtime archive preflight", () => {
  it("rejects a CLI archive containing any executable indirection before extracting files", async () => {
    const f = await fixture(); await symlink("codex", path.join(f.input, "launcher"));
    await tar.c({ cwd: f.input, file: f.archive, gzip: true }, ["codex", "launcher"]);
    await expect(extractVerifiedArchive(f.archive, f.output, false)).rejects.toThrow("RUNTIME_ARCHIVE_LINK_INVALID");
    await expect(readFile(path.join(f.output, "codex"))).rejects.toThrow();
  });
  it("accepts Python's internal links, but rejects escaping links before extracting anything", async () => {
    const f = await fixture(); await symlink("codex", path.join(f.input, "python"));
    await tar.c({ cwd: f.input, file: f.archive, gzip: true }, ["codex", "python"]);
    await extractVerifiedArchive(f.archive, f.output, true);
    expect(await readFile(path.join(f.output, "python"), "utf8")).toBe("verified fixture");
    const g = await fixture(); await symlink("../../outside", path.join(g.input, "escape"));
    await tar.c({ cwd: g.input, file: g.archive, gzip: true }, ["codex", "escape"]);
    await expect(extractVerifiedArchive(g.archive, g.output, true)).rejects.toThrow("RUNTIME_ARCHIVE_LINK_INVALID");
    await expect(readFile(path.join(g.output, "codex"))).rejects.toThrow();
  });
  it("rejects duplicate archive paths", async () => {
    const f = await fixture(); await tar.c({ cwd: f.input, file: f.archive }, ["codex", "codex"]);
    await expect(extractVerifiedArchive(f.archive, f.output, true)).rejects.toThrow("RUNTIME_ARCHIVE_DUPLICATE_PATH");
  });
});
