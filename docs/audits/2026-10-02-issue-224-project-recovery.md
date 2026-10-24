# Issue #224: project deletion and identity recovery

Issue: [#224](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/224)

The installed app's project deletion path allowed an archived registration to
become a tombstone while resumable work still referenced its UUID. A new
registration for the same folder then failed with `PROJECT_CWD_STILL_PINNED`,
while ordinary restore excluded tombstones. This was a lifecycle defect in the
code; an active-folder conflict or an allowed-roots setting did not explain the
reported failure.

Deletion now checks identity-owned open/sealed/terminating Activities, current
non-orphaned Agent threads, and running/terminating/termination-failed Jobs in
the existing transaction. Rejected deletion preserves both revisions and other
mutations in the batch. Archived registrations remain resumable.

Private Settings snapshots list up to 100 recently deleted registrations that
still own resumable work. Both the native app and Settings card offer explicit
restore of the selected original UUID. Restore preserves its project reference
and every work relationship, enforces registry CAS, and rechecks active name and
folder uniqueness, allowed roots, the registration limit and the managed
credentials location. Other operations still exclude tombstones. Folder reuse
under a new UUID remains blocked until the previous context releases ownership.

The localized Settings messages distinguish active-folder conflict, retained
folder ownership and deletion blocked by retained work. Shared translation keys
are serialized once for Settings; all nine locale maps round-trip unchanged,
and the card remains within its existing 224 KiB wire budget (195,836 bytes).
The recovery capability is optional so older Settings snapshots still decode.

Validation of the changed source:

- Node build and all 1,272 tests passed across 117 files.
- macOS compilation and XCTest suite passed: 218 cases, two existing skips,
  no failures.
- The real-browser regression uses the shipped card and real MCP Settings
  mutations against a temporary database. It verifies original UUID/reference
  restoration, preserved ordinary-settings drafts through language changes,
  blocked deletion with unchanged CAS, and separate cwd error messages.
- A SQLite online backup of the operating database reproduced the reported
  nine resumable Activities and 12 current Agent threads. Restoration through
  the new registry transaction preserved the original UUID/reference and all
  Activity, Agent-thread/session and Job relationships. Integrity and foreign
  key checks passed. This copy check did not modify the operating database.

No schema migration or work-history cleanup is required. The regression fixtures
inject the previous deletion behavior only into isolated test databases.
