import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import * as z from "zod/v4";

const execFileAsync = promisify(execFile);

export type CodexReasoningEffort = {
  effort: string;
  description?: string;
};

export type CodexModelDescriptor = {
  id: string;
  displayName: string;
  description?: string;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts: CodexReasoningEffort[];
  supportedInApi?: boolean;
};

export type CodexModelCatalogSnapshot = {
  source: "codex-cli";
  fetchedAt: string;
  cached: boolean;
  stale: boolean;
  models: CodexModelDescriptor[];
  warning?: string;
};

export type ModelCatalogOptions = {
  refresh?: boolean;
};

export type CodexModelCatalogProvider = {
  getCatalog(options?: ModelCatalogOptions): Promise<CodexModelCatalogSnapshot>;
};

type CatalogData = Omit<CodexModelCatalogSnapshot, "cached" | "stale" | "warning">;
type CatalogCommand = (command: string, args: string[], timeoutMs: number) => Promise<string>;
type PersistedCatalog = { version: 1; fetchedAt: string; raw: string };

const rawEffortSchema = z
  .object({
    effort: z.string().trim().min(1).max(100),
    description: z.string().trim().min(1).optional()
  })
  .passthrough();

const rawModelSchema = z
  .object({
    slug: z.string().trim().min(1).max(200),
    display_name: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1).optional(),
    default_reasoning_level: z.string().trim().min(1).optional().nullable(),
    supported_reasoning_levels: z.array(rawEffortSchema).default([]),
    visibility: z.string().optional(),
    supported_in_api: z.boolean().optional()
  })
  .passthrough();

const rawCatalogSchema = z
  .object({
    models: z.array(rawModelSchema)
  })
  .passthrough();

export class CodexCliModelCatalog implements CodexModelCatalogProvider {
  private cached?: { data: CatalogData; expiresAt: number };
  private refreshing?: Promise<CatalogData>;

  constructor(
    private readonly codexCommand: string,
    private readonly cacheTtlMs = 10 * 60 * 1000,
    private readonly timeoutMs = 30 * 1000,
    private readonly runCatalogCommand: CatalogCommand = runCodexCatalogCommand,
    private readonly now: () => number = Date.now,
    private readonly stateFile?: string
  ) {
    this.loadPersistedCache();
  }

  async getCatalog(options: ModelCatalogOptions = {}): Promise<CodexModelCatalogSnapshot> {
    const now = this.now();
    if (!options.refresh && this.cached && this.cached.expiresAt > now) {
      return {
        ...this.cached.data,
        cached: true,
        stale: false
      };
    }

    try {
      const data = await this.refresh();
      return {
        ...data,
        cached: false,
        stale: false
      };
    } catch (error) {
      if (this.cached) {
        return {
          ...this.cached.data,
          cached: true,
          stale: true,
          warning: `Could not refresh the Codex model catalog; using the last successful result. ${errorMessage(error)}`
        };
      }
      throw new Error(`Could not load the Codex model catalog. ${errorMessage(error)}`);
    }
  }

  private async refresh(): Promise<CatalogData> {
    if (!this.refreshing) {
      this.refreshing = this.fetchCatalog().finally(() => {
        this.refreshing = undefined;
      });
    }
    return this.refreshing;
  }

  private async fetchCatalog(): Promise<CatalogData> {
    const stdout = await this.runCatalogCommand(this.codexCommand, ["debug", "models"], this.timeoutMs);
    const models = parseCodexModelCatalog(stdout);
    const fetchedAtMs = this.now();
    const data: CatalogData = {
      source: "codex-cli",
      fetchedAt: new Date(fetchedAtMs).toISOString(),
      models
    };
    this.cached = {
      data,
      expiresAt: fetchedAtMs + this.cacheTtlMs
    };
    this.persistCache({ version: 1, fetchedAt: data.fetchedAt, raw: stdout });
    return data;
  }

  private loadPersistedCache(): void {
    if (!this.stateFile || !existsSync(this.stateFile)) return;
    try {
      if (statSync(this.stateFile).size > 5 * 1024 * 1024) return;
      const parsed = JSON.parse(readFileSync(this.stateFile, "utf8")) as unknown;
      if (!isPersistedCatalog(parsed)) return;
      const fetchedAtMs = Date.parse(parsed.fetchedAt);
      if (!Number.isFinite(fetchedAtMs)) return;
      this.cached = {
        data: {
          source: "codex-cli",
          fetchedAt: parsed.fetchedAt,
          models: parseCodexModelCatalog(parsed.raw)
        },
        expiresAt: fetchedAtMs + this.cacheTtlMs
      };
    } catch {
      // A stale or corrupt cache must never prevent the bridge from starting.
    }
  }

  private persistCache(catalog: PersistedCatalog): void {
    if (!this.stateFile) return;
    try {
      const directory = path.dirname(this.stateFile);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temporary = `${this.stateFile}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(catalog)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, this.stateFile);
      chmodSync(this.stateFile, 0o600);
    } catch {
      // The live catalog remains usable even if persistence is unavailable.
    }
  }
}

export function parseCodexModelCatalog(raw: string): CodexModelDescriptor[] {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("Codex returned invalid JSON for its model catalog.");
  }

  const parsed = rawCatalogSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error("Codex returned an unsupported model catalog format.");
  }

  const seenModels = new Set<string>();
  const models: CodexModelDescriptor[] = [];
  for (const model of parsed.data.models) {
    if (model.visibility !== "list" || seenModels.has(model.slug)) {
      continue;
    }
    seenModels.add(model.slug);

    const seenEfforts = new Set<string>();
    const supportedReasoningEfforts = model.supported_reasoning_levels.filter((entry) => {
      if (seenEfforts.has(entry.effort)) return false;
      seenEfforts.add(entry.effort);
      return true;
    });

    models.push({
      id: model.slug,
      displayName: model.display_name || model.slug,
      description: model.description,
      defaultReasoningEffort: model.default_reasoning_level || undefined,
      supportedReasoningEfforts,
      supportedInApi: model.supported_in_api
    });
  }

  if (models.length === 0) {
    throw new Error("Codex did not return any selectable models.");
  }
  return models;
}

async function runCodexCatalogCommand(command: string, args: string[], timeoutMs: number): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 5 * 1024 * 1024
  });
  return stdout;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPersistedCatalog(value: unknown): value is PersistedCatalog {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    value.version === 1 &&
    "fetchedAt" in value &&
    typeof value.fetchedAt === "string" &&
    "raw" in value &&
    typeof value.raw === "string"
  );
}
