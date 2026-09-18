import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkUiResources,
  copyUiResourcesToDist,
  loadReleaseManifest,
  syncUiResources
} from "../scripts/release-manifest.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("single-file UI resource lifecycle", () => {
  it("overwrites one file per card, removes legacy snapshots, and packages only current files", () => {
    const root = mkdtempSync(path.join(tmpdir(), "codex-ui-resources-"));
    try {
      const manifest = structuredClone(loadReleaseManifest(REPO_ROOT));
      copyJson("ui-release-catalog.json", root);
      mkdirSync(path.join(root, "scripts"), { recursive: true });
      mkdirSync(path.join(root, "src"), { recursive: true });
      symlinkSync(
        path.join(REPO_ROOT, "node_modules"),
        path.join(root, "node_modules"),
        process.platform === "win32" ? "junction" : "dir"
      );
      writeDescriptorSource(root);
      writeRenderer(root, "initial");

      for (const [name, suffix] of [
        ["settings", ".html"],
        ["activity", ".html.base64"],
        ["question", ".html"]
      ] as const) {
        const directory = path.join(root, "ui-resources", name);
        mkdirSync(directory, { recursive: true });
        writeFileSync(path.join(directory, `${"a".repeat(64)}${suffix}`), "legacy", "utf8");
      }

      const initial = syncUiResources(root, manifest);
      expect(initial.resources.settings.uri).toBe("ui://codex-mcp-bridge/settings/v2.html");
      expect(initial.resources.dashboard.uri).toBe("ui://codex-mcp-bridge/dashboard/v2.html");
      expect(sourceFiles(root)).toEqual(["dashboard.html", "settings.html"]);
      expect(packagedFiles(root)).toEqual(["dashboard.html", "settings.html"]);
      expect(checkUiResources(root, manifest)).toEqual(initial);

      writeRenderer(root, "updated");
      const updated = syncUiResources(root, manifest);
      expect(updated.resources.settings.uri).toBe(initial.resources.settings.uri);
      expect(updated.resources.dashboard.uri).toBe(initial.resources.dashboard.uri);
      expect(updated.resources.settings.digest).not.toBe(initial.resources.settings.digest);
      expect(updated.resources.dashboard.digest).not.toBe(initial.resources.dashboard.digest);
      expect(sourceFiles(root)).toEqual(["dashboard.html", "settings.html"]);
      expect(packagedFiles(root)).toEqual(["dashboard.html", "settings.html"]);
      expect(readFileSync(path.join(root, "ui-resources", "settings.html"), "utf8"))
        .toContain("settings-updated");

      writeFileSync(path.join(root, "ui-resources", "settings.html"), "tampered", "utf8");
      expect(() => checkUiResources(root, manifest)).toThrow(/settings current HTML/);
      syncUiResources(root, manifest);

      const legacyDirectory = path.join(root, "ui-resources", "dashboard");
      mkdirSync(legacyDirectory);
      writeFileSync(path.join(legacyDirectory, `${"b".repeat(64)}.html`), "legacy", "utf8");
      expect(() => checkUiResources(root, manifest)).toThrow(/ui-resources file inventory/);
      syncUiResources(root, manifest);
      expect(sourceFiles(root)).toEqual(["dashboard.html", "settings.html"]);

      expect(copyUiResourcesToDist(root)).toEqual(updated);
      expect(packagedFiles(root)).toEqual(["dashboard.html", "settings.html"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function writeRenderer(root: string, marker: string): void {
  const resources = Object.fromEntries(["settings", "dashboard"].map((name) => [
    name,
    {
      uri: `ui://codex-mcp-bridge/${name}/v2.html`,
      html: `<!doctype html><html><body>${name}-${marker}</body></html>`,
      metadata: {
        descriptor: {
          title: `${name} card`,
          description: `${name} card`,
          mimeType: "text/html;profile=mcp-app"
        },
        content: { "codex/uiContractGeneration": 99 }
      }
    }
  ]));
  writeFileSync(
    path.join(root, "scripts", "render-ui-resources.ts"),
    `process.stdout.write(${JSON.stringify(JSON.stringify({ resources }))});\n`,
    "utf8"
  );
}

function writeDescriptorSource(root: string): void {
  writeFileSync(
    path.join(root, "src", "tools.ts"),
    [
      'const SETTINGS_CARD_URI = "ui://codex-mcp-bridge/settings/v2.html";',
      'const DASHBOARD_CARD_URI = "ui://codex-mcp-bridge/dashboard/v2.html";',
      'const settings = { ui: { resourceUri: SETTINGS_CARD_URI }, "openai/outputTemplate": SETTINGS_CARD_URI };',
      'const dashboard = { ui: { resourceUri: DASHBOARD_CARD_URI }, "openai/outputTemplate": DASHBOARD_CARD_URI };'
    ].join("\n"),
    "utf8"
  );
}

function copyJson(relative: string, root: string): void {
  writeFileSync(
    path.join(root, relative),
    readFileSync(path.join(REPO_ROOT, relative), "utf8"),
    "utf8"
  );
}

function sourceFiles(root: string): string[] {
  return readdirSync(path.join(root, "ui-resources")).sort();
}

function packagedFiles(root: string): string[] {
  return readdirSync(path.join(root, "dist", "ui")).sort();
}
