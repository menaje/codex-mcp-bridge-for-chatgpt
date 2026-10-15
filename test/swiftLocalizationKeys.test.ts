import { describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { swiftLocalizationReferences } from "../scripts/swift-localization-keys.mjs";

const keys = (source: string, locals: string[] = []) =>
  swiftLocalizationReferences(source, locals).map(({ key }: {key: string}) => key);

describe("native localization reference validation", () => {
  it("fails the real catalog check for the old mapping and accepts its corrected key", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "bridge-localization-regression-"));
    try {
      for (const file of [
        "scripts/check-macos-localizations.mjs", "scripts/swift-localization-keys.mjs", "scripts/text-integrity.mjs",
        "locales/catalog.json", "macos/Resources/Localization/Localizable.xcstrings", "macos/Info.plist"
      ]) {
        const destination = path.join(directory, file);
        mkdirSync(path.dirname(destination), {recursive: true});
        copyFileSync(file, destination);
      }
      const fixture = path.join(directory, "macos/Sources/CodexBridgeMenuBar/DashboardViews.swift");
      mkdirSync(path.dirname(fixture), {recursive: true});
      const mapping = (key: string) => `func target() -> String {
        let key: String
        switch targetKind { case "activity": key = "${key}"; default: key = "cancellation.target.job" }
        return BridgeAppLocalization.string(key, locale: locale)
      }`;
      const check = () => spawnSync(process.execPath, [path.join(directory, "scripts/check-macos-localizations.mjs")], {encoding: "utf8"});
      writeFileSync(fixture, mapping("Activity"));
      const rejected = check();
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain('missing localization key: "Activity"');
      writeFileSync(fixture, mapping("cancellation.target.activity"));
      const accepted = check();
      expect(accepted.status, accepted.stderr).toBe(0);
    } finally {
      rmSync(directory, {recursive: true, force: true});
    }
  });

  it("detects the missing Activity key in an indirect cancellation mapping", () => {
    expect(keys(`
      func target(_ value: String) -> String {
        let key: String
        switch value {
        case "activity": key = "Activity"
        case "job": key = "cancellation.target.job"
        default: return value
        }
        return BridgeAppLocalization.string(key, locale: locale)
      }
    `)).toEqual(["Activity", "cancellation.target.job"]);
  });

  it("checks aliases and nested assignments without treating unrelated keys as localization", () => {
    expect(keys(`
      func cache() { let key = "not-a-localization-key"; save(key) }
      func target() -> String {
        let key: String
        if flag { key = "cancellation.target.activity" } else { key = "missing.key" }
        let titleKey = key
        return BridgeAppLocalization.string(titleKey, locale: locale)
      }
    `)).toEqual(["cancellation.target.activity", "missing.key"]);
  });

  it("keeps a shadowed local key separate from the enclosing localization key", () => {
    expect(keys(`
      func title() -> String {
        let key = "dashboard.problems"
        if flag { let key = "private-cache-key"; save(key) }
        return BridgeAppLocalization.string(key, locale: locale)
      }
    `)).toEqual(["dashboard.problems"]);
  });

  it("checks direct lookups, formats, wrappers and conditional results", () => {
    expect(keys(`
      BridgeAppLocalization.string("missing.direct", locale: locale)
      BridgeAppLocalization.format("missing.format", locale: locale, value)
      localized("missing.wrapper")
      BridgeAppLocalization.string(bucket == "idle" ? "macos.latestrun" : "macos.run", locale: locale)
    `, ["localized"])).toEqual([
      "missing.direct", "missing.format", "missing.wrapper", "macos.latestrun", "macos.run"
    ]);
  });

  it("ignores code in comments and arbitrary string values", () => {
    expect(keys(`
      // BridgeAppLocalization.string("comment.key", locale: locale)
      /* let key = "comment.indirect"; BridgeAppLocalization.string(key, locale: locale) */
      let diagnostic = "Activity"
      let text = "BridgeAppLocalization.string(\\"example.key\\", locale: locale)"
    `)).toEqual([]);
  });
});
