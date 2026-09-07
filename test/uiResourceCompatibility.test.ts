import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { ACTIVITY_CARD_HTML } from "../src/activityCard.js";
import { DASHBOARD_CARD_HTML } from "../src/dashboardCard.js";
import { SETTINGS_CARD_HTML, uiBridgeErrorMessage } from "../src/settingsCard.js";
import { htmlForUiResource, uiResourceRevisions } from "../src/uiResources.js";

function functionsIn(html: string): Map<string, string> {
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
  const source = ts.createSourceFile("card.js", scripts.map((entry) => entry[1]).join("\n"),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const functions = new Map<string, string>();
  for (const node of source.statements) {
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node.getText(source));
  }
  return functions;
}

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
    it(`serves executable ${name} helpers across every retained revision`, () => {
      let exercised = 0;
      for (const revision of uiResourceRevisions(name).slice(1)) {
        const snapshot = readFileSync(new URL(`../ui-resources/${name}/${revision.digest}.html`, import.meta.url), "utf8");
        const html = htmlForUiResource(name, revision.uri, currentHtml);
        if (!snapshot.includes("__name(")) expect(html).toBe(snapshot);
        const functions = functionsIn(html);
        const helper = functions.get("__name") || "";
        if (snapshot.includes("__name(")) {
          expect(helper, revision.uri).not.toBe("");
          expect(html.replace(`\n${helper}\n`, ""), revision.uri).toBe(snapshot);
        }
        const errorFormatter = functions.get("uiBridgeErrorMessage");
        if (errorFormatter) {
          expect(runInNewContext(`${helper}\n${errorFormatter};uiBridgeErrorMessage({error:{code:'RETRY_REQUIRED',message:'Try again'}})`), revision.uri)
            .toBe("RETRY_REQUIRED: Try again");
          exercised++;
        }
        const nextExecution = functions.get("commonDashboardNextExecution");
        if (nextExecution) {
          const dependencies = ["dashboardExecutionsEqual", "shouldShowDashboardNextExecution"]
            .map((key) => functions.get(key) || "").join("\n");
          const execute = (rows: unknown[]) => runInNewContext(
            `${helper}\n${dependencies}\n${nextExecution};commonDashboardNextExecution(rows)`, { rows }
          );
          expect(execute([{}, {}]), revision.uri).toBeNull();
          const execution = { model: "example", reasoningEffort: "high", isCurrent: true };
          expect(execute([{ execution }, { execution }]), revision.uri).toEqual(execution);
          expect(execute([{ execution }, { execution: { ...execution, model: "other" } }]), revision.uri).toBeNull();
          exercised++;
        }
      }
      if (name !== "activity") expect(exercised).toBeGreaterThan(0);
    });
  }
});
