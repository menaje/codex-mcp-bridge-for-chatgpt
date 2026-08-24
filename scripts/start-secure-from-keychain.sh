#!/bin/zsh
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

SCRIPT_DIR="${0:A:h}"
REPO_ROOT="${CODEX_MCP_BRIDGE_REPO_ROOT:-${SCRIPT_DIR:h}}"
BRIDGE_ROOT="${CODEX_MCP_BRIDGE_ROOT:-$REPO_ROOT}"
ACCOUNT="${USER:-$(id -un)}"

if [[ -z "${CONTROL_PLANE_API_KEY:-}" ]]; then
  export CONTROL_PLANE_API_KEY="$(security find-generic-password -a "$ACCOUNT" -s "codex-mcp-bridge:control-plane-api-key" -w)"
fi

if [[ -z "${CONTROL_PLANE_TUNNEL_ID:-}" ]]; then
  export CONTROL_PLANE_TUNNEL_ID="$(security find-generic-password -a "$ACCOUNT" -s "codex-mcp-bridge:control-plane-tunnel-id" -w)"
fi

NPM_BIN="${NPM_BIN:-$(command -v npm || true)}"
if [[ -z "$NPM_BIN" ]]; then
  echo "npm was not found in PATH." >&2
  exit 1
fi

cd "$REPO_ROOT"
LAUNCHER_ROOT_ARGS=(--root "$BRIDGE_ROOT")
for LAUNCHER_ARG in "$@"; do
  if [[ "$LAUNCHER_ARG" == "--root" ]]; then
    # Explicit repeatable roots replace the compatibility default instead of
    # silently adding the repository root to the operator's allowlist.
    LAUNCHER_ROOT_ARGS=()
    break
  fi
done
exec "$NPM_BIN" run bridge:secure -- "${LAUNCHER_ROOT_ARGS[@]}" --no-build "$@"
