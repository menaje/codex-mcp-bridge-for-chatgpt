import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  readPrivateFile,
  writePrivateFileAtomic
} from "../scripts/managed-file.mjs";

describe("managed private files", () => {
  it("never replaces a dangling symlink during an atomic write", () => {
    const root = mkdtempSync(path.join(tmpdir(), "codex-managed-file-"));
    const directory = path.join(root, "private");
    const file = path.join(directory, "status.json");
    mkdirSync(directory, { mode: 0o700 });
    symlinkSync(path.join(directory, "missing-target.json"), file);

    expect(() => readPrivateFile(file, { encoding: "utf8" }))
      .toThrow("regular, non-symlink file");
    expect(() => writePrivateFileAtomic(file, "{}\n", { encoding: "utf8" }))
      .toThrow("regular, non-symlink file");
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
  });
});
