import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { executeCommandText } from "../src/crossPlatformCommand.js";

describe("cross-platform command execution", () => {
  it("captures bounded output from an executable", async () => {
    await expect(executeCommandText(process.execPath, ["-e", "process.stdout.write('ready')"], {
      timeoutMs: 2_000,
      maxBuffer: 1_024
    })).resolves.toEqual({ stdout: "ready", stderr: "" });
  });

  it("terminates bounded timeouts without exposing child output", async () => {
    await expect(executeCommandText(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      timeoutMs: 25,
      maxBuffer: 1_024
    })).rejects.toThrow("timed out");
  });

  it.runIf(process.platform === "win32")("runs Windows npm-style cmd shims", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codex-command-shim-"));
    try {
      const shim = path.join(directory, "codex.cmd");
      writeFileSync(shim, "@ECHO OFF\r\nECHO codex-cli 0.145.0\r\n", "utf8");
      await expect(executeCommandText(shim, ["--version"], {
        timeoutMs: 2_000,
        maxBuffer: 1_024
      })).resolves.toMatchObject({ stdout: expect.stringContaining("codex-cli 0.145.0") });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
