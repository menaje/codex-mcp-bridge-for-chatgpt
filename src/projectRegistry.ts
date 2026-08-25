import path from "node:path";
import { requireAllowedCwd } from "./config.js";

export const PROJECT_ID_MAX_LENGTH = 64;
export const PROJECT_LABEL_MAX_LENGTH = 120;
export const MAX_REGISTERED_PROJECTS = 100;

export const PROJECT_SETUP_REQUIRED = "PROJECT_SETUP_REQUIRED";
export const PROJECT_REQUIRED = "PROJECT_REQUIRED";
export const PROJECT_NOT_FOUND = "PROJECT_NOT_FOUND";
export const PROJECT_UNAVAILABLE = "PROJECT_UNAVAILABLE";
export const PROJECT_ID_INVALID = "PROJECT_ID_INVALID";
export const PROJECT_LABEL_INVALID = "PROJECT_LABEL_INVALID";
export const PROJECT_CWD_INVALID = "PROJECT_CWD_INVALID";
export const PROJECT_CWD_NOT_ALLOWED = "PROJECT_CWD_NOT_ALLOWED";
export const PROJECT_DUPLICATE_ID = "PROJECT_DUPLICATE_ID";
export const PROJECT_DUPLICATE_PATH = "PROJECT_DUPLICATE_PATH";
export const PROJECT_LIMIT_EXCEEDED = "PROJECT_LIMIT_EXCEEDED";
export const PROJECT_DEFAULT_NOT_FOUND = "PROJECT_DEFAULT_NOT_FOUND";
export const PROJECT_CONTEXT_CONFLICT = "PROJECT_CONTEXT_CONFLICT";

export type ProjectTarget = {
  /** Stable, normalized ASCII routing key exposed to GPT. */
  id: string;
  /** Human-facing Unicode display name. */
  label: string;
  /** Canonical absolute path when the target is available. */
  cwd: string;
};

export type ProjectAvailability = {
  project: ProjectTarget;
  available: boolean;
  unavailableReason?: string;
};

export type ProjectRegistryOptions = {
  defaultProjectId?: string | null;
  /**
   * Preserve structurally valid absolute paths that cannot currently be
   * admitted. This is intended only for loading previously saved settings so
   * an operator root change or temporarily missing folder remains recoverable.
   */
  retainUnavailable?: boolean;
};

/**
 * Normalize a user-supplied project key into a bounded GPT-facing identifier.
 * Labels are deliberately kept separate so renaming a project never changes
 * this routing identity.
 */
export function normalizeProjectId(value: string): string {
  if (typeof value !== "string") {
    throw new Error(`${PROJECT_ID_INVALID}: Expected a string project ID.`);
  }
  const normalized = value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/gu, "-")
    .replace(/-+/g, "-");
  if (
    normalized.length === 0 ||
    normalized.length > PROJECT_ID_MAX_LENGTH ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)
  ) {
    throw new Error(
      `${PROJECT_ID_INVALID}: Use 1-${PROJECT_ID_MAX_LENGTH} lowercase ASCII letters or digits separated by hyphens.`
    );
  }
  return normalized;
}

/** Normalize display text without restricting natural-language labels. */
export function normalizeProjectLabel(value: string): string {
  if (typeof value !== "string") {
    throw new Error(`${PROJECT_LABEL_INVALID}: Expected a string project label.`);
  }
  const normalized = value.normalize("NFC").trim();
  if (
    normalized.length === 0 ||
    Array.from(normalized).length > PROJECT_LABEL_MAX_LENGTH ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)
  ) {
    throw new Error(
      `${PROJECT_LABEL_INVALID}: Use 1-${PROJECT_LABEL_MAX_LENGTH} printable Unicode characters.`
    );
  }
  return normalized;
}

/**
 * A validated immutable view over saved projects. Strict construction is used
 * for writes; recovery construction is used only for persisted settings.
 */
export class ProjectRegistry {
  private readonly entries: ProjectAvailability[];
  private readonly selectedDefaultProjectId: string | null;
  private readonly allowedRoots: string[];

  constructor(
    projects: readonly ProjectTarget[],
    allowedRoots: readonly string[],
    options: ProjectRegistryOptions = {}
  ) {
    if (!Array.isArray(projects)) {
      throw new Error("Invalid projects: expected an array.");
    }
    if (projects.length > MAX_REGISTERED_PROJECTS) {
      throw new Error(
        `${PROJECT_LIMIT_EXCEEDED}: At most ${MAX_REGISTERED_PROJECTS} projects may be registered.`
      );
    }
    this.allowedRoots = allowedRoots.map((root) => {
      if (!path.isAbsolute(root) || /[\r\n\0]/u.test(root)) {
        throw new Error("Allowed project roots must be absolute paths.");
      }
      // Explicit roots are retained only for backwards-compatible operator
      // restrictions. A normal installation passes an empty list and uses the
      // project registry itself as the sole source of working folders.
      return path.normalize(root);
    });
    const seenIds = new Set<string>();
    const seenPaths = new Set<string>();
    this.entries = projects.map((input, index) => {
      if (!isProjectTarget(input)) {
        throw new Error(`Invalid project at index ${index}.`);
      }
      const id = normalizeProjectId(input.id);
      const label = normalizeProjectLabel(input.label);
      if (seenIds.has(id)) {
        throw new Error(`${PROJECT_DUPLICATE_ID}: Duplicate project ID: ${id}`);
      }
      seenIds.add(id);

      if (!path.isAbsolute(input.cwd) || /[\r\n\0]/u.test(input.cwd)) {
        throw new Error(
          `${PROJECT_CWD_INVALID}: Project "${id}" must use an absolute cwd.`
        );
      }
      let cwd = input.cwd;
      let unavailableReason: string | undefined;
      try {
        cwd = requireAllowedCwd(input.cwd, [...this.allowedRoots]);
      } catch (error) {
        if (!options.retainUnavailable) {
          throw new Error(
            `${PROJECT_CWD_NOT_ALLOWED}: Project "${id}" must point to an available folder: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        unavailableReason = error instanceof Error ? error.message : String(error);
      }

      const pathKey = unavailableReason === undefined
        ? cwd
        : path.normalize(input.cwd);
      if (seenPaths.has(pathKey)) {
        throw new Error(`${PROJECT_DUPLICATE_PATH}: Duplicate project cwd: ${input.cwd}`);
      }
      seenPaths.add(pathKey);
      return {
        project: { id, label, cwd },
        available: unavailableReason === undefined,
        ...(unavailableReason === undefined ? {} : { unavailableReason })
      };
    });

    const requestedDefault = options.defaultProjectId ?? null;
    this.selectedDefaultProjectId = requestedDefault === null
      ? this.entries.length === 1 ? this.entries[0]!.project.id : null
      : normalizeProjectId(requestedDefault);
    if (
      this.selectedDefaultProjectId !== null &&
      !seenIds.has(this.selectedDefaultProjectId)
    ) {
      throw new Error(
        `${PROJECT_DEFAULT_NOT_FOUND}: Default project does not exist: ${this.selectedDefaultProjectId}`
      );
    }
  }

  get projects(): ProjectTarget[] {
    return this.entries.map(({ project }) => ({ ...project }));
  }

  get defaultProjectId(): string | null {
    return this.selectedDefaultProjectId;
  }

  get availability(): ProjectAvailability[] {
    return this.entries.map((entry) => ({
      ...entry,
      project: { ...entry.project }
    }));
  }

  get selectableProjects(): ProjectTarget[] {
    return this.entries
      .filter((entry) => entry.available)
      .map(({ project }) => ({ ...project }));
  }

  get unavailableProjectIds(): string[] {
    return this.entries
      .filter((entry) => !entry.available)
      .map(({ project }) => project.id);
  }

  get effectiveDefaultProjectId(): string | null {
    if (this.selectedDefaultProjectId !== null) return this.selectedDefaultProjectId;
    return this.entries.length === 1 ? this.entries[0]?.project.id || null : null;
  }

  resolve(projectId?: string): ProjectTarget {
    if (this.entries.length === 0) {
      throw new Error(
        `${PROJECT_SETUP_REQUIRED}: Register a project folder in Codex settings before starting new work.`
      );
    }
    const selectedId = projectId === undefined
      ? this.effectiveDefaultProjectId
      : normalizeProjectId(projectId);
    if (selectedId === null) {
      throw new Error(
        `${PROJECT_REQUIRED}: Select a registered project before starting new work.`
      );
    }
    const entry = this.entries.find(({ project }) => project.id === selectedId);
    if (!entry) {
      throw new Error(`${PROJECT_NOT_FOUND}: Unknown project ID: ${selectedId}`);
    }
    if (!entry.available) {
      throw new Error(
        `${PROJECT_UNAVAILABLE}: Project "${selectedId}" folder is unavailable. Check or update it in Codex settings.`
      );
    }
    return { ...entry.project };
  }
}

/** Deterministic compatibility target for the former single-default setting. */
export function legacyDefaultProject(cwd: string): ProjectTarget {
  if (!path.isAbsolute(cwd)) {
    throw new Error(`${PROJECT_CWD_INVALID}: Legacy default cwd must be absolute.`);
  }
  const rawLabel = path.basename(path.normalize(cwd)) || "Default project";
  const printableLabel = rawLabel
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .trim() || "Default project";
  return {
    id: "default",
    label: normalizeProjectLabel(Array.from(printableLabel).slice(0, PROJECT_LABEL_MAX_LENGTH).join("")),
    cwd
  };
}

function isProjectTarget(value: unknown): value is ProjectTarget {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.label === "string" &&
    typeof candidate.cwd === "string"
  );
}
