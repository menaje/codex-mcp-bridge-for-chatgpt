import { describe, expect, it } from "vitest";
import {
  parseLauncherArgs,
  requiredBuildOutputs
} from "../scripts/launcher-options.mjs";

describe("bridge launcher options", () => {
  it("parses bridge and tunnel options without a filesystem root", () => {
    expect(parseLauncherArgs([
      "--mode",
      "secure",
      "--transport",
      "stdio",
      "--allow-write",
      "--env-file",
      "/private/runtime.env",
      "--tunnel-id",
      "tunnel_test",
      "--runtime-status-file",
      "/private/run/status.json",
      "--tunnel-health-url-file",
      "/private/run/tunnel-health.url",
      "--tunnel-pid-file",
      "/private/run/tunnel.pid",
      "--profile-metadata-file",
      "/private/profiles/managed.json",
      "--require-built",
      "--reuse-profile"
    ])).toEqual({
      mode: "secure",
      transport: "stdio",
      allowWrite: true,
      envFile: "/private/runtime.env",
      tunnelId: "tunnel_test",
      runtimeStatusFile: "/private/run/status.json",
      tunnelHealthUrlFile: "/private/run/tunnel-health.url",
      tunnelPidFile: "/private/run/tunnel.pid",
      profileMetadataFile: "/private/profiles/managed.json",
      requireBuilt: true,
      reuseProfile: true
    });
  });

  it("rejects the retired --root option so projects are configured only in Settings", () => {
    expect(() => parseLauncherArgs(["--root", "/one"])).toThrow("Unknown argument: --root");
  });

  it("keeps development no-build distinct from installed-runtime mode", () => {
    expect(parseLauncherArgs(["--no-build"])).toEqual({ noBuild: true });
    expect(parseLauncherArgs(["--require-built", "--reuse-profile"])).toEqual({
      requireBuilt: true,
      reuseProfile: true
    });
  });

  it("fails closed when a supported option value is missing", () => {
    for (const option of [
      "--mode",
      "--transport",
      "--port",
      "--env-file",
      "--tunnel-id",
      "--profile",
      "--tunnel-client",
      "--profile-metadata-file",
      "--runtime-status-file",
      "--tunnel-health-url-file",
      "--tunnel-pid-file"
    ]) {
      expect(() => parseLauncherArgs([option])).toThrow(`${option} requires a value`);
      expect(() => parseLauncherArgs([option, "--no-build"])).toThrow(`${option} requires a value`);
    }
  });

  it("requires the transport-specific built entrypoints", () => {
    expect(requiredBuildOutputs("http")).toEqual(["dist/cli.js", "dist/build-info.json"]);
    expect(requiredBuildOutputs("stdio")).toEqual([
      "dist/stdio.js",
      "dist/stdioServer.js",
      "dist/build-info.json"
    ]);
    expect(() => requiredBuildOutputs("pipe")).toThrow("Unknown transport: pipe");
  });
});
