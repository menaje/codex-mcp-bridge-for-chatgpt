import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { describe, expect, it } from "vitest";
import { DASHBOARD_CARD_HTML } from "../src/dashboardCard.js";
import { RELAY_CARD_HTML } from "../src/relayCard.js";
import { SETTINGS_CARD_HTML, uiBridgeErrorMessage } from "../src/settingsCard.js";
import { UI_RESOURCE_MANIFEST } from "../src/uiManifest.generated.js";
import { serializeUiFunction } from "../src/uiFunctionSerialization.js";
import { uiJsonTextIsWellFormed } from "../src/uiHostToolResult.js";
import { settingsSpeedChoices, settingsSpeedSelection } from "../src/processingSpeedPresentation.js";
import { executionSpeedBadge } from "../src/executionPresentation.js";
import {
  currentUiResourceRevision,
  currentUiResourceUri,
  htmlForUiResource
} from "../src/uiResources.js";

describe("serialized card runtime compatibility", () => {
  it("serializes text-integrity checks identically in the source runner and compiled runtime", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/uiHostToolResult.ts", import.meta.url)), "utf8");
    const compiled: Record<string, Function> = {};
    const { outputText } = transpileModule(source, {
      compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS }
    });
    runInNewContext(outputText, { exports: compiled });
    expect(serializeUiFunction(compiled.uiJsonTextIsWellFormed!))
      .toBe(serializeUiFunction(uiJsonTextIsWellFormed));
  });

  it("keeps all serialized card helpers free of compiler helpers", () => {
    for (const html of [SETTINGS_CARD_HTML, DASHBOARD_CARD_HTML, RELAY_CARD_HTML]) {
      expect(html).not.toContain("__name(");
    }
    const format = runInNewContext(`(${uiBridgeErrorMessage.toString()})`);
    expect(format({ error: { code: "PROJECT_UNAVAILABLE", message: "Try again" } }))
      .toBe("PROJECT_UNAVAILABLE: Try again");
    const circular: Record<string, unknown> = {};
    circular.error = circular;
    expect(format(circular, "fallback")).toBe("fallback");
  });

  it("serializes emoji speed badges identically in source and compiled cards", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/executionPresentation.ts", import.meta.url)), "utf8");
    const compiled: Record<string, Function> = {};
    const { outputText } = transpileModule(source, {
      compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS }
    });
    runInNewContext(outputText, { exports: compiled });
    expect(serializeUiFunction(compiled.executionSpeedBadge!)).toBe(serializeUiFunction(executionSpeedBadge));
    const badge = runInNewContext(`(${serializeUiFunction(compiled.executionSpeedBadge!)})`);
    expect(badge({ processingSpeed: "fast" })).toBe("⚡");
    expect(badge({ processingSpeed: "ultrafast" })).toBe("🚀");
    expect(badge({ processingSpeed: "fast" }, true)).toBe("⚡ Fast");
    expect(badge({ processingSpeed: "ultrafast" }, true)).toBe("🚀 Ultrafast");
  });

  it("keeps the speed picker projection identical in source and compiled cards", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/processingSpeedPresentation.ts", import.meta.url)), "utf8");
    const compiled: Record<string, Function> = {};
    const { outputText } = transpileModule(source, {
      compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS }
    });
    runInNewContext(outputText, { exports: compiled });
    expect(serializeUiFunction(compiled.settingsSpeedChoices!)).toBe(serializeUiFunction(settingsSpeedChoices));
    expect(serializeUiFunction(compiled.settingsSpeedSelection!)).toBe(serializeUiFunction(settingsSpeedSelection));
  });

  for (const [name, currentHtml] of Object.entries({
    settings: SETTINGS_CARD_HTML,
    dashboard: DASHBOARD_CARD_HTML,
    relay: RELAY_CARD_HTML
  }) as Array<["settings" | "dashboard" | "relay", string]>) {
    it(`serves the current ${name} resource file`, () => {
      const revision = currentUiResourceRevision(name);
      const currentFile = readCurrentFile(name);
      const rendered = htmlForUiResource(name, revision.uri, currentHtml);
      expect(currentFile, revision.uri).toBe(rendered);
      expect(rendered).toContain("<!doctype html>");
      expect(revision.uri).toBe(
        `ui://codex-mcp-bridge/${name}/v${name === "settings" ? 6 : name === "dashboard" ? 5 : 1}.html`
      );
    });
  }

  it("keeps Settings, Dashboard and Relay in the active resource manifest", () => {
    expect(Object.keys(UI_RESOURCE_MANIFEST.resources).sort()).toEqual([
      "dashboard", "relay", "settings"
    ]);
  });

  it("keeps the Settings resource active", () => {
    expect(currentUiResourceUri("settings")).not.toContain("retired.html");
  });
});

function readCurrentFile(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../ui-resources/${name}.html`, import.meta.url)), "utf8");
}
