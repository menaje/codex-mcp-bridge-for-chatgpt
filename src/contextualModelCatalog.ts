import type { CodexBackendKind } from "./config.js";
import type { CodexModelCatalogProvider, ModelCatalogListener, ModelCatalogOptions } from "./modelCatalog.js";

/** Cached data can be retained only inside the execution/authentication context that produced it. */
export class ContextualModelCatalog implements CodexModelCatalogProvider {
  private entries = new Map<CodexBackendKind, { key: string; provider: CodexModelCatalogProvider; unsubscribe?: () => void }>();
  private listeners = new Set<ModelCatalogListener>();
  constructor(private readonly defaultBackend: CodexBackendKind, private readonly revision: () => string,
    private readonly create: () => CodexModelCatalogProvider, private readonly beforeRead?: (kind: CodexBackendKind) => Promise<unknown>) {}
  async getCatalog(options: ModelCatalogOptions = {}) {
    const kind = options.backendKind || this.defaultBackend;
    await this.beforeRead?.(kind);
    const revision = this.revision(), provider = this.provider(kind);
    const result = await provider.getCatalog(options);
    if (revision !== this.revision()) throw new Error("CODEX_ACCOUNT_CHANGED: Refresh the model choices for the current account.");
    return result;
  }
  getCachedCatalog(options: Pick<ModelCatalogOptions, "backendKind"> = {}) {
    const entry = this.entries.get(options.backendKind || this.defaultBackend);
    if (!entry || entry.key !== this.revision()) return undefined;
    return entry.provider.getCachedCatalog?.(options);
  }
  subscribe(listener: ModelCatalogListener) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private provider(kind: CodexBackendKind) {
    const key = this.revision();
    let entry = this.entries.get(kind);
    if (!entry || entry.key !== key) {
      entry?.unsubscribe?.();
      const provider = this.create();
      entry = { key, provider, unsubscribe: provider.subscribe?.(async event => {
        if (key === this.revision()) await Promise.all([...this.listeners].map(listener => listener(event)));
      }) };
      this.entries.set(kind, entry);
    }
    return entry.provider;
  }
}
