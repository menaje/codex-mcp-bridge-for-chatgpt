# Processing speed and application scope

Speed and scope are separate settings. Reasoning effort `ultra` is unrelated to
Ultrafast processing. Subscription plans, model catalogs, protocol support and
observed execution each provide different evidence; none substitutes for the
others.

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
