import { describe, expect, it } from "vitest";
import { parseLauncherArgs } from "../scripts/launcher-options.mjs";

describe("bridge launcher options", () => {
  it("parses bridge and tunnel options without a filesystem root", () => {
    expect(parseLauncherArgs([
      "--mode",
      "secure",
      "--allow-write",
      "--env-file",
      "/private/runtime.env",
      "--tunnel-id",
      "tunnel_test",
      "--no-build"
    ])).toEqual({
      mode: "secure",
      allowWrite: true,
      envFile: "/private/runtime.env",
      tunnelId: "tunnel_test",
      noBuild: true
    });
  });

  it("rejects the retired --root option so projects are configured only in Settings", () => {
    expect(() => parseLauncherArgs(["--root", "/one"])).toThrow("Unknown argument: --root");
  });

  it("fails closed when a supported option value is missing", () => {
    for (const option of ["--mode", "--port", "--env-file", "--tunnel-id", "--profile", "--tunnel-client"]) {
      expect(() => parseLauncherArgs([option])).toThrow(`${option} requires a value`);
      expect(() => parseLauncherArgs([option, "--no-build"])).toThrow(`${option} requires a value`);
    }
  });
});
