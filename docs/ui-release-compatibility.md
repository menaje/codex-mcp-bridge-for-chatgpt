# UI card release policy

The bridge ships one current immutable revision for each active card. It does
not provide a compatibility window for previously advertised card resources.

## Active catalog

`ui-release-catalog.json` is version 3 and selects these four resources:

| Card | URI |
| --- | --- |
| Settings | `ui://codex-mcp-bridge/settings/52c19aebb4e9.html` |
| Activity | `ui://codex-mcp-bridge/activity/bc75a45e4875.html` |
| Dashboard | `ui://codex-mcp-bridge/dashboard/86e53748068a.html` |
| Question | `ui://codex-mcp-bridge/question/a93cf2f84a75.html` |

The catalog's `publishedBaselines` and `temporaryExceptions` arrays must stay
empty. A source file in `ui-resources/` is not a supported resource unless it
is selected by this catalog and the generated manifest.

## Release rules

1. Change a card's source and regenerate its content-addressed HTML.
2. Update `src/uiManifest.generated.ts`, `ui-manifest.lock.json`, and the
   release manifest with the new digest and URI.
3. Remove the displaced revision from the active catalog and package selection.
4. Run `npm run release:check`, then open every active resource with the
   current MCP client.

The release check verifies that the selected asset bytes match their SHA-256
identities and that the release manifest names the same catalog. It rejects a
historical selection or a temporary exception.

## Client behavior

A deployed card URI identifies its exact HTML. The bridge never serves changed
HTML under an old URI. After a UI change, reconnect and refresh the ChatGPT
connector, then reopen the card. A conversation that cached an earlier URI
must use the current resource; the old URI is not a fallback path.

Activity, Agent, Job, question, and settings data remain durable bridge state.
Retiring a resource revision removes only that presentation identity, not the
underlying work records or their authorization checks.
