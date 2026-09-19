# Connect Codex MCP Bridge for ChatGPT

The bridge runs Codex through the selected local Codex CLI App Server. ChatGPT
reaches that bridge over MCP 2026-07-28. See the
[migration guide](mcp-2026-07-28-migration.md) before replacing an older
deployment.

## 1. Prepare Codex and the bridge

Confirm that Codex is installed and authenticated:

```bash
codex --version
codex app-server --help
```

Install and verify the bridge:

```bash
npm ci
npm run check
```

The macOS app can manage the same bridge and tunnel configuration:

```bash
npm run macos:bundle
open "macos/build/Codex MCP Bridge for ChatGPT.app"
```

See [Codex runtimes](codex-runtimes.md) for installation, authentication, and
the central execution policy.

## 2. Configure the Secure MCP Tunnel

Create an MCP tunnel in OpenAI Platform and associate it with the ChatGPT
workspace that will use it. Keep its runtime key and tunnel ID outside Git.

```bash
install -d -m 700 "$HOME/.config/codex-mcp-bridge"
install -m 600 .env.example "$HOME/.config/codex-mcp-bridge/.env"
vi "$HOME/.config/codex-mcp-bridge/.env"
npm run bridge:secure
```

The default profile forwards the loopback HTTP endpoint. To run the tunnel's
local stdio sample instead, stop the HTTP profile and use:

```bash
npm run bridge:secure:stdio
```

Do not run both profiles against the same tunnel. Both use the same durable
bridge state and accept only the current MCP protocol.

The launcher reads `~/.config/codex-mcp-bridge/.env` by default. The file must
be an owner-only regular file and must not be inside a registered project.
Use `--env-file <path>` or `CODEX_MCP_BRIDGE_ENV_FILE` for an explicit alternate
file.

The normal starting policy is read-only. An operator can start a bridge with a
broader saved ceiling:

```bash
npm run bridge:secure -- --allow-write
npm run bridge:secure -- --allow-full-access
```

The caller still cannot set a per-task sandbox or approval policy. The bridge
checks its saved settings and the operator ceiling at admission.

## 3. Add the ChatGPT connection

1. Enable Developer mode in ChatGPT Settings.
2. Create a developer connection and choose **Tunnel**.
3. Select the configured tunnel ID.
4. Choose **No Auth**. The loopback bridge and Secure MCP Tunnel form the
   transport boundary.
5. Confirm the current model-visible inventory has the twelve tools in
   [Card tools](card-tools.md).

The bridge supports only the 2026-07-28 request envelope. It rejects a legacy
MCP initialization handshake, session ID, `GET` notification stream, `DELETE`
session operation, and replay request. Tunnel and native requests may omit
`Origin`; when a browser supplies an Origin header it must match
`CODEX_MCP_BRIDGE_ALLOWED_ORIGINS` or the allowed-host default.

## 4. Configure the bridge

Ask ChatGPT to open Settings. The card manages:

- registered projects;
- read-only, write, or full-access policy within the operator ceiling;
- fixed or automatic model and reasoning-effort selection;
- Fast mode, concurrency, Codex-app thread visibility, and UI language.

Projects are named paths stored on the bridge. ChatGPT receives a project name,
opaque `projectRef`, and `projectRevision`; it does not receive the path or the
private project ID. A fresh task must use an exact current selector. If a
project changes, read it through `codex_status` before retrying the task.

## 5. Use the current task contract

Read the model catalog when the current policy requires a model choice:

```json
{ "refresh": true }
```

`codex_models` returns one current output contract with `selectionMode` and the
allowed model/effort pairs. In fixed mode, omit task `selection`. In automatic
mode, use an exact listed pair where required.

For a fresh task, use the `taskContractVersion: "6"` and
`executionEnvelopeRef` advertised by the current `tools/list` result. Provide a
new `requestId` for each logical task and the exact registered project
selector. Reuse that request ID only for an identical retry.

```json
{
  "requestId": "new UUID",
  "taskContractVersion": "6",
  "executionEnvelopeRef": "exact descriptor constant",
  "prompt": "implement the requested change",
  "project": {
    "name": "Bridge",
    "projectRef": "exact opaque reference",
    "projectRevision": 1
  }
}
```

The call returns after the durable admission receipt is saved; it does not wait
for completion. If that response is lost, query the same `requestId` with
`codex_status` instead of inventing a new one. For an active turn, use
`codex_steer`. Use `codex_status` to read an exact request, Job, Activity,
thread, project, or bounded input wait. Use `codex_cancel` only for explicit
stop intent and its required version/idempotency arguments.

## 6. Cards and questions

The active immutable cards are:

| Card | Open/read path |
| --- | --- |
| Settings | `codex_settings`, then private `codex_ui_read` |
| Dashboard | `codex_dashboard`, then private `codex_ui_read` |

The Dashboard shows retained and current work, including scoped monitoring and
controls. GPT asks for ordinary user decisions directly in the current ChatGPT
conversation; original Codex approvals and non-ordinary input remain in the
Dashboard work detail.

Every new Job's task result includes an exact Dashboard render action. GPT must
open it immediately; there is no Settings toggle. While that originating card
is live, terminal completion uses one server lease and a standard `ui/message`
to resume the same conversation. The resumed turn reads the exact retained
result with `codex_status({query:{kind:"completion",receipt:"…"}})`. If the card
is closed, torn down, or disconnected, the Job remains queryable but automatic
follow-up is not guaranteed. If the current authenticated response has already
received that exact retained result through a Job or request query before the
card claims it, the pending automatic follow-up is settled instead of creating a
duplicate turn. An explicit `scopeId`, a running result, or a delivery that has
already crossed the card send boundary does not trigger that suppression.

## 7. Refresh after a release

Tool descriptors and card resource URIs are deployment metadata. After
deploying a change to either:

1. start the newly built bridge;
2. use **Refresh** on the ChatGPT connection;
3. start a new conversation or reopen the card;
4. verify the current resources listed in
   [the UI release policy](ui-release-compatibility.md).

The bridge offers no old resource URI or old descriptor fallback. A conversation
that cached a previous resource must refresh and use the current card.

Treat the refresh as a connector-contract transition. Keep the old connection
available until the current bridge is serving, refresh the connection, then
start a new conversation and verify discovery before relying on a tool call or
card. A call from an old cached descriptor may fail by design; it is not a
reason to restore a prior tool schema or resource URI. Confirm the refreshed
connection's enabled action permissions before testing a write-capable flow.

For a source release, verify the generated manifest before deployment:

```bash
npm run build
npm run release:check
npm test
```

## 8. Smoke checklist

In a fresh ChatGPT conversation:

1. Open Settings and register a project.
2. Open Dashboard and Settings; confirm both load and Settings has no card-generation or completion-delivery toggle.
3. Ask for a small comparison decision card; confirm one selection and verify GPT reads its exact semantic result in the same conversation without starting Codex.
4. Call `codex_models` and confirm its one current catalog response.
5. Start a harmless task with contract version 6 and its exact envelope
   constant.
6. Confirm the task opens its exact Dashboard and, without a diagnostic button or user message, terminal completion resumes the same conversation and reads the exact result once.
7. If Codex asks an ordinary question, answer it through the current ChatGPT
   conversation and verify that it reaches the exact active Job.
8. Restart the bridge, reconnect, and confirm retained work is still visible.

For release acceptance, also record a real current-protocol discovery, tool
call, and card open through ChatGPT and Secure MCP Tunnel. A host that cannot
consume the current protocol is a deployment blocker; do not restore a legacy
connection to work around it.

## Troubleshooting

- **Tunnel unavailable:** confirm the workspace association and Tunnel Read/Use
  permission, then run `tunnel-client doctor` for the configured profile.
- **Runtime dotenv rejected:** use a non-symlink owner-only file outside a
  registered project.
- **Old schema or card:** deploy the current build, refresh the connector, and
  reopen the card. Previous URIs and tool contracts are intentionally absent.
- **`PROJECT_REQUIRED` or stale project:** use `codex_status` with
  `{ "query": { "kind": "project", "name": "…" } }`, then retry with the
  current selector and a new request ID.
- **Task policy error:** read `codex_models({ "refresh": true })`, adjust only
  the allowed model selection, and retry with a new request ID.
- **Unauthorized or Origin denied:** confirm the local auth setting, host
  allowlist, and browser Origin allowlist. Do not broaden them merely to make a
  failed request pass.
