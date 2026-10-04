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
normalization. Bridge skill documents, attached Markdown files, and their
logical paths preserve exact valid UTF-8, including a leading BOM, CRLF,
combining characters, leading/trailing whitespace, and the absence or presence
of a final newline. Existing v1/v2 structured skill records remain on the
lossless compatibility read path. Hashes are calculated from the selected,
actually stored UTF-8 text.

Persisted JSON is revalidated when it is read, so corrupt bytes or an escaped
unpaired surrogate in a state record cannot silently become a replacement
character or enter an RPC response. Prompt steering and handoff summaries are
`verbatimText`: their exact accepted text, including whitespace and line
endings, is what is forwarded and hashed.

`locales/text-integrity-vectors.json` is the shared public test vector file.
`test/textIntegrity.test.ts` and
`macos/Tests/CodexBridgeKitTests/TextIntegrityTests.swift` run the same invalid
UTF-8, NFC, verbatim, and search-key examples.

## Native macOS input audit (2026-10-04)

The native source has 32 explicit input declarations: 20 single-line text
fields, 6 multiline editors, 3 secure fields, 2 sidebar searches, and one numeric
field. Shared sheets account for add/rename/relocate/restore and main/attached
document variations. This inventory covers the Dashboard's setup entry points
as well as the Settings, Connection Assistant, and Skill Library windows.

| Surface | Inputs | Count |
| --- | --- | --- |
| Settings sidebar | Settings search | 1 |
| Skill Library sidebar | Skill search | 1 |
| Project sheet | Project name; local or remote folder path | 2 |
| Connection settings | Saved server name; hosted server name; HTTPS endpoint | 3 |
| Remote pairing sheet | Invitation; device name; optional saved server name | 3 |
| Connection Assistant credentials | Runtime API key; tunnel ID | 2 |
| Connection Assistant pairing | Invitation; device name; optional saved server name | 3 |
| Model descriptions | Description editor, repeated for each model | 1 |
| Codex authentication | Candidate API key | 1 |
| API cost connection | Admin key; organization ID; optional project ID | 3 |
| Current skill | Name; search description; main or attached Markdown | 3 |
| Skill import review | Name; search description | 2 |
| New skill | Name; search description; main Markdown | 3 |
| New attachment | Relative path; Markdown | 2 |
| Rename attachment | New relative path | 1 |
| Models & Execution | Concurrent task count, constrained to the configured numeric range | 1 |

Native Open/Save panels and the editor's Find bar also accept text. AppKit owns
those controls; the bridge does not replace their buffers or intercept their
keystrokes. Secure fields are tested with synthetic Unicode insertion; actual
secure-field keyboard/input-source behavior is owned by macOS. Numeric input
intentionally does not store arbitrary Korean text.

Three defects were found and corrected:

- With the original SwiftUI `TextEditor`, composing `한글 입력` across view updates
  lost marked text on the first `ㄱ`, `ㅇ`, and `ㄹ` following a committed syllable.
  The single-line and sidebar search controls passed the same sequence. All six
  multiline declarations now use `BridgeTextEditor`, which leaves the AppKit
  buffer intact during composition, keeps dirty/validation state aware of the
  visible marked text, publishes the final syllable on focus loss,
  and preserves UTF-8 bytes, selection, undo/redo, and native Find support.
- Hosted server status refreshes previously assigned both editable connection
  fields unconditionally. Per-field draft reconciliation now protects both
  committed edits and focused, unpublished IME composition. Untouched fields
  follow server changes, and successful saves acknowledge only the submitted
  draft so newer edits are retained.
- Model description length validation counted UTF-16 code units before NFC,
  rejecting valid decomposed Hangul and supplementary characters. It now uses
  the server's trimmed, NFC Unicode-scalar count without rewriting the draft.
  Explicit save, pairing, import, authentication, and custom paste actions commit
  pending composition before reading or replacing a draft, including Command-S
  without a focus change. Description saving reads that latest edit rather than
  the value captured during the previous view render.

`macos/Tests/CodexBridgeKitTests/NativeTextInputTests.swift` drives AppKit's
[`NSTextInputClient` composition methods](https://developer.apple.com/documentation/appkit/nstextinputclient)
against mounted SwiftUI views. It checks successive Hangul syllables, UTF-16
replacement ranges after emoji, in-composition refreshes, focus changes,
composition backspace, NFC/NFD bytes, CRLF, punctuation, synthetic secure input,
undo/redo, scrolling, and hosted drafts. A source inventory assertion guards all
six multiline declarations. `AppPresentationTests` checks the description limit
against decomposed Hangul and emoji.

These are native composition-protocol and source-audit checks. The Mac was locked
when interactive inspection was attempted, so physical Korean-keyboard testing
of the installed app remains pending. The source fix does not replace the
installed application or publish a release.

## Non-goals

This policy does not use NFKC compatibility folding, detect Unicode
confusables, sanitize HTML, or defend against prompt injection. It does not
change prompt-size limits. Those are separate validation and security concerns.
