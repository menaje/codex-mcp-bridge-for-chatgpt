# Issue 110 UI resource lifecycle validation

Date: 2026-09-14 (Asia/Seoul)

Issue: [#110](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/110)

## Outcome

The bridge now maintains one current source file and one packaged file for each
active card:

| Card | Source file | Packaged file | Resource URI |
| --- | --- | --- | --- |
| Settings | `ui-resources/settings.html` | `dist/ui/settings.html` | `ui://codex-mcp-bridge/settings/v1.html` |
| Dashboard | `ui-resources/dashboard.html` | `dist/ui/dashboard.html` | `ui://codex-mcp-bridge/dashboard/v1.html` |

The release catalog uses the `versioned-uri` strategy. Compatible HTML, CSS,
copy, localization, and host-metadata changes overwrite the current file and
keep the URI version. SHA-256 remains an integrity value and is no longer part
of the file name or URI. A card increments its own `/vN.html` version only when
an older cached card cannot safely use the new server or tool contract.

Release synchronization removes digest-named legacy files. Release validation
rejects extra source or packaged UI files, digest drift, URI drift, and missing
current resources. Activity and Question presentation resources are retired;
their durable work, question, result, authorization, and idempotency state is
preserved by the bridge.

## Settings localization packaging

Translations remain owned by the shared localization source in
`src/uiI18n.ts`; the Settings card does not maintain hand-copied translations.
Its build selects only the namespaces the Settings UI uses and serializes every
supported locale into the generated HTML.

This self-contained bundle is intentional. The Settings card can switch
languages immediately, including after a host-locale notification, while the
resource bytes remain deterministic and work under the card content-security
policy without fetching a separate localization file. All locale strings being
present in the generated Settings HTML is therefore a packaging decision, not
a second translation source.

The generated Settings HTML is 217,796 bytes against its enforced 224 KiB
(229,376-byte) limit, leaving 11,580 bytes of headroom. The current bundle is
valid, but continued localization growth must retain this size check and may
eventually justify further compression or a separately versioned resource
design.

## Integrity and package evidence

The validated macOS bundle reports build ID
`71a31f73b15f-dirty:b16d5f6e7d7d`. Its packaged UI directory contains exactly
`dashboard.html` and `settings.html`. Source, distribution, and installed app
copies have matching SHA-256 values:

- Settings: `e93f048df908241302ab2b2ccd22dc373e29bbdd0212b293fdbda93893313287`
- Dashboard: `800f2f1d5ea9cb16db2a9f45d57eb568c01627a6f7c7de3fbedae84ff5ce5fb3`

The bundle signature passed verification. Replacing the installed development
build preserved the state database and environment configuration. SQLite
`quick_check` passed before and after replacement, the main database size
remained 196,378,624 bytes, and every table count remained equal except for the
single expected new `bridge_instances` startup row.

The live client required Secure MCP Tunnel Client
`0.0.14+0f870e50a973fa820d4c409000059e181e8d242b`, which supports the bridge's
MCP 2026-07-28 stateless protocol.

## Regression and live-host evidence

The first live Dashboard attempt exposed a lossy JSON result: an optional
`handoff.reason` property was included with JavaScript `undefined`, then omitted
by JSON serialization. The result boundary now reports the first lossy path,
and Dashboard and companion hydration omit that property when no reason exists.
A regression test exercises a real background task and verifies exact JSON
round-trip equality for the Dashboard payload.

Validation after the fix completed with:

- the full TypeScript suite: 83 files and 687 tests passed;
- the macOS suite: 159 tests passed, with two expected opt-in live checks skipped;
- `npm run release:check` passed;
- `git diff --check` passed;
- direct isolated MCP Dashboard hydration passed exact JSON round-trip checks;
- connector discovery advertised only the Settings and Dashboard `/v1.html` resources;
- a new ChatGPT Dashboard card rendered status and usage without an error;
- a new ChatGPT Settings card rendered retained settings and all supported language choices;
- a normal bridge restart completed with no active or pending jobs; and
- refreshing the mounted Dashboard after that restart advanced its data timestamp
  from 17:10:09 to 17:13:30 and rendered the current counts without an error.

ChatGPT uses the resource URI as a cache key. A compatible deployment can
replace the server-side bytes at the same URI, but an already mounted card may
continue running the bytes it previously received. After a compatible UI
change, refresh or reconnect connector discovery and open a new card when the
new presentation must be visible immediately. This host cache behavior does
not require retaining multiple server-side card files.
