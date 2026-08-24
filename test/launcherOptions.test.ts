import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  MAX_LAUNCHER_ROOTS,
  parseLauncherArgs,
  resolveLauncherRoots,
  serializeLauncherRoots
} from "../scripts/launcher-options.mjs";

describe("bridge launcher root options", () => {
  it("keeps the legacy single --root form", () => {
    expect(parseLauncherArgs(["--mode", "local", "--root", "/one", "--no-build"])).toEqual({
      mode: "local",
      roots: ["/one"],
      noBuild: true
    });
  });

  it("collects repeatable roots in operator-supplied order", () => {
    expect(
      parseLauncherArgs([
        "--root",
        "/one",
        "--allow-write",
        "--root",
        "/two",
        "--root",
        "/three"
      ])
    ).toEqual({
      roots: ["/one", "/two", "/three"],
      allowWrite: true
    });
  });

  it("uses cwd when no root is supplied", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codex-launcher-default-"));
    expect(resolveLauncherRoots([], directory)).toEqual([realpathSync(directory)]);
  });

  it("canonicalizes and de-duplicates roots without changing first-seen order", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codex-launcher-roots-"));
    const first = path.join(directory, "first");
    const second = path.join(directory, "second");
    const alias = path.join(directory, "first-alias");
    mkdirSync(first);
    mkdirSync(second);
    symlinkSync(first, alias, "dir");

    const roots = resolveLauncherRoots(["first", alias, "second"], directory);

    expect(roots).toEqual([realpathSync(first), realpathSync(second)]);
    const serialized = serializeLauncherRoots(roots);
    expect(serialized).toBe(`${realpathSync(first)},${realpathSync(second)}`);
    expect(
      loadConfig({
        CODEX_MCP_BRIDGE_NO_AUTH: "1",
        CODEX_MCP_BRIDGE_ROOTS: serialized
      }).allowedRoots
    ).toEqual(roots);
  });

  it("fails closed when an option value is missing", () => {
    for (const option of ["--root", "--mode", "--port", "--tunnel-id", "--profile", "--tunnel-client"]) {
      expect(() => parseLauncherArgs([option])).toThrow(`${option} requires a value`);
      expect(() => parseLauncherArgs([option, "--no-build"])).toThrow(`${option} requires a value`);
    }
  });

  it("bounds the number of launcher roots", () => {
    const rawArgs = Array.from({ length: MAX_LAUNCHER_ROOTS + 1 }, (_, index) => [
      "--root",
      `/root-${index}`
    ]).flat();
    expect(() => parseLauncherArgs(rawArgs)).toThrow(`At most ${MAX_LAUNCHER_ROOTS}`);
  });

  it("rejects missing paths, files, and paths that cannot round-trip through the root environment", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codex-launcher-invalid-"));
    const file = path.join(directory, "file");
    const comma = path.join(directory, "comma,root");
    const trailingSpace = path.join(directory, "trailing-space ");
    writeFileSync(file, "not a directory");
    mkdirSync(comma);
    mkdirSync(trailingSpace);

    expect(() => resolveLauncherRoots([path.join(directory, "missing")])).toThrow(/existing directory/);
    expect(() => resolveLauncherRoots([file])).toThrow(/existing directory/);
    expect(() => resolveLauncherRoots([comma])).toThrow(/represented safely/);
    expect(() => resolveLauncherRoots([trailingSpace])).toThrow(/represented safely/);
    expect(() => resolveLauncherRoots(["line\nfeed"])).toThrow(/control characters/);
  });
});
