# Bridge skill library

The Bridge owns a private, versioned skill library. It does not discover,
copy, install, or configure Codex skills. A bridge skill is found, one exact
version is read, and only then applied to the current conversation or selected
for one Codex turn.

## Identity and storage

Every result includes an opaque `skillId`, `source: "bridge"`, and exact
`version`. Display names are not identities. Instructions and registered
reference materials are immutable per version; each edit creates the next
version.

By default, records live beside the state database in `skills/`. Set
`CODEX_MCP_BRIDGE_SKILLS_DIRECTORY` to an absolute private directory to place
them elsewhere. This directory is not a Codex global skill root.

## Payload bounds

The persisted limits are 120 visible characters for a name, 2,000 for a
description, 512 KiB for instructions, up to 64 text materials at 512 KiB
each and 2 MiB in total (with a 200-character media type), and up to 32
declared requirements. A per-turn Codex bundle allows 3 MiB so every valid
stored instruction-and-material combination can be delivered with its
immutable metadata. Companion mutation requests
allow 6 MiB of serialized JSON to accommodate JSON escaping without creating a
smaller transport-only limit.

## Model-facing MCP tools

`bridge_skill` is read-only and has four closed operations:

- `search` returns compact matches by name or purpose.
- `read` returns the selected version's instructions and material metadata.
- `reference` returns one material listed by `read` for that exact version,
  including that version's declared execution conditions and warnings. It is
  not a general local-file reader.
- `versions` returns the retained immutable history for one `skillId` without
  returning every historical body.

`bridge_skill_manage` has four closed mutation operations: `create`, `update`,
`restore`, and `set-enabled`. `create` and `update` write a new immutable
version. `restore` copies a selected historical version into a new current
version; it never rewrites history. `set-enabled` archives or reactivates a
skill without deleting its audit trail. Every mutation requires a UUID
`requestId`: retry the same logical request with the same ID and payload, and
use a new ID for a new change. Receipts remain with the retained bridge
library, so an old exact retry cannot silently become a new mutation.

Both `structuredContent` and model-visible `content` carry the complete,
validated result for `bridge_skill`. That includes instructions, material
metadata or requested material text, execution mode, declared requirements,
and warnings where applicable; no card or flow is needed first. A requirement
is descriptive only: it cannot grant a tool, filesystem, network, or execution
permission. Unsupported bridge capabilities and external-environment
prerequisites are surfaced explicitly.

For example, a model can search for `"review report evidence"`, read the
selected exact result, and apply the instructions directly while answering the
conversation. Reading a skill does not start Codex, execute a script, grant a
tool permission, or change instruction priority.

## Passing a skill to Codex

For local work, put the exact `bridge_skill` result in
`codex_task.requiredSkills`. The Bridge rechecks the immutable bridge version
immediately before dispatch, then delivers its instructions and registered
materials only in that turn's prompt.

Retained Job records include the selected required skills and their
`bridge-instruction-bundle` delivery mode. That evidence confirms delivery
only; it does not claim that Codex followed a procedure or that output passed
a separate verification step. Required skills are not an allowlist: Codex can
still use its own active skills, and the Bridge never changes the user's global
Codex skill activation to run a task.

Disabled skills remain readable by their exact historical reference for audit,
but are omitted from normal discovery and cannot be newly passed to Codex.
Conversation-only skills and skills that declare an unsupported bridge
capability are likewise rejected before a Codex task is dispatched.

## Mutation durability

The library atomically replaces its index, writes version directories through a
private staging directory, and serializes changes with an owner-identified
private filesystem lock. A stale lock is recoverable only when its local owner
is no longer alive; recovery first claims the stale directory so concurrent
reclaimers cannot delete a newer holder's lock. A crashed recovery claim is
retired only after that claimant is also proven dead. On the next mutation it
removes an unreferenced completed or staging version left by an interrupted
write. Mutation receipts are retained with the index so a transport retry
returns the original result instead of making a second version. This is private
bridge storage, not a Codex global skill root.

## Native app

In the macOS app, the **Skills Library** window (also available from
**Settings → Skills**) lists and edits only bridge-owned skills through the
same private source and immutable versions used by MCP. It supports search,
current/archived filtering, full reference-material editing and preview,
execution-condition editing, version-history inspection and restore, and
archive/reactivate actions. The standalone library window is resizable.

## Acceptance walkthrough

1. Ask the GPT host to find a procedure by purpose with `bridge_skill.search`.
2. Read the returned exact reference with `bridge_skill.read`, then any listed
   material with `bridge_skill.reference`.
3. Apply a conversation-capable procedure directly, or pass the same exact
   reference to `codex_task.requiredSkills` for local work.
4. Confirm the result distinguishes bridge skill delivery from Codex global
   skill configuration, and that reading alone has not started a task or run a
   script.

The final host-level walkthrough needs to be performed in a real ChatGPT
session; repository tests validate the MCP and native-client contracts but do
not emulate the host model's tool-selection behavior.
