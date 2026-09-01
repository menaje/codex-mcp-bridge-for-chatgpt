import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { UI_RESOURCE_MANIFEST, type UiResourceName } from "./uiManifest.generated.js";

const STALE_UI_TRANSLATIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  en: {
    "stale.title": "Plugin refresh required",
    "stale.body": "This {card} card revision is no longer retained. Refresh the plugin metadata and open a new conversation.",
    "stale.currentResource": "Current resource:",
    "stale.card.settings": "settings",
    "stale.card.activity": "Activity",
    "stale.card.dashboard": "overview"
  },
  ko: {
    "stale.title": "플러그인 새로고침 필요",
    "stale.body": "이 {card} 카드 버전은 더 이상 보관되지 않습니다. 플러그인 메타데이터를 새로고침하고 새 대화를 여세요.",
    "stale.currentResource": "현재 리소스:",
    "stale.card.settings": "설정",
    "stale.card.activity": "Activity",
    "stale.card.dashboard": "전체 현황"
  },
  ja: {
    "stale.title": "プラグインの更新が必要です",
    "stale.body": "この{card}カードの版は保持されていません。プラグインのメタデータを更新して、新しい会話を開いてください。",
    "stale.currentResource": "現在のリソース:",
    "stale.card.settings": "設定",
    "stale.card.activity": "Activity",
    "stale.card.dashboard": "全体状況"
  },
  "zh-Hans": {
    "stale.title": "需要刷新插件",
    "stale.body": "此{card}卡片版本已不再保留。请刷新插件元数据并打开新对话。",
    "stale.currentResource": "当前资源：",
    "stale.card.settings": "设置",
    "stale.card.activity": "Activity",
    "stale.card.dashboard": "概览"
  },
  "zh-Hant": {
    "stale.title": "需要重新整理外掛程式",
    "stale.body": "此{card}卡片版本已不再保留。請重新整理外掛程式中繼資料並開啟新對話。",
    "stale.currentResource": "目前資源：",
    "stale.card.settings": "設定",
    "stale.card.activity": "Activity",
    "stale.card.dashboard": "概覽"
  },
  es: {
    "stale.title": "Es necesario actualizar el plugin",
    "stale.body": "Esta versión de la tarjeta de {card} ya no se conserva. Actualiza los metadatos del plugin y abre una conversación nueva.",
    "stale.currentResource": "Recurso actual:",
    "stale.card.settings": "configuración",
    "stale.card.activity": "Activity",
    "stale.card.dashboard": "resumen"
  },
  fr: {
    "stale.title": "Actualisation du plugin requise",
    "stale.body": "Cette version de la carte {card} n’est plus conservée. Actualisez les métadonnées du plugin et ouvrez une nouvelle conversation.",
    "stale.currentResource": "Ressource actuelle :",
    "stale.card.settings": "des paramètres",
    "stale.card.activity": "Activity",
    "stale.card.dashboard": "de la vue d’ensemble"
  },
  de: {
    "stale.title": "Plugin-Aktualisierung erforderlich",
    "stale.body": "Diese Version der {card}-Karte wird nicht mehr vorgehalten. Aktualisieren Sie die Plugin-Metadaten und öffnen Sie eine neue Unterhaltung.",
    "stale.currentResource": "Aktuelle Ressource:",
    "stale.card.settings": "Einstellungen",
    "stale.card.activity": "Activity",
    "stale.card.dashboard": "Übersicht"
  },
  pt: {
    "stale.title": "É necessário atualizar o plugin",
    "stale.body": "Esta versão do cartão de {card} não é mais mantida. Atualize os metadados do plugin e abra uma nova conversa.",
    "stale.currentResource": "Recurso atual:",
    "stale.card.settings": "configurações",
    "stale.card.activity": "Activity",
    "stale.card.dashboard": "visão geral"
  }
};

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
  return `<!doctype html><html dir="auto"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title></title></head><body><main><h1 id="title"></h1><p id="body"></p><p><span id="current-label"></span> <code id="current"></code></p></main><script>
const BUNDLES=${JSON.stringify(STALE_UI_TRANSLATIONS).replaceAll("<", "\\u003c")};
const resourceName=${JSON.stringify(name)};
const currentResource=${JSON.stringify(current)};
const rawLocale=String(navigator.language||"en").replaceAll("_","-").toLowerCase();
const locale=rawLocale==="ko"||rawLocale.startsWith("ko-")?"ko":rawLocale==="ja"||rawLocale.startsWith("ja-")?"ja":rawLocale==="zh-hant"||/^zh-(tw|hk|mo)(-|$)/.test(rawLocale)?"zh-Hant":rawLocale==="zh"||rawLocale==="zh-hans"||rawLocale.startsWith("zh-")?"zh-Hans":["es","fr","de","pt"].find((entry)=>rawLocale===entry||rawLocale.startsWith(entry+"-"))||"en";
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
