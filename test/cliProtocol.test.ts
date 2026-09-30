import { describe, expect, it } from "vitest";
import { inspectClientRequestContract, inspectCliProtocol, requireCliProtocol } from "../src/cliProtocol.js";
import contract from "./fixtures/app-server-request-contract.json";
import configContract from "./fixtures/app-server-config-contract.json";
import path from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

describe("CLI operation contracts", () => {
  it("bounds an unresponsive schema generator that ignores graceful termination", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "schema-timeout-test-"));
    const command = path.join(directory, "codex");
    writeFileSync(command, "#!/usr/bin/env node\nprocess.on('SIGTERM',()=>{});setInterval(()=>{},1000);\n", { mode: 0o700 });
    try {
      await expect(inspectCliProtocol(command, process.env, { timeoutMs: 150 })).rejects.toThrow("CODEX_PROTOCOL_UNVERIFIED");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("accepts additive schema changes without a version or whole-schema allowlist", () => {
    const future = structuredClone(contract);
    (future as Record<string, unknown>).futureMetadata = { version: "999.0.0" };
    expect(inspectClientRequestContract(future)).toMatchObject({ compatible: true, unsupported: {} });
  });

  it("rejects a CLI that accepts arbitrary config but cannot apply connector approvals", () => {
    const missing = structuredClone(configContract) as any;
    delete missing.properties.config.properties.apps.properties._default.properties.default_tools_approval_mode;
    expect(inspectClientRequestContract(contract, missing)).toMatchObject({ compatible: false,
      missingCore: ["config.apps._default.default_tools_approval_mode"] });
    const unsupported = structuredClone(configContract);
    unsupported.properties.config.properties.apps.properties._default.properties.default_tools_approval_mode.enum = ["auto"];
    expect(inspectClientRequestContract(contract, unsupported).compatible).toBe(false);
    expect(inspectClientRequestContract(contract, configContract).compatible).toBe(true);
  });

  it("reports fork support separately and rejects it before execution", async () => {
    const support = await inspectCliProtocol(path.resolve("test/fixtures/fake-codex-app-server.mjs"), {
      ...process.env, CODEX_TEST_MISSING_METHOD: "thread/fork"
    });
    expect(support.compatible).toBe(true);
    expect(support.capabilities.supportsFork).toBe(false);
    expect(() => requireCliProtocol(support, "fresh")).not.toThrow();
    expect(() => requireCliProtocol(support, "fork")).toThrow("thread/fork");
  });

  it.each(["sandbox", "approvalPolicy", "approvalsReviewer", "config", "cwd"])("rejects a CLI missing the resume %s field", field => {
    const changed = structuredClone(contract) as any;
    delete changed.oneOf.find((entry: any) => entry.properties.method.enum[0] === "thread/resume").properties.params.properties[field];
    const support = inspectClientRequestContract(changed);
    expect(support.compatible).toBe(false);
    expect(support.missingCore).toContain(`thread/resume.${field}`);
  });

  it("rejects changed required inputs, even when the method and known fields still exist", () => {
    const changed = structuredClone(contract) as any;
    const start = changed.oneOf.find((entry: any) => entry.properties.method.enum[0] === "thread/start").properties.params;
    start.required = [...(start.required || []), "newRequiredField"];
    start.properties.newRequiredField = { type: "string" };
    expect(inspectClientRequestContract(changed).missingCore).toContain("thread/start (input contract)");
  });
});
