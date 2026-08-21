# Security model

## Trust boundary

The bridge is designed for a single trusted operator connecting ChatGPT to a narrow local repository through OpenAI Secure MCP Tunnel. It binds to loopback and does not create a public ingress endpoint.

The tunnel transport, ChatGPT workspace policy, bridge policy, Codex sandbox, filesystem permissions, and operating-system isolation are separate layers. No one layer replaces the others.

## Exposed capabilities

- `codex_status` returns policy, metadata-only session summaries, and retained asynchronous results.
- `codex_models` returns the current selectable Codex model catalog.
- `codex_settings` returns owner limits and renders the settings card.
- `codex_update_settings` is app-only and persists validated preferences.
- `codex_task` starts or continues a tracked thread. It exposes
  `workspace-write` and `danger-full-access` only when the owner enables the
  corresponding capabilities.

The bridge does not expose a raw shell tool, process-control tool, arbitrary
Codex config, or a general Responses API proxy. An explicitly enabled
`danger-full-access` Codex session can nevertheless execute commands and access
the network as the current macOS user.

## Enforced defaults

- Loopback host binding.
- Real-path allowlist for working directories.
- Read-only sandbox.
- `on-request` approval policy.
- Thirty concurrent jobs at most.
- Concurrent read-only sessions are allowed in one working directory.
- All mutating jobs are serialized per working directory.
- One active job per Codex thread.
- 50,000 characters per prompt.
- Six-hour automatic session-resume window and completed-job retention.
- Durable session metadata stored in a user-private file with mode `0600`.
- Durable bridge preferences stored in a separate user-private file with mode
  `0600`, revision checks, and owner-limit validation.
- Asynchronous, in-flight-deduplicated common secret-file filename preflight.
- Four lazy Codex MCP workers with generation-safe connection retirement.
- Three-hour maximum inactivity timeout.
- At most 100 retained jobs and one MiB per retained job result by default.
- Upstream stderr disabled unless explicit local debug mode is enabled.

## Authentication

Secure Tunnel mode starts a loopback-only HTTP server with no application-level authentication. The OpenAI-managed tunnel and its organization/workspace permissions are the transport boundary. The bridge rejects no-auth mode on non-loopback host bindings.

When exposing the HTTP endpoint through another mechanism, configure a long bearer token or place an OAuth 2.1/PKCE-capable proxy in front of it. Bearer authentication is intended for controlled private deployments, not public plugin submission.

## Plugin approval boundary

ChatGPT's four plugin-permission choices control host-side confirmation before
an MCP tool call. They do not change the Codex sandbox. A private deployment may
set Codex approval policy to `never` so the plugin permission is the single
approval boundary, but doing so removes Codex's independent command prompt.
With the default `adaptive` strategy, the omitted/default sandbox remains
`read-only` and ChatGPT must still send an explicit mutation sandbox. A bridge
user can choose `read-only` or `always-full` in the settings card only within
owner-enabled capabilities. These preferences are shared by the bridge instance
because the private no-auth tunnel does not supply per-user identity.

## Remaining risks

- The allowed-root check constrains the starting directory, not every path Codex
  may attempt to access. In `danger-full-access`, Codex can access paths outside
  that root and use the network under the current macOS user's permissions.
- Filename scanning detects common secret files, not secret values embedded in ordinary source files.
- Mutation modes allow Codex to change files and may execute commands. Danger
  mode is not limited to the configured workspace.
- Enabling mutation support exposes the corresponding sandbox to the MCP caller; the bridge
  cannot independently prove that a particular call received fresh user approval.
- Jobs are spread across a small local Codex MCP pool. A worker-process failure
  can still affect the subset of calls assigned to that worker.
- Tool results and retained jobs can contain repository content in process memory;
  they are bounded but still lost on bridge restart.
- The 30-job setting is a bridge admission limit. The MCP host, tunnel, Codex,
  account, and machine can impose lower practical limits.
- Persisted session state contains thread ids and local working-directory paths, but not prompts or results.
- Persisted settings contain local paths and user defaults. They contain no
  tunnel credential, prompt, or result, but every user of the same private
  bridge connection shares them.
- No-auth loopback mode trusts other processes and users on the same Mac.
- A compromised local user account can access the same files and processes.

For sensitive code, expose a sanitized staging copy and run the bridge under a separate OS user, container, or VM with explicit filesystem and network policy.
