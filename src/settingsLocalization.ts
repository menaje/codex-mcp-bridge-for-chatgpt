import type { SettingsView } from "./tools.js";
import {
  localizeSettingsWarning,
  reasoningEffortPresentation,
  resolvePreferredUiLocale,
  uiTranslation
} from "./uiI18n.js";

/** Localize the complete editor snapshot for cards and the native companion. */
export function localizeSettingsView(
  view: SettingsView,
  requestedLocale?: string
): SettingsView {
  // Keep the private transport tolerant of an older in-process provider while
  // the native app and bridge are replaced as a pair.
  if (
    !view.settings?.uiLocalePreference ||
    !view.catalog ||
    !Array.isArray(view.catalog.models) ||
    !Array.isArray(view.warnings)
  ) {
    return view;
  }
  const locale = resolvePreferredUiLocale(
    view.settings.uiLocalePreference,
    requestedLocale
  );
  const localized = {
    ...view,
    warnings: view.warnings.map((warning) =>
      localizeSettingsWarning(warning, locale)
    ),
    scopeNotice: uiTranslation(locale, "settings.sharedNotice"),
    catalog: {
      ...view.catalog,
      warning: view.catalog.warning
        ? localizeSettingsWarning(view.catalog.warning, locale, {
            catalog: true,
            stale: view.catalog.stale
          })
        : null,
      models: view.catalog.models.map((model) => ({
        ...model,
        supportedReasoningEfforts: model.supportedReasoningEfforts.map((entry) => {
          const presentation = reasoningEffortPresentation(
            entry.effort,
            locale,
            entry.description
          );
          return {
            ...entry,
            label: presentation.label,
            localizedDescription: presentation.description,
            descriptionSource: presentation.descriptionSource
          };
        })
      }))
    }
  };
  // App Server catalog descriptors may retain explicit `undefined` optional
  // fields. Settings is sent through both MCP and the native JSON transport,
  // so omit those fields in this presentation copy rather than letting a
  // JSON boundary silently alter the response.
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
