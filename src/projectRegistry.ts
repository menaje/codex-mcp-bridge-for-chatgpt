import path from "node:path";
import { requireAllowedCwd } from "./config.js";

export const PROJECT_NAME_MAX_LENGTH = 120;
/** @deprecated Internal compatibility alias. Project names replace labels. */
export const PROJECT_LABEL_MAX_LENGTH = PROJECT_NAME_MAX_LENGTH;
export const MAX_REGISTERED_PROJECTS = 100;

export const PROJECT_SETUP_REQUIRED = "PROJECT_SETUP_REQUIRED";
export const PROJECT_REQUIRED = "PROJECT_REQUIRED";
export const PROJECT_NOT_FOUND = "PROJECT_NOT_FOUND";
export const PROJECT_UNAVAILABLE = "PROJECT_UNAVAILABLE";
export const PROJECT_REGISTRY_CHANGED = "PROJECT_REGISTRY_CHANGED";
export const PROJECT_REGISTRY_REVISION_CONFLICT = "PROJECT_REGISTRY_REVISION_CONFLICT";
export const PROJECT_ID_INVALID = "PROJECT_ID_INVALID";
export const PROJECT_NAME_INVALID = "PROJECT_NAME_INVALID";
/** @deprecated Internal compatibility alias. */
export const PROJECT_LABEL_INVALID = PROJECT_NAME_INVALID;
export const PROJECT_CWD_INVALID = "PROJECT_CWD_INVALID";
export const PROJECT_CWD_NOT_ALLOWED = "PROJECT_CWD_NOT_ALLOWED";
export const PROJECT_NAME_CONFLICT = "PROJECT_NAME_CONFLICT";
export const PROJECT_CWD_CONFLICT = "PROJECT_CWD_CONFLICT";
export const PROJECT_CWD_STILL_PINNED = "PROJECT_CWD_STILL_PINNED";
export const PROJECT_LIMIT_EXCEEDED = "PROJECT_LIMIT_EXCEEDED";
export const PROJECT_CONTEXT_CONFLICT = "PROJECT_CONTEXT_CONFLICT";
export const PROJECT_ARCHIVED = "PROJECT_ARCHIVED";
export const PROJECT_OPERATION_CONFLICT = "PROJECT_OPERATION_CONFLICT";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORBIDDEN_PROJECT_NAME_CODE_POINT = /[\p{Cc}\p{Cs}\p{Bidi_Control}\p{Default_Ignorable_Code_Point}]/u;
const UNICODE_WHITESPACE = /\p{White_Space}+/gu;

/** Internal-only immutable project record. UUID and cwd must never enter model-facing output. */
export type ProjectTarget = {
  id: string;
  name: string;
  /** Internal compatibility spelling for audit snapshots. Always equals name. */
  label: string;
  nameKey: string;
  cwd: string;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
};

export type ProjectSelection = {
  name: string;
  registryRevision: number;
};

export type ProjectAvailability = {
  project: ProjectTarget;
  available: boolean;
  unavailableReason?: string;
};

export type ProjectRegistrySnapshot = {
  registryRevision: number;
  updatedAt: number;
  projects: ProjectTarget[];
};

export type ProjectRegistryOperation =
  | { kind: "add"; project: { name: string; cwd: string } }
  | { kind: "rename"; projectId: string; name: string }
  | { kind: "relocate"; projectId: string; cwd: string }
  | { kind: "archive"; projectId: string }
  | { kind: "restore"; projectId: string; name?: string; cwd?: string }
  | { kind: "reorder"; projectIds: string[] };

export type ProjectRegistryOptions = {
  /** Retain a saved canonical path when it is temporarily unavailable. */
  retainUnavailable?: boolean;
};

/** Validate the server-generated immutable project UUID. */
export function normalizeProjectId(value: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error(`${PROJECT_ID_INVALID}: Invalid internal project identity.`);
  }
  return value.toLowerCase();
}

/** Canonical user-visible project name used by add, rename, restore, and lookup. */
export function normalizeProjectName(value: string): string {
  if (typeof value !== "string") {
    throw new Error(`${PROJECT_NAME_INVALID}: Expected a project name string.`);
  }
  rejectForbiddenProjectNameCodePoints(value);
  const normalized = value.normalize("NFC");
  rejectForbiddenProjectNameCodePoints(normalized);
  const canonical = normalized.replace(UNICODE_WHITESPACE, " ").trim();
  rejectForbiddenProjectNameCodePoints(canonical);
  if (!canonical || Array.from(canonical).length > PROJECT_NAME_MAX_LENGTH) {
    throw new Error(
      `${PROJECT_NAME_INVALID}: Use 1-${PROJECT_NAME_MAX_LENGTH} visible Unicode characters.`
    );
  }
  return canonical;
}

/**
 * Locale-independent Unicode NFKC case folding.
 *
 * ECMAScript does not expose Unicode CaseFolding.txt directly. Per-code-point
 * upper/lower closure implements the full mappings (including expansions such
 * as sharp-s and final sigma); dotless-i and Cherokee are the Unicode-defined
 * exceptions where the case-fold representative is not that closure.
 */
export function projectNameKey(value: string): string {
  const canonical = normalizeProjectName(value).normalize("NFKC");
  const folded = Array.from(canonical, (character) => {
    if (character === "\u0131") return character;
    if (character === "\u1e9e") return "ss";
    const codePoint = character.codePointAt(0) as number;
    if (
      (codePoint >= 0x13a0 && codePoint <= 0x13ff) ||
      (codePoint >= 0xab70 && codePoint <= 0xabbf)
    ) {
      return character.toUpperCase();
    }
    return character.toUpperCase().toLowerCase();
  }).join("");
  return folded.normalize("NFKC");
}

/** @deprecated Internal compatibility alias. */
export const normalizeProjectLabel = normalizeProjectName;

export function canonicalProjectCwd(
  input: string,
  allowedRoots: readonly string[]
): string {
  if (typeof input !== "string" || !path.isAbsolute(input) || /[\r\n\0]/u.test(input)) {
    throw new Error(`${PROJECT_CWD_INVALID}: Project cwd must be an absolute folder path.`);
  }
  try {
    return requireAllowedCwd(input, [...allowedRoots]);
  } catch {
    throw new Error(
      `${PROJECT_CWD_NOT_ALLOWED}: Project cwd must be an existing, canonical, allowed folder.`
    );
  }
}

/** Immutable view over a revisioned registry snapshot. */
export class ProjectRegistry {
  private readonly entries: ProjectAvailability[];

  constructor(
    projects: readonly ProjectTarget[],
    private readonly allowedRoots: readonly string[],
    readonly registryRevision = 0,
    options: ProjectRegistryOptions = {}
  ) {
    if (!Array.isArray(projects)) throw new Error("Invalid projects: expected an array.");
    if (projects.length > MAX_REGISTERED_PROJECTS) {
      throw new Error(
        `${PROJECT_LIMIT_EXCEEDED}: At most ${MAX_REGISTERED_PROJECTS} projects may be registered.`
      );
    }
    const activeNames = new Set<string>();
    const activeCwds = new Set<string>();
    const ids = new Set<string>();
    this.entries = projects
      .map((input, index) => validateProjectTarget(input, index))
      .sort((left, right) => left.sortOrder - right.sortOrder || left.createdAt - right.createdAt)
      .map((project) => {
        if (ids.has(project.id)) throw new Error(`${PROJECT_ID_INVALID}: Duplicate project identity.`);
        ids.add(project.id);
        if (project.archivedAt === undefined) {
          if (activeNames.has(project.nameKey)) {
            throw new Error(`${PROJECT_NAME_CONFLICT}: Active project names must be unique.`);
          }
          if (activeCwds.has(project.cwd)) {
            throw new Error(`${PROJECT_CWD_CONFLICT}: Active project folders must be unique.`);
          }
          activeNames.add(project.nameKey);
          activeCwds.add(project.cwd);
        }
        let available = false;
        let unavailableReason: string | undefined;
        try {
          available = canonicalProjectCwd(project.cwd, this.allowedRoots) === project.cwd;
          if (!available) {
            unavailableReason = "The saved folder no longer resolves canonically.";
            if (!options.retainUnavailable && project.archivedAt === undefined) {
              throw new Error(`${PROJECT_UNAVAILABLE}: ${unavailableReason}`);
            }
          }
        } catch (error) {
          if (!options.retainUnavailable && project.archivedAt === undefined) throw error;
          unavailableReason = error instanceof Error ? error.message : String(error);
        }
        return {
          project,
          available: project.archivedAt === undefined && available,
          ...(unavailableReason ? { unavailableReason } : {})
        };
      });
  }

  get projects(): ProjectTarget[] {
    return this.entries.map(({ project }) => ({ ...project }));
  }

  get availability(): ProjectAvailability[] {
    return this.entries.map((entry) => ({ ...entry, project: { ...entry.project } }));
  }

  get selectableProjects(): ProjectTarget[] {
    return this.entries
      .filter((entry) => entry.available && entry.project.archivedAt === undefined)
      .map(({ project }) => ({ ...project }));
  }

  get unavailableProjectIds(): string[] {
    return this.entries
      .filter((entry) => entry.project.archivedAt === undefined && !entry.available)
      .map(({ project }) => project.id);
  }

  resolve(selection?: ProjectSelection): ProjectTarget {
    const active = this.entries.filter((entry) => entry.project.archivedAt === undefined);
    if (active.length === 0) {
      throw new Error(
        `${PROJECT_SETUP_REQUIRED}: Register a project folder in Codex settings before starting new work.`
      );
    }
    if (!selection) {
      throw new Error(
        `${PROJECT_REQUIRED}: Select an exact current project name and registry revision before starting new work.`
      );
    }
    if (
      !Number.isInteger(selection.registryRevision) ||
      selection.registryRevision < 0 ||
      selection.registryRevision !== this.registryRevision
    ) {
      throw new Error(
        `${PROJECT_REGISTRY_CHANGED}: Project choices changed. Refresh the tool descriptor and retry.`
      );
    }
    const key = projectNameKey(selection.name);
    const matches = active.filter(({ project }) => project.nameKey === key);
    if (matches.length !== 1) {
      throw new Error(`${PROJECT_NOT_FOUND}: No active project has that exact normalized name.`);
    }
    const entry = matches[0] as ProjectAvailability;
    if (!entry.available) {
      throw new Error(
        `${PROJECT_UNAVAILABLE}: The selected project folder is unavailable. Check it in Codex settings.`
      );
    }
    return { ...entry.project };
  }
}

function rejectForbiddenProjectNameCodePoints(value: string): void {
  if (FORBIDDEN_PROJECT_NAME_CODE_POINT.test(value)) {
    throw new Error(
      `${PROJECT_NAME_INVALID}: Control, surrogate, invisible, and bidirectional formatting characters are not allowed.`
    );
  }
}

function validateProjectTarget(value: ProjectTarget, index: number): ProjectTarget {
  if (!value || typeof value !== "object") throw new Error(`Invalid project at index ${index}.`);
  const id = normalizeProjectId(value.id);
  const name = normalizeProjectName(value.name ?? value.label);
  const nameKey = projectNameKey(name);
  if (value.nameKey !== undefined && value.nameKey !== nameKey) {
    throw new Error(`${PROJECT_NAME_INVALID}: Stored project name key is not canonical.`);
  }
  if (typeof value.cwd !== "string" || !path.isAbsolute(value.cwd) || /[\r\n\0]/u.test(value.cwd)) {
    throw new Error(`${PROJECT_CWD_INVALID}: Stored project cwd must be absolute.`);
  }
  if (!Number.isInteger(value.sortOrder) || value.sortOrder < 0) {
    throw new Error("Invalid project sort order.");
  }
  if (!Number.isFinite(value.createdAt) || !Number.isFinite(value.updatedAt)) {
    throw new Error("Invalid project timestamps.");
  }
  if (value.archivedAt !== undefined && !Number.isFinite(value.archivedAt)) {
    throw new Error("Invalid project archive timestamp.");
  }
  return {
    id,
    name,
    label: name,
    nameKey,
    cwd: path.normalize(value.cwd),
    sortOrder: value.sortOrder,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.archivedAt === undefined ? {} : { archivedAt: value.archivedAt })
  };
}
