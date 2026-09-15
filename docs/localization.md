# Localization source and generation

`locales/catalog.json` is the sole authored source for fixed Bridge UI copy,
supported-language metadata, locale fallback rules, named placeholder
declarations, and the macOS String Catalog contents. Do not edit generated
translation files directly.

The generator produces these checked-in runtime artifacts:

- `src/generated/localization.ts` for the server and embedded cards;
- `macos/Sources/CodexBridgeMenuBar/GeneratedLocalization.swift` for native
  language metadata and English fallback copy;
- `macos/Resources/Localization/Localizable.xcstrings` for the app bundle.

The npm runtime imports the generated TypeScript module. It does not read
`locales/` at runtime, so a packed installation remains self-contained without
the source catalog.

## Editing workflow

1. Edit `locales/catalog.json` only. Every UI key must exist for every listed
   locale. Keep a stable semantic key when changing wording.
2. For a new named `{placeholder}`, add its key and `string-or-number`
   transport declaration under `ui.parameters`. Named placeholders may be
   reordered by a language but may not be added, removed, or duplicated.
3. Run:

   ```sh
   npm run localization:generate
   npm run localization:check
   npm run macos:localizations:check
   ```

`localization:check` rejects stale generated files, incomplete locale bundles,
duplicate/missing keys, named placeholder declarations, and native printf
argument-position/type mismatches. The macOS check also extracts Swift calls,
checks them against the generated catalog, compiles every `.lproj`, verifies
every native key has the exact generated value in each compiled language
(including the source language), and checks the app's declared locales.

`npm run build` and `npm run release:check` run the generated-file check before
card rendering. Changes below `locales/` participate in the build fingerprint
and select both Node and macOS validation.

`npm run macos:localizations:sync` is now an extraction audit: it never edits
the derived `.xcstrings` file. If Swift extraction reports a missing key, add
the key and translations to `locales/catalog.json`, then regenerate.

## Runtime rules

The shared resolver maps `zh-Hant-TW`, `zh-Hant-HK`, `zh-TW`, `zh-HK`, and
`zh-MO` to `zh-Hant`; other `zh-*` values resolve to `zh-Hans`. The same
regions and script tags are generated for TypeScript, card HTML, retained-card
notices, and Swift. This resolver selects copy only; `Intl` and Foundation keep
the host's full locale for date and number formatting.

Settings RPC responses retain their existing user-visible strings for older
clients and additionally carry semantic presentation descriptors (`key` plus
parameters). A card can therefore re-render warnings during a language preview
without losing its local draft. A `locale` attached to `settings.update` is
transport-only metadata; it is stripped before the shared mutation is saved.

Every shared card/native string uses its semantic key directly. Native-only
strings use the `macos.*` semantic-key namespace. If a native localization
bundle or key is unavailable, the generated English fallback is shown rather
than a raw key identifier.

## External card JSON decision

This change intentionally does **not** add a runtime JSON fetch for cards.
The existing versioned HTML resource contract permits only the two card files,
and external loading would need a new resource URI/version, CSP, cache,
offline/failure copy, and old-card compatibility design. Moving the authored
source into JSON alone would not reduce a card's embedded translation payload.
The generated card bundles preserve the current contract and size budgets.
A future lazy-language-bundle design must measure its actual size improvement
and specify those compatibility and failure rules before adoption.
