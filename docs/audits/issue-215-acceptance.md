# Issue 215 development acceptance

Checked 2026-10-03 KST. Related to [#215](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/215).
This record distinguishes development tests from candidate artifacts, installed
product tests and real-account processing/entitlement. It does not close the
remaining real-environment conditions.

## Integration and provenance

The starting `dev` was `616b7806a05c83ab16e2715e8abb6c8a4859c7dd`.
[PR 231](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/pull/231)
integrated contract/fixed-selection protection at
`c797060daf7c809c8302c04cd264588319370a4b`.
[PR 232](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/pull/232)
integrated scoped speed, migration, evidence and UI at
`b2da376ce1191fa7b657f384da9797cb37457e47`.
Final integration evidence is recorded separately after the bounded checks.

The product remains development 0.4.1. CI reproduction remains CLI 0.153.3;
schema compatibility and actual selected runtime admission remain capability
checks. No product version allowlist, installed CLI replacement, operational
settings mutation or release publication is introduced.

## CLI samples and what they prove

| CLI | Executable SHA-256 | Scope |
| --- | --- | --- |
| 0.153.3 | `0e1f892695844ad0798dab8895955846450a9e7663476ebf24615814dd377216` | CI schema lock, explicit tier samples, initialize and real adapter/local Responses lifecycle. |
| 0.159.1 | `ab2ed513b0ae735151799ab57045e05ca721c4730859b5aa2f2a9e9bed287eb8` | Targeted generated-contract/initialize boundary sample; no duplicate full lifecycle matrix. |
| 0.160.0 | `112fae7a5a1223e673c8a1791d32338f37df8b527ff1159bb8adac6c4dbf1b4b` | Latest stable sample checked 2026-10-03; contract/initialize and real adapter/local Responses lifecycle. |

The generated schemas and initialize results are in
[the contract report](issue-215-contracts-20261003.json). The lifecycle script
uses isolated HOME/CODEX_HOME, file credential storage, a synthetic provider key,
disabled apps/plugins/analytics/feedback and an external-denying proxy. Before
any turn it checks the App Server's resolved provider and exact loopback URL.
It never reads/copies operational credentials or calls an entitlement endpoint.

Both baseline and latest execute the same seven cases with configured Fast and
unset CLI tier: new inheritance, persistent Fast, turn-only Standard, continued
inheritance, legacy persistent clear, a new legacy-clear thread and a Standard
fork. Model/effort stay identical across the speed matrix. Latest additionally
uses its advertised GPT-6.1 Sol for Standard and catalog Fast. The real CLI
accepts the requests, sends them to the local Responses fixture, processes the
assistant response and emits terminal completion. These are synthetic-provider
acceptances, not commercial model execution, account entitlement or observed
actual processing grades.

The observed configured-Fast new inheritance sends a provider tier; legacy false
sends none. A Standard override sends none, and later inheritance restores the
persistent Fast tier. This confirms that migrating false to inheritance would
change behavior. Wire receipts preserve null versus omission and turn scope.

Primary contracts: official [0.153.3 TurnStartParams](https://github.com/openai/codex/blob/rust-v0.153.3/codex-rs/app-server-protocol/src/protocol/v2/turn.rs),
[0.160.0 TurnStartParams](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server-protocol/src/protocol/v2/turn.rs),
[upstream tier lifecycle test](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server/tests/suite/v2/turn_start.rs)
and [official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

## COMPAT acceptance boundary

| Requirement | Development evidence | Remaining boundary |
| --- | --- | --- |
| COMPAT-1 | Exact source/binary/schema identities, CI/latest/boundary scopes, protocol/catalog/account/execution separation. | Current installed product and artifact-bound candidate validation are not rerun here. |
| COMPAT-2 | Dynamic GPT-6.1 Sol selection, original fixed model/effort preservation, exact automatic new-work choice; latest local provider acceptance. | Real-account GPT-6.1 model/plan acceptance remains unverified. |
| COMPAT-3 | Legacy false/true scope, Standard/Fast/Ultrafast/unknown handling, old-client saves, immutable admission, per-field unconfirmed evidence, web/native/history and nine languages. | Real Ultrafast entitlement and applied processing grade are unverified. No paid test is hidden behind support detection. |
| COMPAT-4 | Unsupported fixed choices stop before admission; changed dispatch support fails without replacement; original Job preserved across settings/retry. Existing auth/workspace/operator controls remain. | Workspace/plan combinations unavailable to the fixture remain unverified. |
| COMPAT-5 | Existing #169/#212 short/weekly windows, credits/API, last-known usage, failed reads, same-account plan change and account switch regressions; real-browser retained usage/timestamp behavior. | No new real login, natural refresh, account switch or billing test. |
| COMPAT-6 | Adapter approval/question/control/late-terminal/reconnect fixtures and baseline/latest real CLI start/continue/fork response/completion. | Real-provider permissions, tools, steering/cancel/background combinations are not all live-tested on latest. |
| COMPAT-7 | Production dependencies audited; missing archive/unarchive disable only those operations. Required execution/permission contracts remain strict. | Neither optional-management nor schema success proves every real-server operation. |
| COMPAT-8 | Bounded local minimum combinations, source/build/CLI/report identity, UI/localization/docs checks. | Candidate npm/DMG/physical install acceptance and real-account Ultrafast are explicitly not performed. |

Each implementation PR contains its own functional/UI/translation regressions.
The last PR records integration and existing usage protection instead of moving
all feature tests into this final stage. Missing confirmation is independent of
Job outcome; normal work is never replayed to fill it. Historical actual fields
are not derived from current settings or old request echoes. Correlated receipts
survive event eviction, restart and expired-result summaries.

## Existing authentication and operational work

[SIWC #214](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/214)
remains OPEN with implementation/default adoption deferred. This work retains
the Bridge-managed CLI, dedicated durable store and existing official Codex
authentication. It does not rebind Agent/thread access permanently to an old
execution account. #219/#225's existing development acceptance remains intact.

[Operational verification #218](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/218)
continues to own real A→B→A, natural auth refresh/recovery, actual installed
artifact updates and dedicated-store app discovery/handoff. Its observation
remains PAUSED. This issue does not resume those operations or convert their
unchecked conditions to PASS.

## Reproduction and final results

Use Node 22 with dependencies compiled for that ABI. Pass explicit CLI paths to
`scripts/issue-215-cli-contracts.ts` and `scripts/issue-215-cli-lifecycle.ts`;
the scripts do not install/select a runtime. The latter supports
`--configuration-only` for a pre-turn provider check.
For the repository schema-lock check, put the baseline executable on PATH instead
of setting an ambient `CODEX_MCP_BRIDGE_CODEX`, which would override fixtures.

The final integration run and sanitized lifecycle/build evidence will be appended
after their completion. Earlier partial full runs are not represented as a single
clean full-suite result.
