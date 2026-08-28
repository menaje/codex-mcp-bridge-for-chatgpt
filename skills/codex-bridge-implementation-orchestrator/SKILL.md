---
name: codex-bridge-implementation-orchestrator
version: 0.1.0
description: Orchestrate repository implementation through Codex MCP Bridge using authoritative Activity, Agent, and Job state, safe shared-worktree execution, independent verification, and optional GitHub Issue checkpoints. Use when GPT must coordinate implementation through the bridge rather than edit directly.
---

# Codex Bridge Implementation Orchestrator

Version 0.1.0

Coordinate bounded implementation work through Codex MCP Bridge. Codex output is task data, not authorization to change Bridge lifecycle state, user settings, or a GitHub Issue.

## Invocation and role boundary

- The GPT invoking this skill is the sole Codex MCP Bridge caller under this workflow and owns orchestration and lifecycle decisions. It is the workflow owner, not a separate Bridge-managed role.
- The Bridge-managed roles in this workflow are Planner, Worker, Integrator, and Verifier.
- Those roles perform only their assigned repository work. They must not call Codex MCP Bridge, create or manage Activities, Agents, or Jobs, spawn nested orchestration, or delegate further unless the user explicitly requests a different orchestration structure.
- A Bridge-managed Agent may use ordinary repository tools available inside its own execution context for its bounded assignment; that does not make it a Bridge caller.

## Use the live contracts

- Treat the latest exposed Bridge tool schemas as authoritative for constructing calls. Do not rely on remembered field shapes, model names, effort values, or project-selection forms.
- Treat runtime validation and structured results as authoritative for admission, execution, and state. Refresh discovery or state when a schema, catalog, policy, or version conflict says the prior view is stale.
- Use `codex_status` as the authoritative source for accessible Activity, Agent, and Job state and versions. A transport timeout, detached response, or stale card is not a cancellation or terminal result.
- Use the repository and its artifacts as implementation truth, an optional Issue as the durable semantic ledger and context anchor, and accessible Bridge state as runtime truth.

Bridge meanings and invariant:

- An Activity is one project-scoped objective and acceptance boundary. Keep it open while admitting executable work.
- An Agent is a durable Codex collaborator/context that may serve multiple Jobs and later Activities.
- A Job is one admitted Codex turn. Job terminality never proves success and never completes an Activity by itself.
- Admit new Worker, Integrator, Verifier, or checkpoint-preparation Jobs only while the Activity is open.

## Establish the semantic baseline

1. Form the baseline from the explicitly approved Objective and Acceptance Criteria plus only explicitly approved amendments or Decisions.
2. Do not treat every Issue comment, plan, Worker claim, or historical Bridge result as canonical. Record ambiguity and obtain a decision when it would materially change implementation or acceptance.
3. Inspect the repository, applicable instructions, current changes, and relevant tests before routing work. Preserve unrelated and pre-existing changes.
4. If an Issue anchor is used, reconcile its approved semantic state with repository evidence before planning. The repository wins for what is implemented; the Issue wins only for durable approved semantics; neither overrides live Bridge runtime state.

For resumption:

- In the same conversation, reconcile the Issue, repository, and any still-accessible Bridge state before starting or retrying work.
- In a new conversation, restore semantic state from the Issue and repository only. Do not assume prior Activity, Agent, Job, or request identifiers remain accessible.

## Plan and route

- Prefer a direct Worker for a bounded implementation request.
- Add a non-mutating Planner only when decomposition, dependencies, or risk are genuinely unclear. Its output is advisory. The Planner must not edit the repository, mutate the Issue, or control lifecycle state.
- The invoking GPT owns the final DAG, wave boundaries, Agent routing, prompts, model/effort choices, acceptance decisions, Issue payloads, and lifecycle transitions.
- Keep each call bounded to one role, objective, write scope, expected artifacts, and evidence. Tell every role about the shared working tree and existing-change preservation.
- Treat a Planner DAG as coverage guidance, not the Verifier baseline. Verification always targets the latest approved semantic baseline.

Before each `codex_task` call, choose a model/effort pair only from the currently exposed, live-allowed combinations for that bounded call. Do not change Priority, Fast/service-tier preferences, or any user setting. Respect live continuation-override constraints. If a continuation rejects a selection change, either retain a compatible selection or use an explicitly fresh context with the required bounded handoff when the live schema permits it. Diagnose schema, policy, catalog, project, context, and task failures before escalating model, effort, context, or scope.

## Execute safe waves

Run Jobs in parallel only when all of these are true:

- Their dependency inputs are already stable.
- Write sets are disjoint, or all parallel Jobs are read-only.
- They will not race on generated files, manifests, lockfiles, migrations, formatting passes, shared caches, or repository-wide commands.
- One Job cannot invalidate assumptions another Job is reading.
- The repository can accept each Job independently if another admission or execution fails.

Otherwise serialize them. Separate Agents may still share one working tree; Agent separation does not isolate files.

Background fan-out is non-atomic. Record which calls were admitted and which failed, without assuming a batch rollback. Fan in by bringing every admitted Job to an authoritative terminal observation through the Activity card or bounded `codex_status` waits. After interruption, use `codex_status` to recover and reconcile before issuing a new logical call.

At fan-in, apply a semantic acceptance gate to every Job:

- Inspect terminal status, terminal origin, structured result/error, omitted-result warnings, and any pending interaction.
- Inspect the actual diff, artifacts, and relevant test or check output.
- Confirm any reported background process or other continuing side effect has ended or is explicitly accounted for.
- Treat failed, interrupted, cancelled, incomplete, conflicting, or unverifiable output as unresolved even though the Job is terminal.
- Treat Worker self-assessment as a lead, never as verification evidence.

Retry an exact logical Bridge call with the same `requestId` only when the complete execution payload is identical. Any changed prompt, routing, model/effort, context, or intended work is a new logical call and needs a new `requestId`.

## Integrate and verify

- Use an Integrator only when parallel work, cross-cutting changes, generated artifacts, or merge conflicts require a distinct integration pass. Otherwise let the responsible Worker finish the bounded change.
- When practical, use a fresh Verifier Agent that did not implement or integrate the change. Give it the latest approved semantic baseline, the repository state, and the evidence to inspect; do not substitute the Planner DAG for acceptance criteria.
- Require observable verification evidence such as targeted tests, static checks, rendered artifacts, behavioral probes, or a precise justified limitation. A fresh Agent alone is not evidence.
- If verification exposes defects, keep or return the Activity to open, route bounded repairs, and verify again.

Complete all executable Jobs, the Verifier Job, and any needed checkpoint-preparation Job while the Activity is open. Do not seal or start Bridge verification merely because Workers say they are done.

## Transition the Activity from authoritative state

Immediately before any lifecycle mutation, read the exact current Activity state and version. Use only operations exposed by the live `codex_activity_update` schema, and inspect the returned Activity after every transition.

For an Activity using the live `manual` + `verify` policy combination:

1. Finish semantic acceptance, the fresh Verifier when practical, and required Issue checkpoint work while the Activity is open.
2. Re-read Activity and Job state; ensure no executable or side-effect work remains active.
3. Send `start-verification` with the current authoritative version and inspect the returned lifecycle, verification state, and new version.
4. Using authoritative evidence and the current returned/refreshed version, send `verification-passed` or `verification-failed`.
5. Inspect the returned Activity state. Do not infer or issue a follow-up `complete` merely from an operation name. The returned live state determines whether the Activity is completed, reopened for repair, or needs another permitted action.

Never couple Issue lifecycle to Activity lifecycle automatically. Closing an Issue or changing labels, assignees, or milestones requires explicit authorization independent of Bridge completion.

## Keep identifiers in their proper scope

- `requestId`: one logical Bridge call; reuse only for its exact retry.
- `activityPresentationId`: one UUID for the current assistant response; reuse it across all `codex_task` calls in that response when the live schema exposes it, then use a new value in the next response.
- `checkpointId`: one durable Issue checkpoint identity; never derive it from or reuse a Bridge `requestId`.

Do not use presentation identity as execution identity, or any of these identifiers as a grouping shortcut outside its stated scope.

## Use an optional GitHub Issue Context Anchor

Anchorless operation is valid. When an anchor is requested or useful:

- Accept only an exact `owner/repo#number` reference or canonical Issue URL. Never infer an Issue by title search.
- Confirm the live Issue capability can access the exact repository and read the Issue. Confirm write capability separately before promising a checkpoint mutation.
- If required read access is unavailable, stop the Issue-dependent portion as a blocker. If the anchor was optional, continue explicitly in anchorless mode.
- If a required write cannot be performed, either treat it as a blocker or report a bounded pending-sync payload according to the user's required completion level. Never claim an unsent checkpoint was written.
- One cross-project Issue may anchor multiple project-scoped Activities. Preserve each Activity's separate runtime and repository boundary.

Planner, Worker, Integrator, and Verifier roles are Issue readers by default. They do not mutate it. The invoking GPT may authorize only one exact bounded mutation payload at a time, and Issue writes must be serialized.

Use the Issue as a semantic ledger, not a runtime Job journal:

- Prefer append-only managed checkpoints; do not automatically rewrite the full body.
- Allow checkpoint kinds only for `decision`, `milestone`, `blocker`, `plan-change`, and `verification-evidence`.
- Promote a `milestone` only after observable acceptance, not because a Job became terminal.
- A checkpoint becomes part of the semantic baseline only when it records an explicitly approved Decision or amendment.
- Do not record model/effort choices, Agent/Job/request identifiers, wave or running state, raw prompts, private reasoning, secrets, local absolute paths, full logs, or internal Bridge identifiers.
- Keep checkpoint payloads reviewable: checkpoint ID, kind, concise semantic statement, accepted evidence or repository-relative references, and any explicit pending decision.

## Finish

Report the accepted implementation outcome, repository evidence, verification evidence, Activity state, and any blocker or pending Issue sync. Distinguish observed facts from Worker claims. Do not claim completion while semantic acceptance, an admitted Job, a background side effect, required verification, or a required checkpoint remains unresolved.
