# Issue #43 descriptor and transport audit

Date: 2026-08-31 (Asia/Seoul)

## Scope

This audit records the original failed dynamic-descriptor experiment and the
replacement stable `codex_task` contract-v2 implementation. The completion
criterion is one-time adoption of v2 followed by ordinary Settings, project,
availability, and model-catalog changes in the same existing conversation
without another connection Refresh.

Official OpenAI boundaries used for the implementation:

- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
  accepts either a local stdio `--mcp-command` or an HTTP `--mcp-server-url`.
- [Developer-mode metadata refresh](https://developers.openai.com/plugins/deploy/connect-chatgpt#refresh-metadata)
  still requires connection **Refresh** when the published static tool or UI
  metadata itself changes. A server cannot retroactively replace an input
  schema already cached by a host conversation.

## Local automated evidence

### Descriptor size

The reproducible fixture combines 100 maximum-length project names with the
current full seven-model/effort catalog fixture. Contract v2 deliberately does
not serialize either inventory.

| Measurement | Bytes |
| --- | ---: |
| Input plus output schemas | 7,874 |
| Complete serialized `codex_task` descriptor | 10,110 |
| Hard descriptor limit | 131,072 |
| Remaining headroom | 120,962 (92.29%) |

Reproduce with:

```bash
CODEX_ISSUE43_AUDIT=1 npx vitest run test/tools.test.ts \
  -t "bounds the worst-case 100-project" \
  --maxWorkers=1 --disableConsoleIntercept
```

The bridge rejects a larger complete snapshot before publication with
`CODEX_TASK_DESCRIPTOR_TOO_LARGE`. Byte size is the authoritative protocol
budget. No model-token estimate is claimed because the host's descriptor
serialization/tokenizer is not an MCP server contract.

### Stable contract and execution admission

- Public input requires `taskContractVersion: "2"` plus a stable opaque
  `executionEnvelopeRef` over input generation and operator/static maximum.
- The public descriptor contains generic closed project, project lookup,
  model/effort selection, and operator-bounded sandbox shapes. It contains no
  project/catalog/settings values and stays byte-identical across their changes.
- Same-tool `projectLookup` returns an exact selector without creating an
  Activity, Agent, Job, session, filesystem mutation, or upstream turn.
- Each new call privately captures the mutable saved execution policy, saved
  concurrency ceiling, and resolved admission-catalog fingerprint, then
  rechecks them at every async/SQLite admission boundary. A race returns
  `EXECUTION_POLICY_CHANGED` before effects and retries on the same v2 contract
  without Refresh.
- An operator/static envelope mismatch returns `EXECUTION_ENVELOPE_CHANGED` and
  requires Refresh. Cached pre-v2 public `executionPolicyRef` calls remain
  fail-closed migration compatibility.
- Current v2 request hashes use version 7. Exact admitted v7 replay is resolved
  before current settings/project validation and creates no second upstream turn.

Covered by `test/modelCatalog.test.ts` and `test/tools.test.ts`.

### Notification failure containment

The coordinator calls the protocol server's Promise-returning
`sendToolListChanged()` directly. Synchronous and asynchronous failures are
counted, cannot escape as unhandled rejections, and receive one delayed retry
per descriptor epoch. A successful send remains only transport evidence.

Covered by `test/modelPolicyTransport.test.ts`, including a rejected first
send followed by a successful bounded retry.

### Transport and packaging

- Stateful HTTP keeps bounded sessions/replay for genuine static descriptor or
  UI changes.
- Persistent stdio has byte-framed initialize/list/call coverage and proves an
  ordinary Settings save leaves the Task descriptor identical with zero false
  `tools/list_changed` notifications.
- stdio shutdown attempts runtime, upstream, and state-store cleanup even when
  an earlier close fails.
- `--no-build` validates `dist/cli.js` for HTTP and both `dist/stdio.js` and
  `dist/stdioServer.js` for stdio.
- The package exposes one manifest-authoritative CLI bin; `dist/stdio.js`
  remains packaged and is invoked by the Secure Tunnel launcher. The stale
  second package-lock bin declaration was removed.

### Validation snapshot

All commands completed successfully on 2026-08-31:

- `npm test`: 33 files, 475 tests passed.
- `npm run build` and `npm run release:check`.
- `npm run app-server:compat:check`: CLI 0.145.0 schema lock matched.
- `npm run skills:check`.
- `git diff --check`.
- `npm audit --omit=dev`: zero production vulnerabilities at every severity.
- `npm pack --dry-run --json`: 121 files; `dist/cli.js`, `dist/stdio.js`,
  and `dist/stdioServer.js` were present, and package/package-lock exposed the
  same single `codex-mcp-bridge` bin.

## Contract-v2 live Secure Tunnel / ChatGPT acceptance

The deciding positive run was completed on 2026-08-31 in one signed-in ChatGPT
Work conversation through the deployed Secure MCP Tunnel. The conversation URL
was `https://chatgpt.com/c/6a952839-768c-83e8-ba94-670a267e299e`.

1. One developer-mode **Refresh** adopted the static v2 descriptor. The live
   management surface exposed `taskContractVersion: "2"`, a constant
   `executionEnvelopeRef`, generic `project` and `projectLookup` fields, and no
   public `executionPolicyRef`, registry revision, or catalog-shaped branches.
2. In that conversation, same-tool `projectLookup` returned the exact active
   selector `코니 / prj_6ZwA1AqtuL-KpsZuAB71wQ / revision 1` without creating a
   Job. A foreground read-only control Job then completed on App Server with
   `gpt-5.6-luna / low` and no filesystem mutation.
3. The Settings card changed `showBridgeThreadsInCodexApp` from `false` to
   `true`, producing settings revision 42. No connection or descriptor Refresh
   followed.
4. The same already-open conversation and cached v2 descriptor immediately
   resolved `코니` again and admitted exactly one new foreground Job. Job
   `9facc502-7c40-4971-ab9a-defc7c62529f` completed with request-hash version 7,
   policy revision 42, read-only access, `gpt-5.6-luna / low`, and one upstream
   turn. `EXECUTION_POLICY_CHANGED`, `EXECUTION_ENVELOPE_CHANGED`, and
   `PROJECT_REGISTRY_CHANGED` did not occur.
5. The Settings card restored `showBridgeThreadsInCodexApp` to `false`, producing
   settings revision 43. Without Refresh, another same-tool lookup succeeded
   and again returned none of the three descriptor-staleness errors.
6. Independent SQLite inspection after the run found `accessStrategy:
   read-only`, `activityCardVisibility: background-only`,
   `completionHandoff: auto-handoff`, `maxConcurrentJobs: 30`, registry revision
   2, the original active/archived project set, and zero running, terminating,
   or termination-failed Jobs. A ctime scan of the selected project root found
   no file changes during the acceptance window.

The post-mutation acceptance path itself had one admitted Task Job and one
upstream turn. A separate control attempt before the mutation encountered an
upstream capacity failure on the saved fallback model and recovered with an
explicit supported model; that terminal upstream condition is unrelated to
descriptor adoption and is retained in the store rather than hidden.

## Historical pre-v2 live Secure Tunnel / ChatGPT result

The first real-host acceptance run was completed on 2026-08-31 against the
signed-in ChatGPT Work web surface (Korean UI) through Secure MCP Tunnel client
`0.0.12`. The result is **not** a live-refresh acceptance: both persistent
transport candidates failed the deciding existing-conversation gate, while the
runtime fail-closed checks behaved correctly.

### Stateless HTTP control

1. Before developer-mode **Refresh**, ChatGPT still exposed the legacy
   `codex_task.project` selector `{ name, registryRevision }`, with
   `registryRevision: 2`, and did not expose `executionPolicyRef`.
2. After **Refresh**, the connection exposed `executionPolicyRef` plus the
   required `{ name, projectRef, projectRevision }` selector and no longer
   exposed `registryRevision` in `codex_task`.
3. A new ChatGPT conversation then admitted one foreground read-only
   `codex_task` call. The retained Job completed and returned
   `ISSUE43_STATELESS_OK`; the bridge reported zero running Jobs afterward.

This confirms that the current documented Refresh/new-conversation recovery
works, but it does not provide live adoption in an existing conversation.

### Stateful Streamable HTTP

- A direct loopback MCP initialize returned `mcp-session-id`, and an immediate
  initialized request using that header successfully called `codex_status`.
  This proves the bridge's stateful HTTP path itself was available.
- Through the real Secure Tunnel HTTP target, ChatGPT-originated
  `resources/read` and `tools/call` commands reached the target without a usable
  MCP session and were rejected with HTTP 400. Tunnel diagnostics recorded the
  failures as `target_http` / `invalid_mcp_error`.
- ChatGPT prose that guessed or repeated a zero-Job count after those failures
  is not counted as tool success.

Therefore Secure Tunnel HTTP mode, as exercised by this client/runtime pair,
did not preserve the stateful MCP session contract and cannot be selected.

### Persistent stdio

1. The same Secure Tunnel profile was switched to its documented
   `--mcp-command` path. Two already-open ChatGPT conversations each completed
   a `codex_status` call through the one long-lived stdio bridge, both reporting
   zero running Jobs.
2. In the Settings card, `showBridgeThreadsInCodexApp` was changed from `false`
   to `true`. This is included in `executionPolicyRef`, so the mutation produced
   a new execution-policy ref and descriptor epoch without broadening filesystem
   authority.
3. Without manual Refresh, the second existing conversation was instructed to
   call `codex_task` exactly once and not retry. The bridge returned
   `EXECUTION_POLICY_CHANGED`. No Activity, Agent, Job, filesystem operation, or
   upstream Codex turn was admitted.
4. The setting was restored to `false`. The persisted state afterward was
   `settingsRevision: 41`, `accessStrategy: read-only`,
   `activityCardVisibility: background-only`, and zero running Jobs.

This is the deciding negative result: a long-lived stdio transport can carry
ordinary calls from multiple conversations, but the real ChatGPT host did not
re-list and use the new descriptor in an already-open conversation after the
descriptor-changing mutation. Notification transport capability must not be
reported as client adoption.

### Superseded transport-only decision

The run proved that a dynamic input descriptor cannot be made reliable merely
by choosing a persistent transport. Stateless HTTP remains the default and both
persistent transports remain experimental, but transport is no longer part of
the ordinary Settings-change correctness path. Contract v2 removes those
changes from the descriptor boundary instead.

The default LaunchAgent/stateless profile was restored after the run. Its
initialize response had no MCP session header, `/healthz` was healthy, the
original Settings values were restored, and the persistent store contained no
running/terminating Jobs.

## Contract-v2 completion gates

1. **Passed live:** one Refresh adopted the new static v2 input contract; the
   descriptor exposed contract/envelope constants and no public mutable policy
   ref or registry/catalog branches.
2. **Passed live:** an execution-affecting preference changed in the same
   conversation without Refresh; the next Task used policy revision 42, returned
   no descriptor-staleness error, and admitted exactly one upstream turn.
3. **Passed automated and live lookup:** `test/currentSelectorReplay.test.ts`
   adds a project through Settings, resolves it through same-tool lookup, and
   runs it with the unchanged cached descriptor. The live run independently
   resolved and used the active `코니` selector before and after a Settings
   mutation without changing the operator's registry.
4. **Passed automated:** the same integration retries an exact already-admitted
   v7 request after Settings and registry changes and receives the retained
   original result with no second upstream turn.
5. **Passed live:** the original semantic Settings values and project set were
   restored, and independent SQLite inspection found zero nonterminal Jobs.

No additional bridge-owned infrastructure is required for this design. UI,
authentication, server identity/capabilities, operator/static envelope, and a
future input/output contract generation remain genuine Refresh/reinitialize
boundaries.
