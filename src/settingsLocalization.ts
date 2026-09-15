import type { SettingsView } from "./tools.js";
import {
  reasoningEffortPresentation,
  resolvePreferredUiLocale,
  settingsWarningPresentation,
  uiTranslation,
  type SettingsWarningPresentation,
  type UiTranslationKey
} from "./uiI18n.js";

export type SettingsPresentationMessage = SettingsWarningPresentation;

export type SettingsPresentation = {
  warnings: SettingsPresentationMessage[];
  catalogWarning: SettingsPresentationMessage | null;
  scopeNotice: SettingsPresentationMessage;
};

const message = (
  key: UiTranslationKey,
  parameters: Record<string, string | number> = {}
): SettingsPresentationMessage => ({ key, parameters });

export function localizeSettingsPresentation(
  entry: SettingsPresentationMessage,
  locale: Parameters<typeof uiTranslation>[0]
): string {
  return uiTranslation(locale, entry.key, entry.parameters);
}

/** Localize the complete editor snapshot for cards and the native companion. */
export function localizeSettingsView(
  view: SettingsView,
  requestedLocale?: string
): SettingsView {
  // Keep the private transport tolerant of an older in-process provider while
  // the native app and bridge are replaced as a pair.
  if (!view.settings?.uiLocalePreference || !view.catalog ||
    !Array.isArray(view.catalog.models) || !Array.isArray(view.warnings)) return view;
  const locale = resolvePreferredUiLocale(view.settings.uiLocalePreference, requestedLocale);
  const warningPresentation = view.warnings.map((warning) => settingsWarningPresentation(warning));
  const catalogPresentation = view.catalog.warning
    ? settingsWarningPresentation(view.catalog.warning, {
      catalog: true,
      stale: view.catalog.stale
    })
    : null;
  const presentation: SettingsPresentation = {
    warnings: warningPresentation,
    catalogWarning: catalogPresentation,
    scopeNotice: message("settings.sharedNotice")
  };
  const localized = {
    ...view,
    warnings: warningPresentation.map((entry) => localizeSettingsPresentation(entry, locale)),
    scopeNotice: localizeSettingsPresentation(presentation.scopeNotice, locale),
    presentation,
    catalog: {
      ...view.catalog,
      warning: catalogPresentation ? localizeSettingsPresentation(catalogPresentation, locale) : null,
      models: view.catalog.models.map((model) => ({
        ...model,
        supportedReasoningEfforts: model.supportedReasoningEfforts.map((entry) => {
          const detail = reasoningEffortPresentation(entry.effort, locale, entry.description);
          return {
            ...entry,
            label: detail.label,
            localizedDescription: detail.description,
            descriptionSource: detail.descriptionSource
          };
        })
      }))
    }
  };
  // App Server catalog descriptors may retain explicit `undefined` optional
  // fields. Settings is sent through both MCP and native JSON transports, so
  // omit those fields before either JSON boundary can change the response.
  return omitUndefinedJsonMembers(localized) as SettingsView;
}

function omitUndefinedJsonMembers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitUndefinedJsonMembers);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) output[key] = omitUndefinedJsonMembers(entry);
  }
  return output;
}
