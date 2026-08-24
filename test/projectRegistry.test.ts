import { mkdtempSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PROJECT_DEFAULT_NOT_FOUND,
  PROJECT_CWD_INVALID,
  PROJECT_DUPLICATE_ID,
  PROJECT_DUPLICATE_PATH,
  PROJECT_ID_INVALID,
  PROJECT_ID_MAX_LENGTH,
  PROJECT_LABEL_INVALID,
  PROJECT_NOT_FOUND,
  PROJECT_REQUIRED,
  PROJECT_UNAVAILABLE,
  ProjectRegistry,
  legacyDefaultProject,
  normalizeProjectId,
  normalizeProjectLabel
} from "../src/projectRegistry.js";

describe("project registry", () => {
  it("normalizes bounded ASCII routing IDs independently from labels", () => {
    expect(normalizeProjectId("  Bridge_CORE  ")).toBe("bridge-core");
    expect(normalizeProjectId("API   Server---V2")).toBe("api-server-v2");
    expect(normalizeProjectId("ＡＰＩ＿2")).toBe("api-2");
    expect(() => normalizeProjectId("한글-project")).toThrow(PROJECT_ID_INVALID);
    expect(() => normalizeProjectId("project.name")).toThrow(PROJECT_ID_INVALID);
    expect(() => normalizeProjectId("a".repeat(PROJECT_ID_MAX_LENGTH + 1))).toThrow(
      PROJECT_ID_INVALID
    );
  });

  it("preserves normalized printable Unicode labels and counts code points", () => {
    expect(normalizeProjectLabel("  브리지 🛠️  ")).toBe("브리지 🛠️");
    expect(normalizeProjectLabel("Cafe\u0301")).toBe("Café");
    expect(() => normalizeProjectLabel("bad\nlabel")).toThrow(PROJECT_LABEL_INVALID);
    expect(() => normalizeProjectLabel("🙂".repeat(121))).toThrow(PROJECT_LABEL_INVALID);
  });

  it("canonicalizes allowed paths and rejects arbitrary, missing, or relative paths", () => {
    const root = temporaryDirectory("project-root-");
    const project = path.join(root, "workspace");
    const alias = path.join(root, "workspace-alias");
    const outside = temporaryDirectory("project-outside-");
    mkdirSync(project);
    symlinkSync(project, alias);

    const registry = new ProjectRegistry(
      [{ id: "Bridge Core", label: "브리지 코어", cwd: alias }],
      [root],
      { defaultProjectId: "BRIDGE_core" }
    );
    expect(registry.projects).toEqual([
      { id: "bridge-core", label: "브리지 코어", cwd: project }
    ]);
    expect(registry.defaultProjectId).toBe("bridge-core");
    expect(() => new ProjectRegistry(
      [{ id: "outside", label: "Outside", cwd: outside }],
      [root]
    )).toThrow(/outside allowed roots/);
    expect(() => new ProjectRegistry(
      [{ id: "missing", label: "Missing", cwd: path.join(root, "missing") }],
      [root]
    )).toThrow(/unavailable/);
    expect(() => new ProjectRegistry(
      [{ id: "relative", label: "Relative", cwd: "workspace" }],
      [root]
    )).toThrow(PROJECT_CWD_INVALID);
  });

  it("rejects IDs and canonical paths that collide after normalization", () => {
    const root = temporaryDirectory("project-root-");
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    const firstAlias = path.join(root, "first-alias");
    mkdirSync(first);
    mkdirSync(second);
    symlinkSync(first, firstAlias);

    expect(() => new ProjectRegistry([
      { id: "API Core", label: "One", cwd: first },
      { id: "api_core", label: "Two", cwd: second }
    ], [root])).toThrow(PROJECT_DUPLICATE_ID);
    expect(() => new ProjectRegistry([
      { id: "one", label: "One", cwd: first },
      { id: "two", label: "Two", cwd: firstAlias }
    ], [root])).toThrow(PROJECT_DUPLICATE_PATH);
  });

  it("resolves explicit, configured-default, and sole-project selections", () => {
    const root = temporaryDirectory("project-root-");
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    mkdirSync(first);
    mkdirSync(second);
    const projects = [
      { id: "first", label: "First", cwd: first },
      { id: "second", label: "Second", cwd: second }
    ];

    expect(new ProjectRegistry(projects, [root], {
      defaultProjectId: "second"
    }).resolve()).toMatchObject({ id: "second", cwd: second });
    expect(new ProjectRegistry([projects[0]!], [root]).resolve()).toMatchObject({ id: "first" });
    expect(() => new ProjectRegistry(projects, [root]).resolve()).toThrow(PROJECT_REQUIRED);
    expect(() => new ProjectRegistry(projects, [root]).resolve("unknown")).toThrow(
      PROJECT_NOT_FOUND
    );
    expect(() => new ProjectRegistry(projects, [root], {
      defaultProjectId: "unknown"
    })).toThrow(PROJECT_DEFAULT_NOT_FOUND);
  });

  it("retains unavailable metadata for recovery while excluding it from admission", () => {
    const allowed = temporaryDirectory("project-allowed-");
    const unavailable = temporaryDirectory("project-unavailable-");
    const registry = new ProjectRegistry([
      { id: "ready", label: "Ready", cwd: allowed },
      { id: "archive", label: "보관됨", cwd: unavailable }
    ], [allowed], {
      defaultProjectId: "ready",
      retainUnavailable: true
    });

    expect(registry.projects).toEqual([
      { id: "ready", label: "Ready", cwd: allowed },
      { id: "archive", label: "보관됨", cwd: unavailable }
    ]);
    expect(registry.selectableProjects.map(({ id }) => id)).toEqual(["ready"]);
    expect(registry.unavailableProjectIds).toEqual(["archive"]);
    expect(() => registry.resolve("archive")).toThrow(PROJECT_UNAVAILABLE);
    expect(registry.resolve()).toMatchObject({ id: "ready" });
  });

  it("creates a deterministic compatibility target without exposing a full path as identity", () => {
    expect(legacyDefaultProject("/work/브리지")).toEqual({
      id: "default",
      label: "브리지",
      cwd: "/work/브리지"
    });
  });

  it("returns defensive copies", () => {
    const root = temporaryDirectory("project-root-");
    const registry = new ProjectRegistry([
      { id: "default", label: "Original", cwd: root }
    ], [root]);
    const projects = registry.projects;
    projects[0]!.label = "Mutated";
    const availability = registry.availability;
    availability[0]!.project.label = "Also mutated";

    expect(registry.projects[0]!.label).toBe("Original");
  });
});

function temporaryDirectory(prefix: string): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}
