import { mkdtempSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_REGISTERED_PROJECTS,
  PROJECT_CWD_CONFLICT,
  PROJECT_ID_INVALID,
  PROJECT_LIMIT_EXCEEDED,
  PROJECT_NAME_CONFLICT,
  PROJECT_NAME_INVALID,
  PROJECT_NOT_FOUND,
  PROJECT_REGISTRY_CHANGED,
  PROJECT_REQUIRED,
  PROJECT_SETUP_REQUIRED,
  PROJECT_UNAVAILABLE,
  ProjectRegistry,
  canonicalProjectCwd,
  normalizeProjectId,
  normalizeProjectName,
  projectNameKey,
  type ProjectTarget
} from "../src/projectRegistry.js";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const REF_A = "prj_AAAAAAAAAAAAAAAAAAAAAA";
const REF_B = "prj_BBBBBBBBBBBBBBBBBBBBBB";

describe("project registry", () => {
  it("accepts only internal UUID identities and never derives them from names", () => {
    expect(normalizeProjectId(UUID_A.toUpperCase())).toBe(UUID_A);
    for (const legacy of ["default", "bridge", "Bridge Core", "/tmp/project"]) {
      expect(() => normalizeProjectId(legacy)).toThrow(PROJECT_ID_INVALID);
    }
  });

  it("canonicalizes display names and rejects control, invisible, surrogate, and bidi input", () => {
    expect(normalizeProjectName("  Cafe\u0301\u00a0\u00a0프로젝트  ")).toBe("Café 프로젝트");
    expect(normalizeProjectName("  Mixed   Case  ")).toBe("Mixed Case");
    for (const unsafe of [
      "bad\nname",
      "zero\u200bwidth",
      "bidi\u202ename",
      `surrogate${String.fromCharCode(0xd800)}`,
      "\u2066isolated\u2069"
    ]) {
      expect(() => normalizeProjectName(unsafe)).toThrow(PROJECT_NAME_INVALID);
    }
    expect(() => normalizeProjectName("\u00a0\u00a0")).toThrow(PROJECT_NAME_INVALID);
    expect(() => normalizeProjectName("가".repeat(121))).toThrow(PROJECT_NAME_INVALID);
  });

  it("uses locale-independent NFKC case folding for uniqueness and lookup", () => {
    expect(projectNameKey("Ｓｔｒａßｅ")).toBe(projectNameKey("STRASSE"));
    expect(projectNameKey("\u212aelvin")).toBe(projectNameKey("kelvin"));
    expect(projectNameKey("  Alpha\u00a0Project ")).toBe(projectNameKey("alpha project"));
  });

  it("uses an opaque ref and per-project generation while retaining legacy resolution", () => {
    const root = temporaryDirectory("project-registry-");
    const registry = new ProjectRegistry([project(UUID_A, "Codex Bridge", root)], [root], 7);

    expect(registry.resolve({
      name: "Codex Bridge",
      projectRef: REF_A,
      projectRevision: 1
    })).toMatchObject({
      id: UUID_A,
      projectRef: REF_A,
      projectRevision: 1,
      name: "Codex Bridge",
      cwd: root
    });
    expect(registry.resolve({ name: "codex bridge", registryRevision: 7 })).toMatchObject({
      id: UUID_A,
      name: "Codex Bridge",
      cwd: root
    });
    expect(() => registry.resolve()).toThrow(PROJECT_REQUIRED);
    expect(() => registry.resolve({ name: "Codex Bridge", registryRevision: 6 }))
      .toThrow(PROJECT_REGISTRY_CHANGED);
    expect(() => registry.resolve({
      name: "Codex Bridge",
      projectRef: REF_A,
      projectRevision: 2
    })).toThrow(PROJECT_REGISTRY_CHANGED);
    expect(() => registry.resolve({
      name: "Renamed",
      projectRef: REF_A,
      projectRevision: 1
    })).toThrow(PROJECT_REGISTRY_CHANGED);
    expect(() => registry.resolve({
      name: "Codex Bridge",
      projectRef: REF_B,
      projectRevision: 1
    })).toThrow(PROJECT_NOT_FOUND);
    expect(() => registry.resolve({ name: "Codex", registryRevision: 7 }))
      .toThrow(PROJECT_NOT_FOUND);
    expect(() => registry.resolve({ name: "default", registryRevision: 7 }))
      .toThrow(PROJECT_NOT_FOUND);
    expect(() => new ProjectRegistry([], [], 0).resolve()).toThrow(PROJECT_SETUP_REQUIRED);
  });

  it("rejects active name/cwd collisions and enforces the registry bound", () => {
    const first = temporaryDirectory("project-first-");
    const second = temporaryDirectory("project-second-");
    expect(() => new ProjectRegistry([
      project(UUID_A, "Ｓｅｒｖｉｃｅ", first, 0),
      project(UUID_B, "service", second, 1)
    ], [], 1)).toThrow(PROJECT_NAME_CONFLICT);
    expect(() => new ProjectRegistry([
      project(UUID_A, "One", first, 0),
      project(UUID_B, "Two", first, 1)
    ], [], 1)).toThrow(PROJECT_CWD_CONFLICT);
    expect(() => new ProjectRegistry(
      Array.from({ length: MAX_REGISTERED_PROJECTS + 1 }, (_, index) =>
        project(uuidFor(index), `Project ${index}`, first, index)
      ),
      [],
      1
    )).toThrow(PROJECT_LIMIT_EXCEEDED);
  });

  it("requires stored paths to retain their canonical identity", () => {
    const root = temporaryDirectory("project-root-");
    const workspace = path.join(root, "workspace");
    const alias = path.join(root, "alias");
    mkdirSync(workspace);
    symlinkSync(workspace, alias);

    expect(canonicalProjectCwd(alias, [root])).toBe(realpathSync(workspace));
    expect(() => new ProjectRegistry([
      project(UUID_A, "Alias", alias)
    ], [root], 1)).toThrow(PROJECT_UNAVAILABLE);
    const retained = new ProjectRegistry([
      project(UUID_A, "Alias", alias)
    ], [root], 1, { retainUnavailable: true });
    expect(retained.selectableProjects).toEqual([]);
    expect(() => retained.resolve({ name: "Alias", registryRevision: 1 }))
      .toThrow(PROJECT_UNAVAILABLE);
  });

  it("excludes archived projects while retaining immutable recovery metadata", () => {
    const root = temporaryDirectory("project-active-");
    const registry = new ProjectRegistry([
      project(UUID_A, "Active", root),
      { ...project(UUID_B, "Archived", "/missing", 1), archivedAt: 10 }
    ], [root], 4, { retainUnavailable: true });

    expect(registry.projects.map(({ id }) => id)).toEqual([UUID_A, UUID_B]);
    expect(registry.selectableProjects.map(({ id }) => id)).toEqual([UUID_A]);
    expect(() => registry.resolve({ name: "Archived", registryRevision: 4 }))
      .toThrow(PROJECT_NOT_FOUND);
  });

  it("returns defensive copies", () => {
    const root = temporaryDirectory("project-copy-");
    const registry = new ProjectRegistry([project(UUID_A, "Original", root)], [root], 1);
    registry.projects[0]!.name = "Mutated";
    registry.availability[0]!.project.name = "Also mutated";
    expect(registry.projects[0]!.name).toBe("Original");
  });
});

function project(
  id: string,
  name: string,
  cwd: string,
  sortOrder = 0
): ProjectTarget {
  return {
    id,
    projectRef: id === UUID_A ? REF_A : id === UUID_B ? REF_B : projectRefFor(sortOrder),
    projectRevision: 1,
    name,
    label: name,
    nameKey: projectNameKey(name),
    cwd,
    sortOrder,
    createdAt: sortOrder + 1,
    updatedAt: sortOrder + 1
  };
}

function projectRefFor(index: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const marker = alphabet[index % alphabet.length] as string;
  return `prj_${marker.repeat(22)}`;
}

function uuidFor(index: number): string {
  const suffix = String(index + 1).padStart(12, "0");
  return `00000000-0000-4000-8000-${suffix}`;
}

function temporaryDirectory(prefix: string): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}
