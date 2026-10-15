# Connect Codex MCP Bridge for ChatGPT

The bridge runs Codex through the selected local Codex CLI App Server. ChatGPT
reaches that bridge over MCP 2026-07-28. See the
[migration guide](mcp-2026-07-28-migration.md) before replacing an older
deployment.

For ordinary first use, follow [Setup](setup.md), try a [first task](../README.md#try-your-first-task),
and [create a reusable skill](skills.md#create-and-use-your-first-skill). This
page also covers the tool contracts and upgrade checks used by operators.

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

1. Enable Developer mode in **ChatGPT Settings → Security and login**.
2. Create a developer connection at [ChatGPT Plugins](https://chatgpt.com/plugins) and choose **Connection → Tunnel**.
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
- processing speed, concurrency, conversation storage, Codex-app visibility, history retention, and UI language;
- custom model descriptions and their version history.

See [settings choices](setup.md#settings-reference) for the current native
destinations and card save behavior. Use the separate native Skill Library to
import or edit reusable Markdown procedures; ChatGPT can search and read them
through the skill tools. Account and CLI selection are managed on the server
Mac under **Codex Account & Installation**.

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

New ordinary Jobs use `relay-card` by default. Task calls and question answers
automatically attach the blank Relay without activation. Its commit-driven
watcher sends exact event/Job references to the originating GPT across the same
Activity's authorized Jobs. Dashboard opens only on explicit display request.
Exact original/input reads and optional bounded waits remain available. Timeout,
host abort or card teardown never cancels Codex or authorizes replacement.

For preapproved A→B, declare the exact approved B prompt on A admission. After
reading A's result, use its issued followup ID, canonical request ID and current
reviewed version. Repeated calls converge to that B.

For B decided after reviewing A within the original goal and approvals, use
`relayFollowup` with A's exact current event ID, one stable logical step and
reviewed version. Retain the original Activity; normal checks authorize the
Agent, project, access, context and model. Atomic admission binds an issued
followup ID and canonical request ID to the immutable payload, including after
response loss or different caller IDs. Distinct parallel steps remain distinct.
Page existing receipts with `codex_status` query kind `followups`. Never recreate
expired or already admitted work. Ask the user only for a new decision or
approval; a notice/result offer does not prove GPT review or goal completion.

Use `codex_relay_control` to distinguish stopping messages from stopping future
followup admission. Existing `codex_cancel` stops execution; explicit Activity
completion ends the goal. A single host message acceptance never ends it.

Document visibility is not the relay's execution gate. Host teardown stops that
iframe, and retained enrolled events recover on the next valid connection.
Complete container/message invisibility and automatic GPT resumption while the
host app is closed are not guaranteed. No external Events, callbacks, schedules
or extra model is added as a fallback. See [relay delivery](relay-delivery.md).


When automatic continuation does not occur, return to the originating authenticated conversation and request an exact retained Job read. The [#222 evidence](audits/2026-10-03-issue-222-final-evidence.md) preserves actual 30/60-minute results and user-confirmed resumption after screen departure/app exit. These observations remain valid for the tested environment and are not an unconditional guarantee for every host. A result-expired receipt establishes prior execution and cannot authorize rerunning it.

## 6. Cards and questions

The active immutable cards are:

| Card | Open/read path |
| --- | --- |
| Settings | `codex_settings`, then private `codex_ui_read` |
| Dashboard | `codex_dashboard`, then private `codex_ui_read` |

The Dashboard shows retained and current work, including scoped monitoring and
controls. GPT asks for ordinary user decisions directly in the current ChatGPT
conversation. Original approvals retain their current formal response contract and are also visible in explicitly opened work detail. Required approvals are never inferred or bypassed.

For a complex choice, GPT may create a [standalone HTML file](standalone-decision-html.md).
The user sends its decision summary back to this conversation. That file cannot
call Bridge tools or approve a Codex action.

Open Dashboard only when the user explicitly asks to see the status card or dashboard. Use `codex_status` for ordinary status requests. Input, error, and approval states do not open a card automatically. Explicitly opened cards refresh display and retain their scoped management tools, while sending no chat message and starting no automatic followup.

## 7. Refresh after a release

Tool descriptors and card resource URIs are deployment metadata. After
deploying a change to either:

1. start the newly built bridge;
2. use **Refresh** on the ChatGPT connection;
3. close old Dashboard and Settings instances, then reopen current cards (use a new conversation if the host retains stale discovery);
4. verify the current resources listed in
   [the UI release policy](ui-release-compatibility.md).

Dashboard and Settings currently use v5 URIs. The v3-to-v4 transition removed
the sender API and automatic mount inputs; v5 introduces explicit processing
speed and scope. A server refusal cannot retract result text or a queued message
already held in an old v3 iframe; close those instances before accepting the cutover.

The bridge offers no old resource URI or old descriptor fallback. A conversation
that cached a previous resource must refresh and use the current card. Retired
Decision Card tools and the Decision v1 resource are absent after Refresh.
Previously mounted Decision Cards cannot submit or retrieve old receipts; send
any needed decision in the conversation instead.

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

1. Open Settings and register a project; confirm the retired delivery switch is absent.
2. Check automatic Relay descriptor/result association and exact result/receipt recovery with the deterministic #261 fixtures; Dashboard remains closed unless explicitly requested. Real GPT A→review→B is outside #261 completion criteria.
3. Exercise a current question and approval boundary without automatically displaying Dashboard; task/answer calls reconnect only the blank Relay. Refresh input after user deliberation before answering the same current question.
4. Read overview, Job list, Activity and thread summaries; verify exact retrieval actions without embedded result text.
5. Explicitly open Dashboard. Verify state/history refresh and scoped management while observing no chat message or automatic followup.
6. Verify old completion calls are refused without cancelling, failing or recreating Jobs; existing completed B replays and unexecuted legacy B requests follow the documented reapproval rule.
7. Restart the bridge and verify retained work and upgrade settings remain consistent. Confirm Bridge/app build identity and the actual v5 URI/HTML hash served by the connector.

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

## #247 optional lifecycle receiver

Ordinary admission uses the independent blank Relay and does not depend on this receiver. In the explicit OAuth Events experiment,
follow the returned original-root `codex_event_access` action. The optional
`codex.job.lifecycle` choice connects current questions and later Events Jobs
in the original Activity/Agent/project through one verified native receiver.
B admission/result/receipt still use the normal task/status APIs; a dynamic B
must request Events explicitly. Do not create another native subscription for
B when exact status reports an active lifecycle `rootJobId`. Preserve the
returned root name and arguments during native refresh/unsubscribe.

The [updated W0~W5 plan](issue-247-implementation-plan.md) excludes real GPT
resumption and real A→review→B acceptance trials as well as duration substitutes.
The user checks real operation while using it. Missing ordinary Chat Pro host
APIs remain explicit implementation dependencies, never invented permissions.
