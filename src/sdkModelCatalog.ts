import { parseAppServerModelCatalog, modelCatalogFingerprint, type CodexModelCatalogProvider, type CodexModelCatalogSnapshot,
  type ModelCatalogListener, type ModelCatalogOptions } from "./modelCatalog.js";

/** Failures retain only the SDK's own last verified catalog, with no external CLI fallback. */
export class SdkModelCatalog implements CodexModelCatalogProvider {
  private cached?: CodexModelCatalogSnapshot;
  private expiresAt = 0;
  private loading?: Promise<CodexModelCatalogSnapshot>;
  private readonly listeners = new Set<ModelCatalogListener>();
  constructor(private readonly load: () => Promise<unknown>, private readonly ttlMs: number) {}
  async getCatalog(options: ModelCatalogOptions = {}): Promise<CodexModelCatalogSnapshot> {
    if (!options.refresh && this.cached && this.expiresAt > Date.now()) return { ...this.cached, cached: true };
    if (!this.loading) this.loading = this.refresh().finally(() => { this.loading = undefined; });
    return this.loading;
  }
  getCachedCatalog(): CodexModelCatalogSnapshot | undefined {
    if (!this.cached) return undefined;
    const stale = this.expiresAt <= Date.now();
    return { ...this.cached, cached: true, stale, validation: stale ? "temporarily-unverified-with-last-known-good" : "valid" };
  }
  subscribe(listener: ModelCatalogListener): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private async refresh(): Promise<CodexModelCatalogSnapshot> {
    try {
      const models = parseAppServerModelCatalog(await this.load());
      const timestamp = new Date().toISOString();
      const snapshot: CodexModelCatalogSnapshot = { source: "codex-sdk", fetchedAt: timestamp, validatedAt: timestamp,
        fingerprint: modelCatalogFingerprint(models), cached: false, stale: false, validation: "valid", models };
      const previousFingerprint = this.cached?.fingerprint;
      this.cached = snapshot; this.expiresAt = Date.now() + this.ttlMs;
      if (previousFingerprint !== snapshot.fingerprint) for (const listener of this.listeners) {
        await listener({ backendKind: "codex-sdk", previousFingerprint, snapshot });
      }
      return snapshot;
    } catch {
      if (!this.cached) throw new Error("SDK_MODEL_CATALOG_UNAVAILABLE: Install and authenticate the selected SDK environment before choosing its models.");
      return { ...this.cached, cached: true, stale: true, validation: "temporarily-unverified-with-last-known-good",
        warning: "The SDK model catalog could not be refreshed. Its last verified result is retained; no other CLI was queried." };
    }
  }
}
