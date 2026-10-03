import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { BRIDGE_MCP_INSTRUCTIONS } from "../src/server.js";

describe("#221 ordinary and experimental profiles", () => {
  it("does not activate an experiment from a legacy Events flag", () => {
    const config = loadConfig({ CODEX_MCP_BRIDGE_NO_AUTH: "1", CODEX_MCP_BRIDGE_EVENTS_ENABLED: "1" });
    expect(config.eventsEnabled).toBe(false);
    expect(config.experimentalProfile).toBeUndefined();
    expect(config.noAuth).toBe(true);
  });
  it("requires both the explicit experimental profile and enable flag", () => {
    const profile = { CODEX_MCP_BRIDGE_NO_AUTH: "1", CODEX_MCP_BRIDGE_EXPERIMENTAL_PROFILE: "events" };
    expect(loadConfig(profile).eventsEnabled).toBe(false);
    expect(loadConfig({ ...profile, CODEX_MCP_BRIDGE_EVENTS_ENABLED: "1" }).eventsEnabled).toBe(true);
  });
  it("keeps common approval and exact-result authority without Events guidance", () => {
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain("canonical requestId");
    expect(BRIDGE_MCP_INSTRUCTIONS).toContain("reviewedVersion");
    expect(BRIDGE_MCP_INSTRUCTIONS).not.toMatch(/subscriptionRef|codex_event_access|webhook|opt in/i);
  });
});
