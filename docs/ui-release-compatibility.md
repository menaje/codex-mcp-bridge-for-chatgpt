# UI card release policy

The bridge maintains one current HTML file for each active card. A card keeps
the same versioned URI across compatible HTML, CSS, copy, localization, and
host-metadata changes. SHA-256 records the exact current bytes and metadata for
integrity checks; it is not part of the file name or URI.

## Active catalog

`ui-release-catalog.json` is version 4 and selects these resources:

| Card | Source file | Packaged file | Resource URI |
| --- | --- | --- | --- |
| Settings | `ui-resources/settings.html` | `dist/ui/settings.html` | `ui://codex-mcp-bridge/settings/v6.html` |
| Dashboard | `ui-resources/dashboard.html` | `dist/ui/dashboard.html` | `ui://codex-mcp-bridge/dashboard/v5.html` |

Activity, Question, and Decision are retired presentation resources. Their
historical state remains only where migration or current orchestration requires
it; no historical card HTML is selected or packaged. Decision Card tools and
`ui://codex-mcp-bridge/decision/v1.html` are unavailable after connector Refresh.

The current v5 contracts expose explicit processing-speed modes and their
Job-versus-conversation scope. Deploy the matching server and cards, refresh
connector discovery, and reopen cards; an older Fast checkbox is not a complete
editor for the current setting. See [processing speed](processing-speed.md).

## URI versions

Each active card has an explicit `currentContracts.<card>.uriVersion` in the
release catalog. Keep that number unchanged when a cached copy of the old card
can still use the newly deployed server and tool contracts correctly. Running
`npm run release:sync` then overwrites the card's single HTML file, updates its
digest, and leaves its URI unchanged.

Increase only the affected card's `uriVersion` before a cache-incompatible
change. Examples include removing or renaming a tool that cached JavaScript can
call, changing an app-only request or response shape in a way the cached card
cannot handle, or changing initialization behavior so the old card cannot mount
safely. The increment creates a new URI such as `v2.html`; it does not create a
second source or package file.

Changes to completion routing or result handoff also require a new URI when
the previous cached card can select the wrong connection or continue asking
GPT to retrieve a receipt through a superseded path. Internal digests and
`codex/uiContractGeneration` do not invalidate the host's URI cache. Dashboard `v4` removes the completion sender, watcher, receipt query and `codex_ui_completion` dependency. Settings `v4` removes the delivery experiment switch. Both advance in the same upgrade as direct-wait admission and server-path refusal. Historical `v3` bytes remain test fixtures only and are not served or packaged.

Server-side refusal and old-iframe behavior are separate gates. An already-open v3 iframe may hold result text or a message retry in memory; rejecting another server call cannot revoke its host `ui/message` capability. Close/tear down old instances, refresh connector tools, and reopen the current v5 cards before accepting the migration. Verify old waiting calls, in-flight result replies and rejected-message retry independently. Preserve any observed limitation instead of claiming server refusal alone proves no old-card send.

After deployment, compare the real tool descriptor's `_meta.ui.resourceUri`
and `openai/outputTemplate`, the same connection's `resources/read` URI/HTML
hash, and the mounted iframe's code. Dashboard startup records its URI and
contract generation in non-visible `data-card-resource-uri` and
`data-card-contract-generation` attributes; their presence confirms that the
new script started. A current file on disk alone is not live-serving evidence.

Product SemVer and card URI versions are independent. A product release does
not change a card URI by itself, and the two cards can advance their URI
versions separately.

Settings `v6` introduces confirmed project shutdown and physical removal of Bridge
management records. Older cached deletion guidance incorrectly promises retained
work history, and older cards cannot show pending/unresolved shutdown or retry it.
Close older Settings mounts, refresh connector discovery, and reopen Settings
before applying this contract. A new URI does not revoke an already open iframe;
live-host teardown and refresh acceptance remain a deployment check. Dashboard
stays at `v5`; there is still only one packaged file per card.

## Release rules

1. Update the card source, shared localization, or host metadata.
2. Decide whether the previous cached card remains compatible with the new
   server contract. If it does not, increment that card's `uriVersion`.
3. Run `npm run release:sync` and review the stable URI, new SHA-256 digest, and
   generated manifest.
4. Run `npm run release:check`, build the package, and open all active cards
   with the current MCP client.

Synchronization removes legacy digest-named files. Release validation rejects
extra files under `ui-resources/`, a missing current file, mismatched HTML or
metadata digests, URI drift, and package output other than the two current
files.

## ChatGPT cache behavior

ChatGPT treats a resource URI as a cache key. OpenAI's guidance is to publish a
new URI when an HTML, JavaScript, or CSS change would break a cached component:
[Build your ChatGPT UI](https://developers.openai.com/plugins/build/chatgpt-ui#embed-the-component-in-the-server-response)
and [Plan for updates](https://developers.openai.com/plugins/build/mcp-server#plan-for-updates).

Serving new bytes at the same URI does not guarantee that an already mounted or
cached ChatGPT card immediately fetches them. The bridge has no remote cache
invalidation mechanism. Compatible changes may therefore coexist briefly with
an older mounted card. If the new behavior is required immediately, refresh or
reconnect the connector and reopen the card; a new conversation may be needed
for a host that retains the old mount.

For an incompatible change, increment the URI version before deployment and
refresh connector discovery. The old URI is no longer advertised or served by
the new release, while durable bridge state remains available through the
current tools and cards.
