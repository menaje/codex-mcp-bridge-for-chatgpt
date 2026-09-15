# Text integrity policy

The bridge does not use one global text normalizer. Each field selects one of
the policies in `src/textIntegrity.ts` before it is persisted, hashed, compared,
or forwarded:

| Field meaning | Policy |
| --- | --- |
| Names, labels, descriptions, tags | `canonicalHumanText`: NFC plus the field's explicit whitespace, length, and control-character rules |
| Prompts, skill Markdown, reference files, code, paths, commands | `verbatimText`: validates text but never normalizes, trims, folds whitespace, or changes line endings |
| Protocol IDs, hashes, secrets, external identifiers | `opaqueIdentifier`: UTF-8/Unicode validity only, with explicitly requested bounds |
| Search comparisons | `searchKey`: a derived NFC, case-folded key; it never replaces stored text and does not use NFKC |

All external byte boundaries use strict UTF-8 decoding. Invalid byte sequences
are rejected; Node does not use its replacement-character fallback. JSON values
are also checked after parsing so an escaped unpaired surrogate cannot cross a
wire boundary. The private companion socket, remote HTTPS companion, App Server
JSONL transport, skill files, and native socket/HTTPS client all apply this
rule. Runtime state/lock/status files, runtime environment files, tunnel
metadata, release metadata, and the packaged launcher scripts use the same
strict byte path. Native Swift exposes the matching `BridgeTextIntegrity` API.

New human-facing inputs use the central policy at their write boundary. Existing
SQLite records and immutable skill versions are not rewritten merely to change
normalization. Version-2 skill instructions and references preserve exact valid
UTF-8, including CRLF, combining characters, leading/trailing whitespace, and
the absence or presence of a final newline. Hashes are calculated from the
selected, actually stored UTF-8 text.

Persisted JSON is revalidated when it is read, so corrupt bytes or an escaped
unpaired surrogate in a state record cannot silently become a replacement
character or enter an RPC response. Prompt steering and handoff summaries are
`verbatimText`: their exact accepted text, including whitespace and line
endings, is what is forwarded and hashed.

`locales/text-integrity-vectors.json` is the shared public test vector file.
`test/textIntegrity.test.ts` and
`macos/Tests/CodexBridgeKitTests/TextIntegrityTests.swift` run the same invalid
UTF-8, NFC, verbatim, and search-key examples.

## Non-goals

This policy does not use NFKC compatibility folding, detect Unicode
confusables, sanitize HTML, or defend against prompt injection. It does not
change prompt-size limits. Those are separate validation and security concerns.
