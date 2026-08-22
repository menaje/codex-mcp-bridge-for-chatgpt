import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ScopeResolver } from "../src/scopeResolver.js";
import { SCOPE_ID_PATTERN } from "../src/sessionRegistry.js";
import { BridgeStateStore } from "../src/stateStore.js";

describe("ScopeResolver", () => {
  it("derives one stable opaque UUID from the host identity tuple", () => {
    const resolver = new ScopeResolver({ secret: new Uint8Array(32).fill(7) });
    const metadata = {
      "openai/organization": "org-anonymous",
      "openai/subject": "subject-anonymous",
      "openai/session": "session-anonymous"
    };

    const first = resolver.resolve(metadata);
    const second = resolver.resolve({ ...metadata });
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      source: "host-metadata",
      keyVersion: 1,
      explicitInputIgnored: false
    });
    expect(first?.scopeId).toMatch(SCOPE_ID_PATTERN);
    expect(first?.scopeId.split("-")[2]?.startsWith("8")).toBe(true);
    expect(JSON.stringify(first)).not.toContain("session-anonymous");
    expect(JSON.stringify(first)).not.toContain("subject-anonymous");
    expect(JSON.stringify(first)).not.toContain("org-anonymous");
  });

  it("isolates changes to session, subject, or organization", () => {
    const resolver = new ScopeResolver({ secret: new Uint8Array(32).fill(9) });
    const base = {
      "openai/organization": "org-a",
      "openai/subject": "subject-a",
      "openai/session": "session-a"
    };
    const values = [
      resolver.resolve(base)?.scopeId,
      resolver.resolve({ ...base, "openai/session": "session-b" })?.scopeId,
      resolver.resolve({ ...base, "openai/subject": "subject-b" })?.scopeId,
      resolver.resolve({ ...base, "openai/organization": "org-b" })?.scopeId
    ];
    expect(new Set(values).size).toBe(values.length);
  });

  it("makes host metadata authoritative over a compatibility input", () => {
    const resolver = new ScopeResolver({ secret: new Uint8Array(32).fill(11) });
    const derived = resolver.resolve(
      { "openai/session": "host-session" },
      "11111111-1111-4111-8111-111111111111"
    );
    const withoutInput = resolver.resolve({ "openai/session": "host-session" });

    expect(derived?.scopeId).toBe(withoutInput?.scopeId);
    expect(derived).toMatchObject({ source: "host-metadata", explicitInputIgnored: true });
  });

  it("does not let widget-instance metadata split the conversation scope", () => {
    const resolver = new ScopeResolver({ secret: new Uint8Array(32).fill(12) });
    const modelCall = resolver.resolve({
      "openai/session": "shared-chat-session",
      "openai/subject": "shared-subject"
    });
    const widgetCall = resolver.resolve({
      "openai/session": "shared-chat-session",
      "openai/subject": "shared-subject",
      "openai/widgetSessionId": "mounted-widget-instance"
    });
    expect(widgetCall?.scopeId).toBe(modelCall?.scopeId);
  });

  it("uses an explicit UUID only as the no-metadata compatibility fallback", () => {
    const resolver = new ScopeResolver({ secret: new Uint8Array(32).fill(13) });
    expect(
      resolver.resolve(undefined, "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF")
    ).toMatchObject({
      scopeId: "abcdefab-cdef-4abc-8def-abcdefabcdef",
      source: "explicit-compatibility",
      explicitInputIgnored: false
    });
    expect(resolver.resolve(undefined)).toBeUndefined();
    expect(() => resolver.require(undefined, undefined, "Test operation")).toThrow(
      /requires ChatGPT conversation metadata or an explicit compatibility scopeId/
    );
  });

  it("rejects malformed host identifiers instead of silently changing scope", () => {
    const resolver = new ScopeResolver({ secret: new Uint8Array(32).fill(15) });
    expect(() => resolver.resolve({ "openai/session": "" })).toThrow(/non-empty bounded string/);
    expect(() => resolver.resolve({ "openai/session": 123 })).toThrow(/non-empty bounded string/);
    expect(() =>
      resolver.resolve({ "openai/session": "valid", "openai/subject": null })
    ).toThrow(/non-empty bounded string/);
  });

  it("persists only the HMAC key and keeps derived scopes stable across store restarts", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "bridge-scope-resolver-"));
    const file = path.join(directory, "state.sqlite");
    const metadata = {
      "openai/organization": "never-persist-org-98431",
      "openai/subject": "never-persist-subject-98431",
      "openai/session": "never-persist-session-98431"
    };
    const firstStore = new BridgeStateStore({ file });
    const first = new ScopeResolver({ stateStore: firstStore }).resolve(metadata);
    firstStore.close();

    const secondStore = new BridgeStateStore({ file });
    const second = new ScopeResolver({ stateStore: secondStore }).resolve(metadata);
    expect(second).toEqual(first);
    secondStore.close();

    const persistedBytes = [file, `${file}-wal`, `${file}-shm`]
      .filter(existsSync)
      .map((entry) => readFileSync(entry))
      .reduce((combined, value) => Buffer.concat([combined, value]), Buffer.alloc(0));
    expect(persistedBytes.includes(Buffer.from("never-persist-session-98431"))).toBe(false);
    expect(persistedBytes.includes(Buffer.from("never-persist-subject-98431"))).toBe(false);
    expect(persistedBytes.includes(Buffer.from("never-persist-org-98431"))).toBe(false);
  });

  it("fails closed instead of replacing an invalid persisted HMAC key", () => {
    const file = path.join(
      mkdtempSync(path.join(tmpdir(), "bridge-invalid-scope-key-")),
      "state.sqlite"
    );
    const store = new BridgeStateStore({ file });
    store.setMeta("scope_hmac_secret_v1", "not-a-valid-key");
    expect(() => new ScopeResolver({ stateStore: store })).toThrow(
      /Invalid persisted conversation-scope HMAC key/
    );
    expect(store.getMeta("scope_hmac_secret_v1")).toBe("not-a-valid-key");
    store.close();
  });
});
