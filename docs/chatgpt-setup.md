# Connect ChatGPT through Secure MCP Tunnel

## 1. Prepare Codex

Confirm that Codex is installed and authenticated:

```bash
codex --version
codex mcp-server --help
```

## 2. Create the tunnel

Create an MCP tunnel in OpenAI Platform and associate it with the ChatGPT workspace that will use it. The operator needs the applicable Tunnel Read and Use permissions, and ChatGPT Developer mode must be available for the workspace.

Keep the runtime API key and `tunnel_id` outside Git.

## 3. Start the bridge

Use a single narrow repository root:

```bash
export CONTROL_PLANE_API_KEY="<runtime-key>"
export CONTROL_PLANE_TUNNEL_ID="tunnel_..."

npm run bridge:secure -- --root /absolute/path/to/repository
```

The default profile is read-only. Stop it before starting a write profile:

```bash
npm run bridge:secure -- --root /absolute/path/to/repository --write
```

## 4. Add the connection in ChatGPT

1. Open ChatGPT Settings.
2. Enable Developer mode under Security and login.
3. Open Plugins and create a developer-mode connection.
4. Choose Tunnel and select or paste the matching `tunnel_id`.
5. Use `No Auth`; the bridge is loopback-only and the OpenAI tunnel is the transport boundary.
6. Confirm that the five bridge tools are discovered.

## 5. Verify read-only use

Ask ChatGPT to call `bridge_status`. Confirm:

- `defaultSandbox` is `read-only`.
- `allowWorkspaceWrite` is `false`.
- `defaultApprovalPolicy` is `on-request`.
- `allowedRoots` contains only the intended repository.
- Upstream tools include `codex` and `codex-reply`.

Then ask ChatGPT to call `codex_read` with a narrow repository-inspection prompt. If it returns a `jobId`, pass that exact value to `codex_job_status`. Continue a completed thread using its exact `threadId` with `codex_reply`.

## 6. Troubleshooting

- Tunnel missing in ChatGPT: verify workspace association and Tunnel Read + Use permissions.
- Tool discovery fails: keep the bridge process running and rerun `tunnel-client doctor`.
- Repository is refused: remove sensitive files from the exposed copy or use a sanitized staging copy.
- Write request is refused: stop the read-only process and deliberately start a write profile.
- Codex call fails: retry after the bridge reconnects its upstream process; enable `CODEX_MCP_BRIDGE_DEBUG=1` only for local diagnosis.

Official guidance:

- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [Connect and test a ChatGPT plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt)
