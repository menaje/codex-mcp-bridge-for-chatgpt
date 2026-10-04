# Processing speed and application scope

Speed and scope are separate settings. Reasoning effort `ultra` is unrelated to
Ultrafast processing. Subscription plans, model catalogs, protocol support and
observed execution each provide different evidence; none substitutes for the
others.

## Choose a speed

Open **Settings → Models & Execution** in the native app, or **Processing
speed** in the ChatGPT Settings card. Native changes save automatically;
the card uses **Save settings**. The choice is captured when a new Job is
admitted, so changing it does not alter work already running or queued.

| Choice | What it requests |
| --- | --- |
| Inherit conversation speed | A new conversation follows its CLI configuration; a retained conversation keeps its own processing tier. |
| Standard | Standard processing for this new Job only. |
| Fast | The eligible faster tier for this new Job only. |
| Ultrafast | The eligible Ultrafast tier for this new Job only. |
| Legacy | Preserves the older Fast checkbox behavior, including its persistent conversation scope, until you deliberately choose a new mode. |

Availability depends on the selected CLI's protocol, the current model catalog,
and policy. A faster choice can affect usage or charges; selecting it is not
proof of account entitlement or of the tier actually applied. Unsupported or
unknown choices block new execution instead of silently falling back.

The Dashboard separates the requested model, reasoning effort, and speed from
request acceptance and server confirmation. A completed Job can still have
unconfirmed actual effort or speed. **Allow Ultra reasoning** controls reasoning
effort; it does not select Ultrafast processing or enable all delegation.
See [model selection](model-selection.md) for fixed/automatic model choice,
custom descriptions, and description history.

## App Server wire contract

The generated schemas and Rust `TurnStartParams` for 0.153.3, 0.159.1 and 0.160.0
have the following contract:

| Wire input | Meaning |
| --- | --- |
| Omit `serviceTier` | Preserve the conversation tier. |
| `serviceTier: null` | Clear the conversation's requested tier, for this and later turns. |
| `serviceTier: <value>` | Change the conversation tier for this and later turns. |
| `serviceTierForTurn: "default"` | Explicit Standard processing for the new turn only. |
| `serviceTierForTurn: <value>` | Override processing for the new turn only. |
| Omit or null `serviceTierForTurn` | Inherit the conversation tier for the new turn. |

A new conversation's CLI/config default and a retained conversation's tier are
different sources. Neither is equivalent to clearing a conversation tier.
The turn-only override does not change a running turn being steered.

Sources: [App Server documentation](https://learn.chatgpt.com/docs/app-server),
the official protocol at [0.153.3](https://github.com/openai/codex/blob/rust-v0.153.3/codex-rs/app-server-protocol/src/protocol/v2/turn.rs),
[0.159.1](https://github.com/openai/codex/blob/rust-v0.159.1/codex-rs/app-server-protocol/src/protocol/v2/turn.rs)
and [0.160.0](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server-protocol/src/protocol/v2/turn.rs).
The upstream [turn tests](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server/tests/suite/v2/turn_start.rs)
also distinguish a turn-only Standard override from later inheritance.

## Existing settings and migration boundary

At source `616b780`, Bridge writes `serviceTier: null` when Fast is disabled.
When enabled it selects the catalog's `priority` or `fast` wire value and writes
it through the persistent field. This includes continuation with unchanged model
and reasoning. A disabled boolean must not become omission or “follow CLI
default,” and enabled Fast must not become turn-only Fast during migration.

Preserve the existing wire behavior until the user deliberately selects a new
speed setting. New Job-only settings should use `serviceTierForTurn` while
omitting `serviceTier`. Retain any still-present legacy wire values and their
source; reject unrecognized semantics before new execution. Already discarded
values cannot be recovered or inferred from today's catalog or settings.

The immutable decision at admission belongs to that Job, including queued work
and exact retries. A later settings edit applies to later admission. Changed
support at dispatch requires an explicit unavailable outcome, never a replacement
model, effort, speed or billing connection. Catalog or observational failures do
not cancel active work.

## Evidence and display

Record user intent, exact sent fields and scope, accepted thread/turn identity,
and server-confirmed model/effort/tier separately. Confirmation is per field and
bound to the originating Job, thread and turn. `model/rerouted` confirms only
the model change. Acceptance does not confirm speed, effort or inference routing.

Missing confirmation is independent of Job outcome. Do not rerun normal work to
obtain it or fill historical actual values using saved/requested/current settings.
UI text can remain compact, for example “Fast requested · accepted · actual tier
unconfirmed.”

## Support and validation scope

The existing `runtimeCompatibility.ts` contract and isolated initialize probe
remain the installation check. `scripts/issue-215-cli-contracts.ts` adds explicit
schema samples without executing turns, logging in, querying entitlement or
changing an installed/selected CLI. Pass explicit executable paths.

| Sample | Required evidence |
| --- | --- |
| CI pin 0.153.3 | Reproducible schema lock and legacy preservation. |
| Latest stable sample 0.160.0, checked 2026-10-03 | Selected binary hash, generated schema, initialize and affected adapter/event regressions. |
| 0.159.1 boundary | Targeted contract differences; no duplicate full suite. |
| Account/model/Ultrafast | Catalog and policy evidence with unknown entitlement reported honestly; real acceptance remains separate. |

Archive and unarchive are independent management operations. Production call
sites are the adapter/router and execution service's explicit management RPCs;
ordinary admission, persistent storage, idle release and app visibility do not
call them. Missing support disables only their advertisement/invocation. Sandbox,
approval reviewer, connector approval configuration, start/resume/turn and model
discovery remain required. Management failure is never reported as success.

This work keeps the managed CLI, dedicated durable storage and existing official
Codex authentication boundaries. SIWC introduction in #214 is excluded. The
paused observation and remaining operational validation in #218 stay unchanged.

## Saved modes and compatible clients

Settings schema 8 stores `processingSpeed` independently of the retired boolean:

| Saved mode | Transmission and scope |
| --- | --- |
| `legacy`, boolean false | `serviceTier: null`, retaining the persistent clear. |
| `legacy`, boolean true | Catalog `priority`/`fast` via persistent `serviceTier`. |
| `inherit` | Omit persistent tier; send `serviceTierForTurn: null`. A retained conversation keeps its own tier; a new conversation uses its CLI configuration. |
| `standard` | Omit persistent tier; send `serviceTierForTurn: "default"`. |
| `fast` / `ultrafast` | Omit persistent tier; send the eligible catalog tier through `serviceTierForTurn`. Protocol and catalog must both support that exact value. |
| Unknown string | Preserve it and refuse new execution until the user deliberately selects a supported mode. |

Migration retains the boolean and `legacy` mode instead of asserting that false
means CLI default. Surviving policy tier records are copied into
`retainedServiceTiers` before the existing policy migration strips the tier.
Unknown surviving semantics produce `unrecognized-legacy-tier`. An already
removed original tier is never recreated. Loading and restarting the migrated
settings is idempotent.

An old client may still send `usePriorityServiceTier` with unrelated changes. Once
a modern mode is saved, that boolean alone cannot overwrite the canonical mode.
New clients send the explicit mode only when appropriate; unknown modes remain
visible and unrelated saves omit them. Dashboard and Settings use resource
contract v5. The stable task execution envelope remains v6. Execution policy
signature v6 includes the canonical mode, separately from that stable envelope.

New Jobs retain both their execution decision and an exact public request digest.
An identical retry retrieves the same Job after settings or catalog
changes without reconsidering execution. A changed prompt/choice/routing with the
same request ID is rejected. The existing stale-project-selector guard remains
in force; read the original Job/status handle after project registry changes. Historical Jobs without this new digest retain their
existing replay validation and can always be read through their original status
handles; the missing digest is not reconstructed from current settings.

The accepted adapter receipt stores exactly the `turn/start` model, effort and
speed fields that were sent, including null versus absence. Server-confirmed
values remain null unless a correlated server event actually confirms that field.
Historical echo-only events do not become transmission receipts. Current official
turn events do not confirm the applied reasoning effort or processing tier;
`model/rerouted` confirms the model only when the event explicitly identifies the
Job's thread and turn. A late or uncorrelated event cannot rewrite another Job.
The first acceptance receipt and latest correlated model reroute are stored
separately from the 200-event progress ring, so eviction and Bridge restart
preserve those proofs without deriving them from current settings.
They are persisted when observed, independently of completion. Expired-result
Dashboard summaries retain request scope and confirmation status, and do not
upgrade old or unrelated routing observations into confirmed model changes.
