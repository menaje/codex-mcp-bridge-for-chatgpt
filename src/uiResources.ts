import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { UI_RESOURCE_MANIFEST, type UiResourceName } from "./uiManifest.generated.js";

type UiResourceRevision = { digest: string; uri: string };

export function currentUiResourceUri(name: UiResourceName): string {
  return UI_RESOURCE_MANIFEST.resources[name].uri;
}

export function uiResourceRevisions(name: UiResourceName): UiResourceRevision[] {
  const resource = UI_RESOURCE_MANIFEST.resources[name] as {
    digest: string;
    uri: string;
    previous: readonly UiResourceRevision[];
  };
  return [
    { digest: resource.digest, uri: resource.uri },
    ...resource.previous.map((entry) => ({ ...entry }))
  ];
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
