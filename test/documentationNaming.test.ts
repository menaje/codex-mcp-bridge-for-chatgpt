import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CURRENT_PRODUCT = "Codex MCP Bridge for ChatGPT";
const CURRENT_REPOSITORY = "menaje/codex-mcp-bridge-for-chatgpt";
const CURRENT_PACKAGE = "codex-mcp-bridge-for-chatgpt";

describe("documentation naming", () => {
  it("uses the current public identity in the README and release guide", () => {
    const readme = read("README.md");
    const releasing = read("docs/releasing.md");

    for (const text of [readme, releasing]) {
      expect(text).toContain(CURRENT_PRODUCT);
      expect(text).toContain(CURRENT_REPOSITORY);
      expect(text).toContain(CURRENT_PACKAGE);
    }
    expect(readme.startsWith(`# ${CURRENT_PRODUCT}\n`)).toBe(true);
  });

  it("does not use an obsolete human-facing project name in current docs", () => {
    const currentDocs = ["README.md", ...markdownFiles("docs")];
    for (const file of currentDocs) {
      const text = read(file);
      expect(text, file).not.toMatch(/Codex MCP Bridge(?! for ChatGPT)/);
      expect(text, file).not.toMatch(/Codex Bridge(?! for ChatGPT)/);
      expect(text, file).not.toContain("MacBook Air");
      expect(text, file).not.toMatch(/github\.com\/menaje\/codex-mcp-bridge(?!-for-chatgpt)/);
    }
  });

  it("keeps the historical third-party name only in the upstream attribution", () => {
    expect(read("README.md")).not.toContain("DeepCogNeural/codex-gpt-bridge");
    expect(read("UPSTREAM.md")).toContain("DeepCogNeural/codex-gpt-bridge");
  });

  it("ships dotenv-only secure launcher credentials", () => {
    const packageJson = JSON.parse(read("package.json")) as {
      scripts?: Record<string, string>;
    };
    const scripts = packageJson.scripts ?? {};

    expect(Object.keys(scripts).some((name) => /keychain/i.test(name))).toBe(false);
    expect(Object.values(scripts).some((command) => /keychain/i.test(command))).toBe(false);
    expect(existsSync(path.join(ROOT, "scripts/start-secure-from-keychain.sh"))).toBe(false);

    for (const file of ["README.md", "docs/security.md", "docs/releasing.md"]) {
      expect(read(file), file).not.toMatch(/keychain/i);
    }
  });
});

function markdownFiles(directory: string): string[] {
  return readdirSync(path.join(ROOT, directory))
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => path.join(directory, entry));
}

function read(relative: string): string {
  return readFileSync(path.join(ROOT, relative), "utf8");
}
