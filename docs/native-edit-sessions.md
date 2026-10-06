# Native input and edit-session contract

Issue [#236](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/236)
centralizes protection of user drafts. Field normalization remains governed by
[Text integrity](text-integrity.md) (#115). Controls retain their native behavior:
SwiftUI single-line and secure fields, native AppKit search, plus the AppKit-backed
`BridgeTextEditor` for documents. An edit session belongs to one form or editing
target; a window scope only coordinates navigation and exit decisions.

## Ownership and change observation

`BridgeEditSession` in `macos/Sources/CodexBridgeMenuBar/EditSession.swift` owns the
baseline, current draft, UUID, target ID, change revision, server baseline version,
pending external values, conflicts and one in-flight submission. Each control
uses `session.binding(.field)` and `.bridgeInput(session, field: .field)`. Search
uses `BridgeSearchField(...).bridgeSearchInput(session)` and reads `session.searchValue`.

The binding setter records UTF-8 changes directly. Native editing notifications
also observe visible preedit, including text not delivered to SwiftUI yet. Those
notifications are coalesced after AppKit finishes installing the marked range.
Preedit updates the draft without echoing it into the binding or replacing the
native hosting view. End-editing notifications carry the final single-line value.
`BridgeSearchField` uses `NSSearchField` with a scoped hosting boundary and keeps
its editing buffer through parent refreshes, including the gap immediately after
composition ends. Pending native notifications also block stale view writes.
Its adapter publishes committed changes after AppKit has installed the marked
range; the native observer still
records visible preedit. Search results continue using only the committed query.
Search ownership is excluded from the form exit guard: changing a query does not
create a save/discard prompt when navigating away or closing a window.
Dirty state separately compares values under the field policy: canonically
equivalent human names can be clean while byte-distinct Markdown remains dirty.
Undo back to the original bytes clears dirty state.

Each native adapter has an explicit hosting boundary. A single-line field owns
the shared AppKit field editor only while that field is its delegate and the
editor is the first responder in that window. A submission cannot commit another
form's marked text. Read-only labels are excluded from input ownership, as are
system Find controls identified by the public `NSScrollView.findBarView` container.
Ambiguous mounted controls block synchronization. Reopening
or changing targets creates a new session UUID; callbacks from old bindings and
old native notifications cannot edit it. Native buffers are replaced only for an
explicit discard, confirmed server value or new target identity.

## Submission and response handling

Every save intent enters before final dirty and validity checks:

1. Confirm composition and synchronize the submitting session's native controls.
2. Stop and keep the draft if synchronization or conflict review is incomplete.
3. Read the latest values, apply each field policy, and validate the request.
4. Pin submission ID, session UUID, target ID, draft revision, raw/prepared values
   and expected server version in `BridgeEditSubmission`.
5. Send the feature API request using that snapshot.
6. Apply its `BridgeEditReceipt` only to the matching in-flight request.

Save buttons admit marked text even when previously published dirty/validity
state is stale. Button, menu and Command-S routes use the same preparation.
Candidate-selection Enter is guarded by marked state and the input event that
ended composition. Search only exposes a committed query; it does not use a
document-save lifecycle.

A successful response advances the baseline to the submitted values and the
actual returned version. Additional input, including Undo back to the old baseline,
stays in the draft and is compared against what was actually saved. Failed requests
also protect that newer Undo from subsequent external snapshots.
Closing a sheet, switching to preview or navigating after a save is allowed only
for a clean matching revision. Feature reloads check the guard again after their
asynchronous read. A response for A cannot select or clear B, nor acknowledge a
reopened A. Creation receipts adopt the actual new resource ID so later input
updates the created resource instead of creating it again. File-renaming receipts
also advance the source path used by the next rename.

Boolean APIs use `submit`; APIs with version/identity receipts use `submitReceipt`
or the same `prepareSubmission`/`acknowledge` primitives. API business rules stay
in `AppModel` and the server. Session, submission and receipt diagnostics redact
payloads. Secrets have no edit history and are cleared on success only when the
submitted secret is still current; a newer secret remains until explicit discard
or its own successful submission.

## External updates, failure and exit

External snapshots update untouched fields independently. Focused fields and
in-flight requests defer reconciliation; local edits are preserved. Overlapping
server changes become conflicts. A server-version conflict requires a fresh
snapshot followed by an explicit **Reload** or **Keep edits** choice. Reload
discards the affected draft fields; Keep edits adopts the displayed baseline for
the next guarded request. Neither choice submits automatically. A refresh during
submission cannot silently advance the acknowledged version. Failed requests,
failed validation and failed composition synchronization retain drafts.

Hosted server settings pin the complete previous configuration. The optional
`remote.configure.expectedConfiguration` comparison runs inside the server's
serialized lifecycle before stopping its listener or changing pairing state.
Stale requests fail with `REMOTE_CONFIGURATION_CONFLICT`; legacy callers can
omit the optional guard. The new native settings UI always supplies it. Skill
versions, settings revisions, project registry revisions and model-description
expected overrides retain their existing server checks.

Navigation and window close observe the latest draft without submitting or
committing candidates. Cancelling the discard dialog keeps preedit. An explicit
discard invalidates receipts and restores the baseline without an API write.
Window scopes include visible controls and form anchors for wizard steps and
sheets. Quit stages approval by session UUID/revision, rechecks after asynchronous
shutdown work, and discards only after all exit checks succeed. Failed or
cancelled shutdown retains drafts. Settings locale changes update the environment
without destroying the editing pane.

## Input inventory

The structural guard covers **32 production declarations**, including repeated
model-description rows. The machine-readable inventory is
[`macos/input-contract.json`](../macos/input-contract.json). `H` means trimmed NFC
human text; descriptions permit multiple lines. `V` means verbatim UTF-8. `S`
means opaque secret with redacted diagnostics. `N` parses Unicode decimal digits
at commit and retains empty/partial/invalid text while editing. `Q` is a raw draft
whose committed query feeds existing derived search behavior.

| View | Field | Control | Policy | Intent |
| --- | --- | --- | --- | --- |
| CodexAccountUsageView | adminKey | SecureField | S | Configure billing |
| CodexAccountUsageView | organizationID | TextField | V | Configure billing |
| CodexAccountUsageView | projectID | TextField | V | Configure billing |
| CodexAuthSelectionControls | apiKey | SecureField | S | Save candidate key |
| ConnectionSetupFlowView | apiKey | SecureField | S | Save credentials |
| ConnectionSetupFlowView | tunnelID | TextField | V | Save credentials |
| ConnectionSetupFlowView | invitation | BridgeTextEditor | S | Pair server |
| ConnectionSetupFlowView | deviceName | TextField | H | Pair server |
| ConnectionSetupFlowView | profileName | TextField | H | Pair server |
| ModelDescriptionDraftEditor | description | BridgeTextEditor | H, 2,000 scalars | Save override |
| NativeSettingsView | query | Search | Q | Filter settings |
| ConnectionSettingsPane | name | TextField | H | Rename saved profile |
| ConnectionSettingsPane | displayName | TextField | H | Configure hosted server |
| ConnectionSettingsPane | endpoint | TextField | V | Configure hosted server |
| RemoteServerConnectionSheet | invitation | BridgeTextEditor | S | Pair server |
| RemoteServerConnectionSheet | deviceName | TextField | H | Pair server |
| RemoteServerConnectionSheet | profileName | TextField | H | Pair server |
| ModelExecutionSettingsPane | number | TextField | N, operator range | Commit on blur/Return; autosave settings |
| ProjectEditorSheet | name | TextField | H | Add/rename/restore project |
| ProjectEditorSheet | cwd | TextField | V | Add/relocate/restore project |
| SkillsLibraryWindowView | query | Search | Q | Filter library |
| SkillsLibraryWindowView | name | TextField | H | Save skill metadata |
| SkillsLibraryWindowView | description | TextField | H | Save skill metadata |
| SkillsLibraryWindowView | content | BridgeTextEditor | V | Save main/attached Markdown |
| BridgeSkillImportReviewSheet | name | TextField | H | Import skill |
| BridgeSkillImportReviewSheet | description | TextField | H | Import skill |
| NewBridgeSkillSheet | name | TextField | H | Create/update skill |
| NewBridgeSkillSheet | description | TextField | H | Create/update skill |
| NewBridgeSkillSheet | content | BridgeTextEditor | V | Create/update skill |
| NewBridgeSkillFileSheet | path | TextField | V | Add/update file |
| NewBridgeSkillFileSheet | content | BridgeTextEditor | V | Add/update file |
| RenameBridgeSkillFileSheet | path | TextField | V | Rename file |

Feature validation still applies at submission, including URL/tunnel syntax,
nonempty names, server-specific limits, and existing business-level treatment of
organization/project IDs. Native numeric formatting is replaced with a string
draft, while the stepper still enforces the operator's range. Import checkboxes
and main-file selection also record a revision so changing them during a request
cannot close the review over a newer selection.

System-owned exceptions are `NSOpenPanel` (confirm the owning draft before
applying a selected path), `NSSavePanel` (export a pinned document), and the native
`NSTextView` Find bar (replacement changes still enter the document binding).
Do not reimplement their internal input controls.

## Regression and physical acceptance

The implementation starts from local `6bd8692`, which includes the native-editor
and byte-preservation fixes `089e7b7` and `6bd8692`. The issue review's remote
`37839d1` was a different baseline; its findings do not prove those local fixes
were still broken. Automated regressions and physical input-source tests are
separate evidence:

| Suite | Evidence |
| --- | --- |
| EditSessionTests | Pinned revisions/versions/creation targets; late/reopened targets; stale native binding/buffer; per-field conflicts; version-only refresh; explicit review; failed synchronization; numeric partials; redacted secrets; shared field editor; discard/cancel |
| NativeTextInputTests | Mounted native fields/search/editor; Hangul/Japanese/Chinese and combining scripts via NSTextInputClient; refresh during composition; UTF-16 selection/reconversion; focus loss; exact bytes; secure insertion; undo/redo and Find |
| SkillsLibraryTextInputTests | Production window and isolated RPC socket; byte-distinct save/readback; marked save; additional marked input during delayed response; A-to-B response isolation; conflict review; guard recheck after delayed feature read |
| Remote companion tests | Strict optional guard encoding, endpoint null, stale queued configuration without listener/pairing mutation, and legacy callers |
| nativeInputContract.test.ts / macos:input:check | Missing owner, mismatched field/session, direct state binding, raw editor/native constructor, global commit and inventory changes are rejected; source traversal includes new subdirectories |

Run `npm run macos:check`, `npm run check`, and `npm run validate:fast` with the
repository's pinned Codex CLI for the App Server compatibility check. The source
guard only checks declarations and ownership connections; it cannot establish
candidate-window or physical keyboard behavior.

Build the synthetic physical fixture with
`npm run macos:input:acceptance:build -- '/tmp/Bridge Input Acceptance.app'`.
It compiles the production session/adapters, refreshes unrelated UI every 250 ms,
and shows a local submitted-value receipt with an 800 ms acknowledgement delay.
It sends no bridge/API request, stores no credentials, and includes baseline
native controls for comparison. Use disposable strings in the secure field.

For each installed input source, record its actual identifier, expected text,
visible draft, submitted text, candidate behavior and pass/fail/blocked status.
Cover single-line/default/rounded controls, document editor, search, focus change,
candidate Enter, Command-S while the final syllable is marked, undo/redo, and new
input before acknowledgement. Include Korean two-set, Japanese Romaji,
simplified Chinese Pinyin, traditional Chinese Zhuyin, an accent/dead-key layout,
emoji and mixed RTL text. Secure-field keyboard restrictions belong to macOS;
Unicode paste/insertion and redaction are separate checks. Restore the original
input-source list, active source and any automatically added dictation languages
after temporarily adding test sources.

On 2026-10-04, computer-use key synthesis failed to retain composition even in
baseline controls: two-set `g k s` produced separate `ㅎㅏㄴ` with no marked range.
It is not physical-IME proof. The system accessibility keyboard was also tried,
but its key controls were not exposed by the enabled computer-use surface. Its
original off state was restored, along with ABC as the active source, the original
ABC/two-set source list and Korean-only, disabled dictation. A human tried
arbitrary strings in several fields; those strings were not a specified expected
result and cannot be classified as corruption.

Computer-use Unicode paste and Command-S on the final fixture (source SHA-256
`2634b2ba93217ace532c6fcfa4ae835860bb90c16c0fd30136735c45f3f39dc5`)
verified Korean, Japanese, Chinese, Arabic, Hebrew, combining accents and emoji.
Names submitted NFC while the verbatim single-line field kept NFD. Document
CRLF, combining characters and surrounding spaces survived submission and
Undo/Redo through the 250 ms refresh. Search exposed the committed query; a
synthetic secret remained masked and was cleared after acknowledgement. Empty
numeric input blocked submission without dropping drafts, while full-width
`１２` submitted as `12`. Submitting name `10` then entering `11` before the
800 ms receipt retained `11` as dirty. Explicit discard restored `10` without
another submission. These are native UI tests, not physical candidate tests.

Leading BOM cannot be certified by this paste route: a separate, uniquely named
pasteboard probe showed `NSPasteboard.string(forType: .string)` consuming the
leading UTF-8 BOM before the bridge reads an input draft, while the pasteboard
data still contained `EF BB BF`. An embedded BOM survived the UI test. Existing
document load/save tests verify a BOM already present in the draft separately;
the clipboard conversion result does not establish loss on that storage path.

On 2026-10-06, specified human keyboard tests submitted `한글 입력` from the
name field and `첫째 줄\n둘째 줄` from the document with Command-S. The document
stayed exact across unrelated refreshes; native Undo/Redo restored its original
bytes and dirty state without another submission. The held document observations
reported no marked range, so these results do not certify saving an observed
marked candidate. Sidebar search failed: the human typed `한글 검색`, but both
the visible field and committed query became `한ㅡ 검ㅐ`. This is distinct from
the unspecified earlier trial. The search regression delivers an older binding
value while a native candidate is marked, then refreshes the navigation host.
Before the search adapter fix this lost composition and replaced the candidate;
the human's physical reacceptance on the changed search adapter preserved the
exact `한글 검색` in both the visible field and committed query after a 20-second
hold and Enter, with no form submission. That fixture's source SHA-256 is
`1a50944d1300f2f030063d20b5b169a112cceb03419c0bbb00780158b8f3cea2`;
it precedes the separate search exit-guard exclusion and the latest localization
updates. The final exit-guard behavior is covered by a mounted native test.

The Japanese/Chinese candidate matrix remains pending until recorded.
The agent also tried installed Japanese Romaji and both Chinese Pinyin input
sources on 2026-10-06. In the unmodified baseline field, automatic `nihongo` and
`hanzi` plus Space stayed literal, with no marked range or candidate window.
Automatic letter keys even delivered Korean jamo under those selected sources;
resetting the control connection did not fix that. The Japanese
[reverse-conversion shortcut](https://support.apple.com/guide/japanese-input-method/reverse-a-conversion-jpim10309/mac)
also did not open a candidate window in the baseline. These attempts cannot
establish either a Bridge defect or an installed IME acceptance pass.

The final-source fixture (SHA-256
`3134a80e53814485f8409a41eb0ef3a0764934ee148bd7db40a85e62bbc11b65`)
passed agent-operated Unicode paste and Command-S for Japanese, Simplified and
Traditional Chinese, combining accents/kana, Arabic, Hebrew and emoji. Exact
submitted payload comparison preserved the verbatim line's NFD and surrounding
spaces, plus the document's four CRLFs, embedded BOM and final newline. Name
submission used NFC as intended. Document Undo/Redo restored the exact source
and dirty state. Search preserved the mixed-language query, Enter did not submit
the form, and the native cancel button cleared the query. SwiftUI added display
isolation marks around the RTL query; the editable query itself stayed exact.
The temporary three input sources and automatically added dictation languages
were removed. ABC and Korean Two Set, active Korean Two Set, dictation off and
Korean-only dictation language were verified restored; the trial app was closed.
The temporary fixture also does not
validate the installed product build. Keep #236 open while physical acceptance
is incomplete; local source integration is not a release or installation of the
fix. The 2026-10-04 fixture was closed after those tests.
