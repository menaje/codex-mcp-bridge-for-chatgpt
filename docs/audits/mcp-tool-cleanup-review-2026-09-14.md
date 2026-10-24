# MCP tool-contract final audit — 2026-09-14

## Scope

This is the final source audit for the MCP 2026-07-28 replacement work in
issues #105 and #106. It covers the advertised current tool inventory, schema
size, obsolete compatibility paths, and the safety of suggested follow-up
actions.

## Method

`npx tsx scripts/audit-tool-guidance.ts` connects a current-protocol client to
an isolated bridge with an in-memory state store and temporary project root.
Its upstream rejects execution, so the audit makes no Codex call and changes no
installed bridge or user configuration. It discovered tools through actual
`tools/list` and exercised 16 no-execution validation probes.

## Inventory

| Audience | Tools | Descriptor bytes | Input-schema bytes | Output-schema bytes |
| --- | ---: | ---: | ---: | ---: |
| Model-visible | 12 | 77,188 | 17,240 | 54,843 |
| App-private | 14 | 144,829 | 38,591 | 98,323 |
| Total | 26 | 222,017 | 55,831 | 153,166 |

The measurements are UTF-8 bytes of JSON descriptors, not token counts. The
audit found 276 model-visible description words, 348 shared instruction words,
16 probes, and zero upstream calls.

## Findings and decision

- The bridge advertises only the current 26 tools. Retired aliases,
  compatibility registrars, legacy model-policy transport, and object-schema
  union helper are absent from source.
- All advertised inputs and outputs are JSON Schema 2020-12 contracts.
  `codex_task` uses input contract version 3 and output contract version 2;
  `codex_models` has one current response and an optional `refresh` input.
- `nextActions` is a closed, allow-listed union. It can name only validated
  safe follow-up reads/openers or provide non-executable guidance; it cannot
  smuggle an arbitrary tool call or mutation.
- `codex_ui_read` has the largest output schema at 62,156 bytes. It remains
  because its closed variants carry the card proofs, scope, pagination, and
  ownership facts used by the four current cards. Size alone is not a reason
  to delete that safety boundary.

The result supports a full replacement: do not restore legacy wire behavior,
tool aliases, old input branches, or card-resource fallbacks to accommodate a
host that has not refreshed its connector.

## Validation boundary

The source suite includes raw HTTP tests for current request headers and
metadata, including rejection of a body/header method mismatch and a request
without the current envelope. It also tests rejection of the retired
`initialize`, `GET`, and `DELETE` paths.

Local implementation validation is complete. A real ChatGPT conversation
through a deployed Secure MCP Tunnel still needs to record current discovery,
a tool call, and a card open before the deployment acceptance portion of the
issues can be closed. The active local bridge was not restarted during this
review because it is an older installed build and restarting it could interrupt
ongoing work.

See the [migration guide](../mcp-2026-07-28-migration.md) for the current-only
client and deployment procedure.
