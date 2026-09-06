import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverTunnelSetup,
  resolveTunnelSetupCandidate
} from "../src/tunnelSetupDiscovery.js";

const TUNNEL_ONE = "tunnel_11111111111111111111111111111111";
const TUNNEL_TWO = "tunnel_22222222222222222222222222222222";

describe("Secure MCP Tunnel setup discovery", () => {
  it("reports environment credentials without serializing the API key", () => {
    const secret = "sk-environment-1234567890123456";
    const environment = {
      CONTROL_PLANE_API_KEY: secret,
      CONTROL_PLANE_TUNNEL_ID: TUNNEL_ONE,
      OPENAI_ADMIN_KEY: "sk-admin-must-never-be-imported-123456"
    };

    const discovery = discoverTunnelSetup({
      environment,
      profileDirectory: path.join(temporaryDirectory(), "missing")
    });

    expect(discovery).toEqual({
      kind: "setup-discovery",
      candidates: [{
        id: expect.stringMatching(/^setup_[a-f0-9]{24}$/),
        source: "environment",
        profileName: null,
        tunnelId: TUNNEL_ONE,
        hasApiKey: true,
        apiKeySource: "control-plane-environment"
      }]
    });
    expect(JSON.stringify(discovery)).not.toContain(secret);
    expect(JSON.stringify(discovery)).not.toContain("admin-must-never");

    const resolved = resolveTunnelSetupCandidate(discovery.candidates[0].id, {
      environment,
      profileDirectory: path.join(temporaryDirectory(), "missing")
    });
    expect(resolved?.apiKey).toBe(secret);
  });

  it("uses OPENAI_API_KEY only as the documented runtime fallback", () => {
    const secret = "sk-openai-fallback-1234567890123456";
    const discovery = discoverTunnelSetup({
      environment: {
        OPENAI_API_KEY: secret,
        CONTROL_PLANE_TUNNEL_ID: TUNNEL_ONE
      },
      profileDirectory: path.join(temporaryDirectory(), "missing")
    });

    expect(discovery.candidates[0]).toMatchObject({
      tunnelId: TUNNEL_ONE,
      hasApiKey: true,
      apiKeySource: "openai-environment"
    });
    expect(JSON.stringify(discovery)).not.toContain(secret);
  });

  it("discovers private tunnel-client profiles and resolves env and file references", () => {
    const root = temporaryDirectory();
    const profileDirectory = path.join(root, "profiles");
    const keyFile = path.join(root, "runtime-key");
    mkdirSync(profileDirectory, { mode: 0o700 });
    writeFileSync(keyFile, "sk-private-file-1234567890123456\n", { mode: 0o600 });
    writeFileSync(path.join(profileDirectory, "alpha.yaml"), [
      "config_version: 1",
      "control_plane:",
      `  tunnel_id: \"${TUNNEL_ONE}\"`,
      "  api_key: \"env:CUSTOM_TUNNEL_KEY\"",
      "mcp:",
      "  commands: []",
      ""
    ].join("\n"), { mode: 0o600 });
    writeFileSync(path.join(profileDirectory, "beta.yml"), [
      "control_plane:",
      `  tunnel_id: '${TUNNEL_TWO}'`,
      `  api_key: 'file:${keyFile}'`,
      ""
    ].join("\n"), { mode: 0o600 });

    const options = {
      environment: { CUSTOM_TUNNEL_KEY: "sk-custom-env-1234567890123456" },
      profileDirectory
    };
    const discovery = discoverTunnelSetup(options);

    expect(discovery.candidates).toHaveLength(2);
    expect(discovery.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: "tunnel-client-profile",
        profileName: "alpha",
        tunnelId: TUNNEL_ONE,
        hasApiKey: true,
        apiKeySource: "profile-environment"
      }),
      expect.objectContaining({
        source: "tunnel-client-profile",
        profileName: "beta",
        tunnelId: TUNNEL_TWO,
        hasApiKey: true,
        apiKeySource: "profile-file"
      })
    ]));
    expect(JSON.stringify(discovery)).not.toContain("sk-custom-env");
    expect(JSON.stringify(discovery)).not.toContain("sk-private-file");

    const beta = discovery.candidates.find((candidate) => candidate.profileName === "beta");
    expect(resolveTunnelSetupCandidate(beta!.id, options)?.apiKey)
      .toBe("sk-private-file-1234567890123456");
  });

  it("ignores unsafe profile and key files without weakening permissions", () => {
    const root = temporaryDirectory();
    const profileDirectory = path.join(root, "profiles");
    const keyFile = path.join(root, "runtime-key");
    mkdirSync(profileDirectory, { mode: 0o700 });
    writeFileSync(keyFile, "sk-over-readable-1234567890123456\n", { mode: 0o600 });
    chmodSync(keyFile, 0o644);
    writeFileSync(path.join(profileDirectory, "unsafe.yaml"), [
      "control_plane:",
      `  tunnel_id: \"${TUNNEL_ONE}\"`,
      `  api_key: \"file:${keyFile}\"`,
      ""
    ].join("\n"), { mode: 0o600 });

    const discovery = discoverTunnelSetup({ environment: {}, profileDirectory });

    expect(discovery.candidates).toEqual([
      expect.objectContaining({
        tunnelId: TUNNEL_ONE,
        hasApiKey: false,
        apiKeySource: "none"
      })
    ]);
    expect(lstatSync(keyFile).mode & 0o777).toBe(0o644);
  });

  it("never imports an administrator key referenced by a profile", () => {
    const root = temporaryDirectory();
    const profileDirectory = path.join(root, "profiles");
    mkdirSync(profileDirectory, { mode: 0o700 });
    writeFileSync(path.join(profileDirectory, "admin.yaml"), [
      "control_plane:",
      `  tunnel_id: \"${TUNNEL_ONE}\"`,
      "  api_key: \"env:OPENAI_ADMIN_KEY\"",
      ""
    ].join("\n"), { mode: 0o600 });

    const discovery = discoverTunnelSetup({
      environment: { OPENAI_ADMIN_KEY: "sk-admin-12345678901234567890" },
      profileDirectory
    });

    expect(discovery.candidates[0]).toMatchObject({
      tunnelId: TUNNEL_ONE,
      hasApiKey: false,
      apiKeySource: "none"
    });
    expect(resolveTunnelSetupCandidate(discovery.candidates[0].id, {
      environment: { OPENAI_ADMIN_KEY: "sk-admin-12345678901234567890" },
      profileDirectory
    })?.apiKey).toBeUndefined();

    const disguisedAdmin = discoverTunnelSetup({
      environment: {
        CONTROL_PLANE_API_KEY: "sk-admin-12345678901234567890",
        CONTROL_PLANE_TUNNEL_ID: TUNNEL_TWO
      },
      profileDirectory: path.join(root, "missing")
    });
    expect(disguisedAdmin.candidates[0].hasApiKey).toBe(false);
  });
});

function temporaryDirectory(): string {
  return mkdtempSync(path.join(tmpdir(), "codex-tunnel-discovery-"));
}
