import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  RUNTIME_ENV_PROJECT_CONFLICT,
  assertRuntimeEnvOutsideProjectRoots
} from "../src/runtimeEnvProjectGuard.js";

describe("runtime dotenv project isolation", () => {
  it("rejects a runtime dotenv anywhere inside a registered project", () => {
    const root = mkdtempSync(path.join(tmpdir(), "codex-env-guard-"));
    const project = path.join(root, "project");
    const config = path.join(project, ".private");
    mkdirSync(config, { recursive: true });
    expect(() => assertRuntimeEnvOutsideProjectRoots(
      path.join(config, ".env"),
      [project]
    )).toThrow(RUNTIME_ENV_PROJECT_CONFLICT);
  });

  it("accepts an app-private dotenv beside, but not within, project roots", () => {
    const root = mkdtempSync(path.join(tmpdir(), "codex-env-guard-"));
    const project = path.join(root, "project");
    const config = path.join(root, "config");
    mkdirSync(project);
    mkdirSync(config);
    expect(() => assertRuntimeEnvOutsideProjectRoots(
      path.join(config, ".env"),
      [project]
    )).not.toThrow();
  });

  it("supports a fresh install before the private config directory exists", () => {
    const root = mkdtempSync(path.join(tmpdir(), "codex-env-guard-"));
    const project = path.join(root, "project");
    mkdirSync(project);
    expect(() => assertRuntimeEnvOutsideProjectRoots(
      path.join(root, "missing-config", "nested", ".env"),
      [project]
    )).not.toThrow();
  });

  it("resolves symlinked ancestors before comparing project boundaries", () => {
    const root = mkdtempSync(path.join(tmpdir(), "codex-env-guard-"));
    const project = path.join(root, "project");
    const linkedProject = path.join(root, "linked-project");
    mkdirSync(path.join(project, "private"), { recursive: true });
    symlinkSync(project, linkedProject);
    expect(() => assertRuntimeEnvOutsideProjectRoots(
      path.join(linkedProject, "private", ".env"),
      [project]
    )).toThrow(RUNTIME_ENV_PROJECT_CONFLICT);
  });
});
