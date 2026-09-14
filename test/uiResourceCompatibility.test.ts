import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { DASHBOARD_CARD_HTML } from "../src/dashboardCard.js";
import { SETTINGS_CARD_HTML, uiBridgeErrorMessage } from "../src/settingsCard.js";
import { UI_RESOURCE_MANIFEST } from "../src/uiManifest.generated.js";
import {
  currentUiResourceRevision,
  currentUiResourceUri,
  htmlForUiResource
} from "../src/uiResources.js";

describe("serialized card runtime compatibility", () => {
  it("executes the current Settings error formatter without compiler helpers", () => {
    expect(SETTINGS_CARD_HTML).not.toContain("__name(");
    const format = runInNewContext(`(${uiBridgeErrorMessage.toString()})`);
    expect(format({ error: { code: "PROJECT_UNAVAILABLE", message: "Try again" } }))
      .toBe("PROJECT_UNAVAILABLE: Try again");
    const circular: Record<string, unknown> = {};
    circular.error = circular;
    expect(format(circular, "fallback")).toBe("fallback");
  });

  for (const [name, currentHtml] of Object.entries({
    settings: SETTINGS_CARD_HTML, dashboard: DASHBOARD_CARD_HTML
  }) as Array<["settings" | "dashboard", string]>) {
    it(`serves the current ${name} resource file`, () => {
      const revision = currentUiResourceRevision(name);
      const currentFile = readCurrentFile(name);
      const rendered = htmlForUiResource(name, revision.uri, currentHtml);
      expect(currentFile, revision.uri).toBe(rendered);
      expect(rendered).toContain("<!doctype html>");
      expect(revision.uri).toBe(`ui://codex-mcp-bridge/${name}/v1.html`);
    });
  }

  it("keeps only Settings and Dashboard in the active resource manifest", () => {
    expect(Object.keys(UI_RESOURCE_MANIFEST.resources).sort()).toEqual(["dashboard", "settings"]);
  });

  it("keeps the Settings resource active", () => {
    expect(currentUiResourceUri("settings")).not.toContain("retired.html");
  });
});

function readCurrentFile(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../ui-resources/${name}.html`, import.meta.url)), "utf8");
}
