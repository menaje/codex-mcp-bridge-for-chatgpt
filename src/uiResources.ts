import {
  UI_LOCALE_RESOLUTION,
  UI_TRANSLATIONS,
  type UiTranslationKey
} from "./uiI18n.js";
import {
  UI_RESOURCE_MANIFEST,
  type UiResourceName as GeneratedUiResourceName
} from "./uiManifest.generated.js";

export type UiResourceName = GeneratedUiResourceName;

const STALE_TRANSLATION_KEYS = [
  "stale.title",
  "stale.body",
  "stale.currentResource",
  "stale.card.settings",
  "stale.card.dashboard"
] as const satisfies readonly UiTranslationKey[];

// Retained-card fallback text comes from the same generated catalog as active
// cards. It remains a small subset only because an old URI must stay usable
// without loading the current card's complete translation bundle.
const STALE_UI_TRANSLATIONS = Object.fromEntries(
  Object.entries(UI_TRANSLATIONS).map(([locale, bundle]) => [
    locale,
    Object.fromEntries(STALE_TRANSLATION_KEYS.map((key) => [key, bundle[key]]))
  ])
);

function activeResource(name: UiResourceName) {
  return (UI_RESOURCE_MANIFEST.resources as Record<string, unknown>)[name] as {
    readonly uriVersion: number;
    readonly digest: string;
    readonly uri: string;
    readonly metadata?: { readonly content?: Readonly<Record<string, unknown>> };
    readonly releaseProvenance?: UiResourceRevision["releaseProvenance"];
  } | undefined;
}

export type UiResourceRevision = {
  uriVersion: number;
  digest: string;
  uri: string;
  contractGeneration?: number;
  metadata?: {
    descriptor?: Readonly<Record<string, unknown>>;
    content?: Readonly<Record<string, unknown>>;
  };
  releaseProvenance?: {
    inventories: readonly string[];
    sourceIds: readonly string[];
    presenterTool: string;
    requiredTools: readonly string[];
  };
};

export function uiRevisionMetadata<Descriptor, Content>(
  revision: UiResourceRevision,
  fallbackDescriptor: Descriptor,
  fallbackContent: Content
): { descriptor: Descriptor; content: Content } {
  return {
    descriptor: (revision.metadata?.descriptor as Descriptor | undefined) ?? fallbackDescriptor,
    content: (revision.metadata?.content as Content | undefined) ?? fallbackContent
  };
}

export function currentUiResourceUri(name: UiResourceName): string {
  return currentUiResourceRevision(name).uri;
}

export function currentUiResourceRevision(name: UiResourceName): UiResourceRevision {
  const resource = activeResource(name);
  if (!resource) throw new Error(`Current UI resource is missing: ${name}.`);
  return {
    uriVersion: resource.uriVersion,
    digest: resource.digest,
    uri: resource.uri,
    contractGeneration: readContractGeneration(resource.metadata),
    metadata: resource.metadata,
    releaseProvenance: resource.releaseProvenance
  };
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
  return uri === currentUiResourceUri(name) ? currentHtml : staleUiResourceNotice(name);
}

function staleUiResourceNotice(name: UiResourceName): string {
  const current = currentUiResourceUri(name);
  return `<!doctype html><html dir="auto"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title></title></head><body><main><h1 id="title"></h1><p id="body"></p><p><span id="current-label"></span> <code id="current"></code></p></main><script>
const BUNDLES=${JSON.stringify(STALE_UI_TRANSLATIONS).replaceAll("<", "\\u003c")};
const LOCALE_RESOLUTION=${JSON.stringify(UI_LOCALE_RESOLUTION)};
const resourceName=${JSON.stringify(name)};
const currentResource=${JSON.stringify(current)};
const rawLocale=String(navigator.language||"en").replaceAll("_","-").toLowerCase();
const locale=rawLocale==="ko"||rawLocale.startsWith("ko-")?"ko":rawLocale==="ja"||rawLocale.startsWith("ja-")?"ja":LOCALE_RESOLUTION.traditionalChineseTags.some((tag)=>rawLocale===tag||rawLocale.startsWith(tag+"-"))||LOCALE_RESOLUTION.traditionalChineseRegions.some((region)=>new RegExp("^zh-"+region+"(-|$)").test(rawLocale))?"zh-Hant":rawLocale==="zh"||rawLocale==="zh-hans"||rawLocale.startsWith("zh-")?"zh-Hans":["es","fr","de","pt"].find((entry)=>rawLocale===entry||rawLocale.startsWith(entry+"-"))||"en";
const t=BUNDLES[locale]||BUNDLES.en;
const card=t["stale.card."+resourceName]||resourceName;
document.documentElement.lang=locale;
document.title=t["stale.title"];
document.getElementById("title").textContent=t["stale.title"];
document.getElementById("body").textContent=t["stale.body"].replace("{card}",card);
document.getElementById("current-label").textContent=t["stale.currentResource"];
document.getElementById("current").textContent=currentResource;
</script></body></html>`;
}
