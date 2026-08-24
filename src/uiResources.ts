import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { UI_RESOURCE_MANIFEST, type UiResourceName } from "./uiManifest.generated.js";

type UiResourceRevision = {
  digest: string;
  uri: string;
  contractGeneration?: number;
};

export function currentUiResourceUri(name: UiResourceName): string {
  return UI_RESOURCE_MANIFEST.resources[name].uri;
}

export function uiResourceRevisions(name: UiResourceName): UiResourceRevision[] {
  const resource = UI_RESOURCE_MANIFEST.resources[name] as unknown as {
    readonly digest: string;
    readonly uri: string;
    readonly metadata?: { readonly content?: Readonly<Record<string, unknown>> };
    readonly previous: ReadonlyArray<UiResourceRevision & {
      readonly metadata?: { readonly content?: Readonly<Record<string, unknown>> };
    }>;
  };
  return [
    {
      digest: resource.digest,
      uri: resource.uri,
      contractGeneration: readContractGeneration(resource.metadata)
    },
    ...resource.previous.map((entry) => ({
      digest: entry.digest,
      uri: entry.uri,
      contractGeneration: readContractGeneration(entry.metadata)
    }))
  ];
}

function readContractGeneration(
  metadata: { readonly content?: Readonly<Record<string, unknown>> } | undefined
): number | undefined {
  const value = metadata?.content?.["codex/uiContractGeneration"];
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

export function htmlForUiResource(
  name: UiResourceName,
  uri: string,
  currentHtml: string
): string {
  const revisions = uiResourceRevisions(name);
  const revision = revisions.find((entry) => entry.uri === uri);
  if (!revision) {
    return staleUiResourceNotice(name);
  }
  if (revision.uri === currentUiResourceUri(name)) return currentHtml;

  for (const candidate of snapshotCandidates(name, revision.digest)) {
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
  }
  return staleUiResourceNotice(name);
}

function snapshotCandidates(name: UiResourceName, digest: string): string[] {
  return [
    fileURLToPath(new URL(`./ui/${name}/${digest}.html`, import.meta.url)),
    fileURLToPath(new URL(`../ui-resources/${name}/${digest}.html`, import.meta.url))
  ];
}

function staleUiResourceNotice(name: UiResourceName): string {
  const current = currentUiResourceUri(name);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Plugin refresh required</title></head><body><main><h1>Plugin refresh required</h1><p>This ${name} card revision is no longer retained. Refresh the plugin metadata and open a new conversation.</p><p>Current resource: <code>${current}</code></p></main></body></html>`;
}
