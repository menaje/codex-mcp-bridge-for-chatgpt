# Codex MCP Bridge for ChatGPT security model

The bridge is for one trusted operator. It lets a ChatGPT conversation request
local Codex work, so its primary security boundary is the operator's computer,
the configured Secure MCP Tunnel, and the bridge's persisted policy. It is not
an operating-system sandbox or a multi-tenant service.

## Transport and connector boundary

- The bridge binds to loopback by default. The Secure MCP Tunnel is the intended
  remote transport.
- HTTP and stdio accept only MCP 2026-07-28. Legacy initialization, MCP
  sessions, GET notification streams, DELETE session close, and replay are
  rejected. There is no protocol fallback.
- Host validation runs before MCP dispatch. Browser requests with an Origin
  header must pass the explicit origin allowlist; native and Secure MCP Tunnel
  requests may omit Origin.
- Local HTTP authorization remains enforced unless the operator explicitly
  enables the local no-auth development setting. Tunnel credentials live in a
  private owner-only runtime dotenv file outside registered projects.
- The bridge does not expose a public OAuth authorization server. A well-known
  OAuth resource request returns 404 rather than implying an unsupported flow.

Protocol version and request metadata identify a current request. They do not
authorize a project, a task, a cancellation, or a settings change.

## Tool and card boundary

The current discovery inventory contains 12 model-visible tools and 14
app-private tools. Each has a closed JSON Schema 2020-12 input contract and a
validated output projection. The model-visible inventory does not expose
card-proof operations, private IDs, paths, complete settings, raw prompts, or
full result history.

App-private tools require their normal proof, scope, revision, ownership, and
permission checks. A card can use those tools only within the same bridge
authorization boundary; a widget identifier or resource URI is not authority.

There are four active immutable card resources: Settings, Activity, Dashboard,
and Question. Prior card URIs are not registered or served. Removing a card
revision does not delete its Activity, Agent, Job, result, question, or
idempotency records.

## Project and execution boundary

- A user must register each permitted folder. There is no implicit default
  project and no public path input.
- A fresh task supplies the exact public `projectRef` and `projectRevision`.
  The bridge resolves the private canonical path and checks availability again
  in the admission transaction.
- The bridge owns sandbox, approval, root, model, concurrency, and execution
  policy. Callers cannot override them per task.
- `taskContractVersion: "3"` and the exact `executionEnvelopeRef` are required
  for the current Task input. They bind the stable descriptor generation and
  operator-owned execution envelope; ordinary settings and project changes are
  checked separately at admission.
- Automatic model selection accepts only a current permitted model/effort
  pair. Fixed selection rejects a caller-supplied pair.

An allowed Codex access setting can still modify files, run commands, and use
network access as the local user. Use a separate OS account, a container, a
VM, or a disposable checkout when stronger isolation is needed.

## Scope, idempotency, and mutations

Conversation scope identifies the caller context. ChatGPT supplies it through
request metadata; another host may provide one persistent UUID scope. Scope is
validated on reads and mutations, but it does not replace project or policy
authorization.

Activity, Agent, Job, and thread IDs are opaque references, not authority. The
bridge rechecks scope and ownership on every read and mutation. A missing
reference and a reference copied from another conversation both return the
same recoverable `HANDLE_UNAVAILABLE` result, so the response does not reveal
whether an inaccessible handle exists.

Every logical Task, answer, cancellation, and other idempotent mutation has its
own `requestId`. A JSON-RPC ID is not interchangeable with it. Reusing a
request ID with different input is rejected. The bridge records a durable
admission/result or delivery state so an exact retry does not silently start
duplicate Codex work.

Cancellation is explicit. A transport disconnect, failed card refresh, or
expired UI does not automatically terminate a background Job. A destructive
operation rechecks its target, current version, scope, and any required
acknowledgement before it reaches Codex.

Tool-result `_meta` has two owners. MCP protocol metadata, including its
reserved namespace and W3C trace-context keys, is kept separate from bridge
UI hydration metadata. A duplicate or reserved app key fails closed; private
metadata cannot replace protocol-owned values.

## Data handling

The bridge stores settings, project registrations, scopes, Activities, Agents,
Jobs, bounded results, questions, requests, and idempotency records in a
private SQLite database. File ownership and mode are part of setup checks.
Retention and backup procedures are documented in
[Database schema and lifecycle](database-schema.md) and
[State upgrade and recovery](state-upgrade-recovery.md).

Model-visible results use a redacted projection. The Dashboard is a
bridge-wide view within the single trusted operator boundary, so project names,
Agent names, and Activity titles can still reveal work context across that
operator's conversations. Treat access to the ChatGPT account and tunnel as
access to that information.

The bridge avoids storing raw prompts in mutation/audit records where a digest
is sufficient, but Codex, its working directory, and retained task results can
still contain user-provided content. Do not register a folder that contains
secrets you do not intend Codex to read under the configured policy.

## Operational checks

Before deployment, run:

```sh
npm run build
npm test
npm run macos:check
npm run release:check
```

For a release that changes MCP or tool descriptors, verify a real ChatGPT +
Secure MCP Tunnel discovery, tool call, and card open. If the host rejects the
current protocol or schema, record a deployment blocker. Do not re-enable a
legacy wire or tool contract.
