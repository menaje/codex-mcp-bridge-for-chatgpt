import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
import type { CodexBackendKind } from "./config.js";

const execFileAsync = promisify(execFile);

export type CodexReasoningEffort = {
  effort: string;
  description?: string;
};

export type CodexModelServiceTier = {
  id: string;
  name: string;
  description?: string;
};

export type CodexModelDescriptor = {
  id: string;
  catalogId?: string;
  displayName: string;
  description?: string;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts: CodexReasoningEffort[];
  hidden?: boolean;
  isDefault?: boolean;
  upgrade?: string;
  upgradeInfo?: Record<string, unknown>;
  supportsPersonality?: boolean;
  defaultServiceTier?: string;
  serviceTiers: CodexModelServiceTier[];
  inputModalities: string[];
  supportedInApi?: boolean;
};

export type CodexModelCatalogSnapshot = {
  source: "app-server" | "codex-cli";
  fetchedAt: string;
  validatedAt: string;
  fingerprint: string;
  cached: boolean;
  stale: boolean;
  validation: "valid" | "temporarily-unverified-with-last-known-good";
  models: CodexModelDescriptor[];
  warning?: string;
};

export type ModelCatalogChangedEvent = {
  backendKind: CodexBackendKind;
  previousFingerprint?: string;
  snapshot: CodexModelCatalogSnapshot;
};

export type ModelCatalogListener = (
  event: ModelCatalogChangedEvent
) => void | Promise<void>;

export type ModelCatalogOptions = {
  refresh?: boolean;
  backendKind?: CodexBackendKind;
};

export type CodexModelCatalogProvider = {
  getCatalog(options?: ModelCatalogOptions): Promise<CodexModelCatalogSnapshot>;
  getCachedCatalog?(options?: Pick<ModelCatalogOptions, "backendKind">): CodexModelCatalogSnapshot | undefined;
  subscribe?(listener: ModelCatalogListener): () => void;
};

type CatalogData = Omit<CodexModelCatalogSnapshot, "cached" | "stale" | "validation" | "warning">;
type CatalogCommand = (command: string, args: string[], timeoutMs: number) => Promise<string>;
type PersistedCatalog = { version: 1; fetchedAt: string; raw: string };

const rawEffortSchema = z
  .object({
    effort: z.string().trim().min(1).max(100),
    description: z.string().trim().min(1).optional()
  })
  .passthrough();

const rawUpgradeSchema = z
  .object({
    model: z.string().trim().min(1).max(200),
    migration_markdown: z.string().trim().min(1).optional()
  })
  .passthrough();

const rawModelSchema = z
  .object({
    slug: z.string().trim().min(1).max(200),
    display_name: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1).optional(),
    default_reasoning_level: z.string().trim().min(1).optional().nullable(),
    supported_reasoning_levels: z.array(rawEffortSchema).default([]),
    priority: z.number().optional(),
    default_service_tier: z.string().trim().min(1).optional().nullable(),
    service_tiers: z.array(
      z.object({
        id: z.string().trim().min(1).max(100),
        name: z.string().trim().min(1).max(200),
        description: z.string().trim().min(1).optional()
      }).passthrough()
    ).default([]),
    input_modalities: z.array(z.string().trim().min(1).max(100)).default([]),
    visibility: z.string().optional(),
    upgrade: z.union([
      z.string().trim().min(1).max(200),
      rawUpgradeSchema
    ]).optional().nullable(),
    upgrade_info: z.record(z.string(), z.unknown()).optional().nullable(),
    supports_personality: z.boolean().optional(),
    supported_in_api: z.boolean().optional()
  })
  .passthrough();

const rawCatalogSchema = z
  .object({
    models: z.array(rawModelSchema)
  })
  .passthrough();

const appEffortSchema = z.object({
  reasoningEffort: z.string().trim().min(1).max(100),
  description: z.string().trim().optional()
}).passthrough();

const appServiceTierSchema = z.object({
  id: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().optional()
}).passthrough();

const appModelSchema = z.object({
  id: z.string().trim().min(1).max(200),
  model: z.string().trim().min(1).max(200),
  displayName: z.string().trim().min(1).max(200),
  description: z.string().default(""),
  defaultReasoningEffort: z.string().trim().min(1).max(100),
  supportedReasoningEfforts: z.array(appEffortSchema),
  hidden: z.boolean(),
  isDefault: z.boolean(),
  upgrade: z.string().trim().min(1).max(200).optional().nullable(),
  upgradeInfo: z.record(z.string(), z.unknown()).optional().nullable(),
  supportsPersonality: z.boolean().optional(),
  defaultServiceTier: z.string().trim().min(1).optional().nullable(),
  serviceTiers: z.array(appServiceTierSchema).default([]),
  inputModalities: z.array(z.string().trim().min(1).max(100)).default(["text", "image"])
}).passthrough();

const appCatalogSchema = z.object({ data: z.array(appModelSchema) }).passthrough();

export class CodexCliModelCatalog implements CodexModelCatalogProvider {
  private cached?: { data: CatalogData; expiresAt: number };
  private refreshing?: Promise<CatalogData>;
  private readonly listeners = new Set<ModelCatalogListener>();

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
        stale: false,
        validation: "valid"
      };
    }

    try {
      const data = await this.refresh();
      return {
        ...data,
        cached: false,
        stale: false,
        validation: "valid"
      };
    } catch (error) {
      if (this.cached) {
        return {
          ...this.cached.data,
          cached: true,
          stale: true,
          validation: "temporarily-unverified-with-last-known-good",
          warning: `Could not refresh the Codex model catalog; using the last successful result. ${errorMessage(error)}`
        };
      }
      throw new Error(`Could not load the Codex model catalog. ${errorMessage(error)}`);
    }
  }

  getCachedCatalog(): CodexModelCatalogSnapshot | undefined {
    if (!this.cached) return undefined;
    const stale = this.cached.expiresAt <= this.now();
    return {
      ...this.cached.data,
      cached: true,
      stale,
      validation: stale ? "temporarily-unverified-with-last-known-good" : "valid"
    };
  }

  subscribe(listener: ModelCatalogListener): () => void {
    this.listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.listeners.delete(listener);
    };
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
      validatedAt: new Date(fetchedAtMs).toISOString(),
      fingerprint: modelCatalogFingerprint(models),
      models
    };
    const previousFingerprint = this.cached?.data.fingerprint;
    this.cached = {
      data,
      expiresAt: fetchedAtMs + this.cacheTtlMs
    };
    this.persistCache({ version: 1, fetchedAt: data.fetchedAt, raw: stdout });
    if (previousFingerprint !== data.fingerprint) {
      emitCatalogChanged(this.listeners, {
        backendKind: "mcp-server",
        ...(previousFingerprint ? { previousFingerprint } : {}),
        snapshot: {
          ...data,
          cached: false,
          stale: false,
          validation: "valid"
        }
      });
    }
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
      const models = parseCodexModelCatalog(parsed.raw);
      this.cached = {
        data: {
          source: "codex-cli",
          fetchedAt: parsed.fetchedAt,
          validatedAt: parsed.fetchedAt,
          fingerprint: modelCatalogFingerprint(models),
          models
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
  const selectable = parsed.data.models
    .filter((model) => model.visibility === "list")
    .sort((left, right) => (left.priority ?? Number.MAX_SAFE_INTEGER) - (right.priority ?? Number.MAX_SAFE_INTEGER));
  for (const model of selectable) {
    if (seenModels.has(model.slug)) {
      continue;
    }
    seenModels.add(model.slug);

    const seenEfforts = new Set<string>();
    const supportedReasoningEfforts = model.supported_reasoning_levels.filter((entry) => {
      if (seenEfforts.has(entry.effort)) return false;
      seenEfforts.add(entry.effort);
      return true;
    });
    const upgrade = typeof model.upgrade === "string"
      ? model.upgrade
      : model.upgrade?.model;
    const upgradeInfo = model.upgrade_info ||
      (model.upgrade && typeof model.upgrade === "object" ? model.upgrade : undefined);

    models.push({
      id: model.slug,
      catalogId: model.slug,
      displayName: model.display_name || model.slug,
      description: model.description,
      defaultReasoningEffort: model.default_reasoning_level || undefined,
      supportedReasoningEfforts,
      hidden: false,
      isDefault: models.length === 0,
      upgrade,
      upgradeInfo,
      supportsPersonality: model.supports_personality,
      defaultServiceTier: model.default_service_tier || undefined,
      serviceTiers: model.service_tiers,
      inputModalities: model.input_modalities,
      supportedInApi: model.supported_in_api
    });
  }

  if (models.length === 0) {
    throw new Error("Codex did not return any selectable models.");
  }
  return models;
}

export function parseAppServerModelCatalog(value: unknown): CodexModelDescriptor[] {
  const parsed = appCatalogSchema.safeParse(value);
  if (!parsed.success) throw new Error("Codex App Server returned an unsupported model catalog format.");
  const seen = new Set<string>();
  const models = parsed.data.data.flatMap((model) => {
    if (model.hidden || seen.has(model.model)) return [];
    seen.add(model.model);
    return [{
      id: model.model,
      catalogId: model.id,
      displayName: model.displayName || model.model,
      ...(model.description ? { description: model.description } : {}),
      defaultReasoningEffort: model.defaultReasoningEffort,
      supportedReasoningEfforts: model.supportedReasoningEfforts.map((entry) => ({
        effort: entry.reasoningEffort,
        ...(entry.description ? { description: entry.description } : {})
      })),
      hidden: model.hidden,
      isDefault: model.isDefault,
      ...(model.upgrade ? { upgrade: model.upgrade } : {}),
      ...(model.upgradeInfo ? { upgradeInfo: model.upgradeInfo } : {}),
      ...(model.supportsPersonality !== undefined ? { supportsPersonality: model.supportsPersonality } : {}),
      defaultServiceTier: model.defaultServiceTier || undefined,
      serviceTiers: model.serviceTiers,
      inputModalities: model.inputModalities
    } satisfies CodexModelDescriptor];
  });
  if (models.length === 0) throw new Error("Codex App Server did not return any selectable models.");
  return models;
}

type AppServerCatalogLoader = () => Promise<unknown>;

export class BackendAwareModelCatalog implements CodexModelCatalogProvider {
  private appCached?: { snapshot: CodexModelCatalogSnapshot; expiresAt: number };
  private appFallbackWarning?: string;
  private readonly listeners = new Set<ModelCatalogListener>();
  private readonly lastKnownGoodFingerprints = new Map<CodexBackendKind, string>();

  constructor(
    private readonly defaultBackend: CodexBackendKind,
    private readonly cliCatalog: CodexModelCatalogProvider,
    private readonly loadAppServerCatalog: AppServerCatalogLoader,
    private readonly cacheTtlMs = 10 * 60 * 1000,
    private readonly now: () => number = Date.now
  ) {
    const cliCached = this.cliCatalog.getCachedCatalog?.({ backendKind: "mcp-server" });
    if (cliCached) {
      this.lastKnownGoodFingerprints.set("mcp-server", cliCached.fingerprint);
    }
    this.cliCatalog.subscribe?.((event) => {
      this.noteLastKnownGood(event.backendKind, event.snapshot);
    });
  }

  async getCatalog(options: ModelCatalogOptions = {}): Promise<CodexModelCatalogSnapshot> {
    const backendKind = options.backendKind || this.defaultBackend;
    if (backendKind !== "app-server") {
      const snapshot = await this.cliCatalog.getCatalog(options);
      this.noteLastKnownGood(backendKind, snapshot);
      return snapshot;
    }
    const now = this.now();
    if (!options.refresh && this.appCached && this.appCached.expiresAt > now) {
      const stale = Boolean(this.appFallbackWarning);
      return {
        ...this.appCached.snapshot,
        cached: true,
        stale,
        validation: stale ? "temporarily-unverified-with-last-known-good" : "valid",
        ...(this.appFallbackWarning ? { warning: this.appFallbackWarning } : {})
      };
    }
    try {
      const models = parseAppServerModelCatalog(await this.loadAppServerCatalog());
      const fetchedAt = new Date(now).toISOString();
      const snapshot: CodexModelCatalogSnapshot = {
        source: "app-server",
        fetchedAt,
        validatedAt: fetchedAt,
        fingerprint: modelCatalogFingerprint(models),
        cached: false,
        stale: false,
        validation: "valid",
        models
      };
      this.appCached = { snapshot, expiresAt: now + this.cacheTtlMs };
      this.appFallbackWarning = undefined;
      this.noteLastKnownGood("app-server", snapshot);
      return snapshot;
    } catch (error) {
      if (this.appCached) {
        this.appFallbackWarning =
          `Could not refresh the App Server model catalog; using the last successful result. ${errorMessage(error)}`;
        return {
          ...this.appCached.snapshot,
          cached: true,
          stale: true,
          validation: "temporarily-unverified-with-last-known-good",
          warning: this.appFallbackWarning
        };
      }
      const fallback = await this.cliCatalog.getCatalog({ ...options, backendKind: "mcp-server" });
      this.appFallbackWarning =
        `Could not load the App Server model catalog; the Codex CLI fallback is unverified for policy activation. ${errorMessage(error)}`;
      return {
        ...fallback,
        stale: true,
        validation: "temporarily-unverified-with-last-known-good",
        warning: `${this.appFallbackWarning}${fallback.warning ? ` ${fallback.warning}` : ""}`
      };
    }
  }

  getCachedCatalog(options: Pick<ModelCatalogOptions, "backendKind"> = {}): CodexModelCatalogSnapshot | undefined {
    const backendKind = options.backendKind || this.defaultBackend;
    if (backendKind !== "app-server") {
      const snapshot = this.cliCatalog.getCachedCatalog?.(options);
      if (snapshot) this.rememberLastKnownGood(backendKind, snapshot);
      return snapshot;
    }
    if (this.appCached) {
      const stale = Boolean(this.appFallbackWarning) || this.appCached.expiresAt <= this.now();
      const snapshot: CodexModelCatalogSnapshot = {
        ...this.appCached.snapshot,
        cached: true,
        stale,
        validation: stale ? "temporarily-unverified-with-last-known-good" : "valid",
        ...(stale
          ? {
              warning: this.appFallbackWarning ||
                "The cached App Server model catalog has expired and is temporarily unverified."
            }
          : {})
      };
      this.rememberLastKnownGood("app-server", snapshot);
      return snapshot;
    }
    const fallback = this.cliCatalog.getCachedCatalog?.({ backendKind: "mcp-server" });
    if (!fallback) return undefined;
    return {
      ...fallback,
      stale: true,
      validation: "temporarily-unverified-with-last-known-good",
      warning: this.appFallbackWarning ||
        "The cached Codex CLI catalog is an unverified fallback for the App Server backend."
    };
  }

  subscribe(listener: ModelCatalogListener): () => void {
    this.listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.listeners.delete(listener);
    };
  }

  private noteLastKnownGood(
    backendKind: CodexBackendKind,
    snapshot: CodexModelCatalogSnapshot
  ): void {
    if (snapshot.stale || snapshot.validation !== "valid") return;
    const previousFingerprint = this.lastKnownGoodFingerprints.get(backendKind);
    if (previousFingerprint === snapshot.fingerprint) return;
    this.lastKnownGoodFingerprints.set(backendKind, snapshot.fingerprint);
    emitCatalogChanged(this.listeners, {
      backendKind,
      ...(previousFingerprint ? { previousFingerprint } : {}),
      snapshot
    });
  }

  private rememberLastKnownGood(
    backendKind: CodexBackendKind,
    snapshot: CodexModelCatalogSnapshot
  ): void {
    if (!this.lastKnownGoodFingerprints.has(backendKind)) {
      this.lastKnownGoodFingerprints.set(backendKind, snapshot.fingerprint);
    }
  }
}

export function modelCatalogFingerprint(models: CodexModelDescriptor[]): string {
  const canonical = models.map((model) => ({
    id: model.id,
    catalogId: model.catalogId || null,
    displayName: model.displayName,
    description: model.description || null,
    defaultReasoningEffort: model.defaultReasoningEffort || null,
    supportedReasoningEfforts: model.supportedReasoningEfforts.map((entry) => ({
      effort: entry.effort,
      description: entry.description || null
    })),
    hidden: model.hidden || false,
    isDefault: model.isDefault || false,
    upgrade: model.upgrade || null,
    upgradeInfo: model.upgradeInfo || null,
    supportsPersonality: model.supportsPersonality ?? null,
    defaultServiceTier: model.defaultServiceTier || null,
    serviceTiers: model.serviceTiers.map((tier) => tier.id),
    inputModalities: model.inputModalities
  }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Fingerprint only catalog fields that can change task admission or dispatch.
 *
 * The complete catalog fingerprint intentionally includes GPT-facing names,
 * descriptions, and migration guidance for Settings/UI cache updates. Those
 * presentation-only changes must not invalidate a request that still selects
 * the same executable model/effort/service-tier contract.
 */
export function modelCatalogAdmissionFingerprint(
  models: CodexModelDescriptor[]
): string {
  const canonical = models.map((model) => ({
    id: model.id,
    hidden: model.hidden || false,
    isDefault: model.isDefault || false,
    defaultReasoningEffort: model.defaultReasoningEffort || null,
    supportedReasoningEfforts: model.supportedReasoningEfforts.map(
      (entry) => entry.effort
    ),
    defaultServiceTier: model.defaultServiceTier || null,
    serviceTiers: model.serviceTiers.map((tier) => tier.id)
  }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function emitCatalogChanged(
  listeners: ReadonlySet<ModelCatalogListener>,
  event: ModelCatalogChangedEvent
): void {
  for (const listener of listeners) {
    const isolatedEvent = structuredClone(event);
    try {
      void Promise.resolve(listener(isolatedEvent)).catch(() => undefined);
    } catch {
      // Catalog observation is advisory. A listener must never invalidate a
      // successful last-known-good refresh or force a stale fallback.
    }
  }
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
