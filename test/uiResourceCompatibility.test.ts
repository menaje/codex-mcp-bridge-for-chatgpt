import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { ACTIVITY_CARD_HTML } from "../src/activityCard.js";
import { DASHBOARD_CARD_HTML } from "../src/dashboardCard.js";
import { SETTINGS_CARD_HTML, uiBridgeErrorMessage } from "../src/settingsCard.js";
import { htmlForUiResource, uiResourceRevisions } from "../src/uiResources.js";

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
    settings: SETTINGS_CARD_HTML, activity: ACTIVITY_CARD_HTML, dashboard: DASHBOARD_CARD_HTML
  }) as Array<["settings" | "activity" | "dashboard", string]>) {
    it(`serves only the current ${name} resource revision`, () => {
      const revisions = uiResourceRevisions(name);
      expect(revisions).toHaveLength(1);
      const [revision] = revisions;
      const snapshot = readSnapshot(name, revision!.digest);
      const rendered = htmlForUiResource(name, revision!.uri, currentHtml);
      expect(snapshot, revision!.uri).toBe(rendered);
      expect(rendered).toContain("<!doctype html>");
    });
  }

  it("does not register retained historical resource identities", () => {
    for (const name of ["settings", "activity", "dashboard", "question"] as const) {
      expect(uiResourceRevisions(name).every((entry) =>
        entry.releaseProvenance.inventories.includes("development-current")
      )).toBe(true);
    }
  });
});

function readSnapshot(name: string, digest: string): string {
  const directory = fileURLToPath(new URL(`../ui-resources/${name}/`, import.meta.url));
  const plain = path.join(directory, `${digest}.html`);
  if (existsSync(plain)) return readFileSync(plain, "utf8");
  return Buffer.from(readFileSync(`${plain}.base64`, "utf8").trim(), "base64").toString("utf8");
}
