# Security model

## Trust boundary

The bridge is designed for a single trusted operator connecting ChatGPT to a narrow local repository through OpenAI Secure MCP Tunnel. It binds to loopback and does not create a public ingress endpoint.

The tunnel transport, ChatGPT workspace policy, bridge policy, Codex sandbox, filesystem permissions, and operating-system isolation are separate layers. No one layer replaces the others.

## Exposed capabilities

- `bridge_status` returns the active policy and upstream tool availability.
- `codex_read` always starts Codex with the `read-only` sandbox.
- `codex_run` can use `workspace-write` only when the owner started a write profile.
- `codex_reply` accepts only a live thread created through this bridge.
- `codex_job_status` returns a retained asynchronous result.

The bridge does not expose raw shell, process-control, arbitrary Codex config, `danger-full-access`, or a general Responses API proxy.

## Enforced defaults

- Loopback host binding.
- Real-path allowlist for working directories.
- Read-only sandbox.
- `on-request` approval policy.
- Two concurrent jobs at most.
- One active job per working directory.
- 50,000 characters per prompt.
- Six-hour session and completed-job retention.
- Common secret-file filename preflight.
- Upstream stderr disabled unless explicit local debug mode is enabled.

## Authentication

Secure Tunnel mode starts a loopback-only HTTP server with no application-level authentication. The OpenAI-managed tunnel and its organization/workspace permissions are the transport boundary. The bridge rejects no-auth mode on non-loopback host bindings.

When exposing the HTTP endpoint through another mechanism, configure a long bearer token or place an OAuth 2.1/PKCE-capable proxy in front of it. Bearer authentication is intended for controlled private deployments, not public plugin submission.

## Remaining risks

- The allowed-root check constrains the starting directory, not every path Codex may attempt to access.
- Filename scanning detects common secret files, not secret values embedded in ordinary source files.
- Write mode allows Codex to change files in the workspace and may execute approved commands.
- Tool results and retained jobs can contain repository content in process memory.
- A compromised local user account can access the same files and processes.

For sensitive code, expose a sanitized staging copy and run the bridge under a separate OS user, container, or VM with explicit filesystem and network policy.
