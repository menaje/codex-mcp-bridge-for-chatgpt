# codex-mcp-bridge

A small policy layer between ChatGPT and the official local Codex MCP server.

```text
ChatGPT
  -> OpenAI Secure MCP Tunnel
  -> codex-mcp-bridge (loopback HTTP)
  -> codex mcp-server (stdio)
  -> one explicitly allowed repository
```

The official Codex MCP server already provides `codex` and `codex-reply`. This bridge intentionally adds only the controls needed for safer daily use from ChatGPT:

- `bridge_status`: inspect the active policy.
- `codex_read`: force a read-only Codex session.
- `codex_run`: start a policy-limited read or write session.
- `codex_reply`: continue only a thread created through this bridge.
- `codex_job_status`: retrieve a long-running result.

## Security defaults

- Binds to `127.0.0.1`.
- Allows one current working directory unless roots are explicitly configured.
- Uses the `read-only` Codex sandbox.
- Uses the `on-request` approval policy.
- Never exposes `danger-full-access`.
- Blocks workspace writes unless the bridge owner starts a write profile.
- Rejects paths outside the configured real-path roots.
- Refuses repositories containing common secret-file names unless the owner explicitly disables the preflight.
- Limits prompt size and concurrent Codex jobs.
- Suppresses upstream Codex stderr unless local debug logging is enabled.

These controls are a policy layer, not OS-level isolation. Use a staging copy, container, VM, or separate OS user when hard isolation is required.

## Requirements

- Node.js 20 or later; Node.js 22 is recommended.
- Codex CLI installed, authenticated, and providing `codex mcp-server`.
- `tunnel-client` and an OpenAI Secure MCP Tunnel for ChatGPT access.

Official references:

- [Run Codex as an MCP server](https://learn.chatgpt.com/docs/mcp-server)
- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)

## Install

```bash
npm ci
npm run check
```

## Local smoke test

Local mode never creates a public endpoint:

```bash
npm run bridge:local -- --root /absolute/path/to/repository
```

The MCP endpoint is `http://127.0.0.1:8876/mcp` and the health endpoint is `http://127.0.0.1:8876/healthz`.

## Secure MCP Tunnel

Create a tunnel in OpenAI Platform, then provide its runtime credentials outside this repository:

```bash
export CONTROL_PLANE_API_KEY="<runtime-key>"
export CONTROL_PLANE_TUNNEL_ID="tunnel_..."

npm run bridge:secure -- --root /absolute/path/to/repository
```

The launcher builds the bridge, starts it on loopback, initializes the tunnel profile, runs `tunnel-client doctor`, and keeps the tunnel client running.

For a deliberate write session:

```bash
npm run bridge:secure -- --root /absolute/path/to/repository --write
```

Do not leave a write profile running when it is not needed.

### macOS Keychain

```bash
security add-generic-password -a "$USER" -s "codex-mcp-bridge:control-plane-api-key" -w "<runtime-key>" -U
security add-generic-password -a "$USER" -s "codex-mcp-bridge:control-plane-tunnel-id" -w "tunnel_..." -U

CODEX_MCP_BRIDGE_ROOT=/absolute/path/to/repository npm run bridge:secure:keychain
```

Use `bridge:secure:write:keychain` only for an intentional write session.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEX_MCP_BRIDGE_ROOTS` | current directory | Comma-separated absolute allowed roots |
| `CODEX_MCP_BRIDGE_DEFAULT_SANDBOX` | `read-only` | `read-only` or `workspace-write` |
| `CODEX_MCP_BRIDGE_ALLOW_WRITE` | unset | Must be `1` before write mode is accepted |
| `CODEX_MCP_BRIDGE_APPROVAL_POLICY` | `on-request` | `on-request` or `untrusted` |
| `CODEX_MCP_BRIDGE_MAX_CONCURRENT_JOBS` | `2` | Maximum active Codex calls |
| `CODEX_MCP_BRIDGE_MAX_PROMPT_CHARS` | `50000` | Maximum prompt length per tool call |
| `CODEX_MCP_BRIDGE_UPSTREAM_TIMEOUT_MS` | `180000` | Codex MCP call timeout |
| `CODEX_MCP_BRIDGE_FAST_RETURN_MS` | `25000` | Delay before returning a job ID |
| `CODEX_MCP_BRIDGE_JOB_TTL_MS` | `21600000` | Completed job retention |
| `CODEX_MCP_BRIDGE_DISABLE_SECRET_SCAN` | unset | Explicitly bypass filename preflight |
| `CODEX_MCP_BRIDGE_DEBUG` | unset | Emit local diagnostic errors and Codex stderr |

The old `CODEX_GPT_BRIDGE_*` variable prefix is accepted temporarily for upstream compatibility.

## ChatGPT setup

See [docs/chatgpt-setup.md](docs/chatgpt-setup.md).

## Upstream

This repository is derived from [DeepCogNeural/codex-gpt-bridge](https://github.com/DeepCogNeural/codex-gpt-bridge) under the MIT License. See [UPSTREAM.md](UPSTREAM.md) for the scope of this fork.
