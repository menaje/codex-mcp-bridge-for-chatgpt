"""Supervised, long-lived Codex SDK transport. No private SDK methods or direct fallback.

The TypeScript bridge owns policy, jobs and deadlines. This process exclusively
uses the exact SDK's public CodexClient.request/notify/next_notification APIs.
"""
from __future__ import annotations

import argparse
import importlib.metadata
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import tempfile
import uuid

from codex_cli_bin import bundled_codex_path
from openai_codex import CodexConfig
from openai_codex.client import CodexClient
from openai_codex.generated import v2_all as v2
from openai_codex.models import InitializeResponse, UnknownNotification

lock_path = Path(sys.argv[sys.argv.index("--bundle-lock") + 1]) if "--bundle-lock" in sys.argv else Path(__file__).with_name("runtime-lock.json")
LOCK = json.loads(lock_path.read_text())
METHODS = {
    "initialize": InitializeResponse,
    "thread/start": v2.ThreadStartResponse,
    "thread/resume": v2.ThreadResumeResponse,
    "thread/fork": v2.ThreadForkResponse,
    "thread/list": v2.ThreadListResponse,
    "thread/read": v2.ThreadReadResponse,
    "thread/archive": v2.ThreadArchiveResponse,
    "thread/unarchive": v2.ThreadUnarchiveResponse,
    "turn/start": v2.TurnStartResponse,
    "turn/steer": v2.TurnSteerResponse,
    "turn/interrupt": v2.TurnInterruptResponse,
    "model/list": v2.ModelListResponse,
    "account/rateLimits/read": v2.GetAccountRateLimitsResponse,
    "account/read": v2.GetAccountResponse,
}
INTERACTIONS = {
    "item/commandExecution/requestApproval", "item/fileChange/requestApproval",
    "item/permissions/requestApproval", "item/tool/requestUserInput",
}
MAX_LINE_BYTES = 16 * 1024 * 1024


def check_bundle() -> dict:
    def normalize(value):
        if isinstance(value, dict):
            return {key: normalize(entry) for key, entry in value.items() if key not in ("description", "title", "$schema")}
        if isinstance(value, list):
            return [normalize(entry) for entry in value]
        return value
    contract = json.loads(Path(__file__).with_name("sdk-contract.json").read_text())
    for method, expected in contract["responses"].items():
        value = METHODS[method].model_json_schema(by_alias=True)
        observed = hashlib.sha256(json.dumps(normalize(value), sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        if observed != expected:
            raise RuntimeError("SDK_PROTOCOL_INCOMPATIBLE")
    for method in ("start", "initialize", "request", "notify", "next_notification", "turn_start", "next_turn_notification", "unregister_turn_notifications", "close"):
        if not callable(getattr(CodexClient, method, None)):
            raise RuntimeError("SDK_PROTOCOL_INCOMPATIBLE")
    for package, expected in LOCK["packages"].items():
        if importlib.metadata.version(package) != expected:
            raise RuntimeError("SDK_BUNDLE_VERSION_MISMATCH")
    result = subprocess.run([str(bundled_codex_path()), "--version"], capture_output=True, text=True, timeout=10, check=True)
    observed = re.fullmatch(r"codex-cli (\d+\.\d+\.\d+)\s*", result.stdout)
    if not observed or observed[1] != LOCK["codexRuntime"]:
        raise RuntimeError("SDK_RUNTIME_VERSION_MISMATCH")
    return {"sdk": LOCK["sdk"], "runtime": observed[1], "python": ".".join(map(str, sys.version_info[:3])),
            "workerPid": os.getpid(), "processGroupId": os.getpgrp() if os.name != "nt" else None,
            "channel": LOCK["channel"]}


def configure_environment(mode: str, profile: str | None) -> None:
    # CodexClient merges os.environ. Remove credentials before constructing it.
    for name in ("OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "PYTHONPATH", "PYTHONHOME"):
        os.environ.pop(name, None)
    if mode == "api-key":
        if not profile or not Path(profile).is_absolute():
            raise RuntimeError("SDK_API_PROFILE_REQUIRED")
        shared = Path.home() / ".codex"
        if Path(profile).resolve() == shared.resolve():
            raise RuntimeError("SDK_SHARED_AUTH_MUTATION_FORBIDDEN")
        os.environ["CODEX_HOME"] = profile
    elif profile:
        if not Path(profile).is_absolute():
            raise RuntimeError("SDK_PROFILE_REQUIRED")
        os.environ["CODEX_HOME"] = profile


def account_mode(client: CodexClient) -> str | None:
    result = client.request("account/read", {"refreshToken": False}, response_model=v2.GetAccountResponse)
    account = result.model_dump(by_alias=True, mode="json").get("account")
    source = account.get("type") if isinstance(account, dict) else None
    return "chatgpt" if source == "chatgpt" else "api-key" if source == "apiKey" else None


def client_config(mode: str) -> CodexConfig:
    return CodexConfig(
        client_name="codex_mcp_bridge_python_sdk", client_title="Codex MCP Bridge Python SDK",
        config_overrides=('model_provider="openai"',) + (('forced_login_method="api"', 'cli_auth_credentials_store="file"') if mode == "api-key" else ()),
    )


def safe_error(exc: BaseException) -> dict:
    # Never forward raw RPC data, stderr, validation inputs or auth material.
    message = str(getattr(exc, "message", ""))
    if re.search(r"\bthread\b.*\b(?:not found|missing|archived)\b", message, re.I):
        summary = "Codex thread not found or archived."
    elif "SDK_AUTH_" in str(exc):
        summary = "SDK_AUTH_REQUIRED: The selected authentication source is unavailable. No fallback was attempted."
    else:
        summary = f"Codex SDK request failed ({type(exc).__name__})."
    return {"code": getattr(exc, "code", -32000), "message": summary}


class Worker:
    def __init__(self, mode: str):
        self.mode = mode
        self.closed = threading.Event()
        self.write_lock = threading.Lock()
        self.pending_lock = threading.Lock()
        self.pending: dict[str, tuple[threading.Event, dict]] = {}
        self.admission = threading.BoundedSemaphore(64)
        self.initialized = False
        self.client = CodexClient(config=client_config(mode), approval_handler=self.interaction)

    def send(self, value: dict) -> None:
        with self.write_lock:
            sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
            sys.stdout.flush()

    def interaction(self, method: str, params: dict | None) -> dict:
        if method not in INTERACTIONS:
            return {"decision": "decline"}
        request_id = "sdk-" + str(uuid.uuid4())
        event, response = threading.Event(), {}
        with self.pending_lock:
            self.pending[request_id] = (event, response)
        self.send({"id": request_id, "method": method, "params": params})
        # No implicit approval expiry or turn timeout. The bridge resolves or stops this worker.
        event.wait()
        with self.pending_lock:
            self.pending.pop(request_id, None)
        return response.get("result", {"decision": "decline"})

    def notifications(self) -> None:
        try:
            while not self.closed.is_set():
                notification = self.client.next_notification()
                if notification.method.startswith("account/") and notification.method != "account/rateLimits/updated":
                    continue
                self.forward_notification(notification)
        except BaseException:
            if not self.closed.is_set():
                self.send({"method": "bridge/sdk/exit", "params": {"reason": "sdk-transport-closed"}})
                os._exit(70)

    def forward_notification(self, notification) -> None:
        payload = notification.payload
        params = payload.params if isinstance(payload, UnknownNotification) else payload.model_dump(by_alias=True, mode="json", exclude_none=True)
        self.send({"method": notification.method, "params": params})

    def turn_notifications(self, turn_id: str) -> None:
        try:
            while not self.closed.is_set():
                notification = self.client.next_turn_notification(turn_id)
                self.forward_notification(notification)
                if notification.method == "turn/completed":
                    return
        except BaseException:
            if not self.closed.is_set():
                self.send({"method": "bridge/sdk/exit", "params": {"reason": "sdk-turn-stream-closed"}})
                os._exit(70)
        finally:
            self.client.unregister_turn_notifications(turn_id)

    def request(self, message: dict) -> None:
        request_id = message.get("id")
        method = message.get("method")
        try:
            if method not in METHODS:
                self.send({"id": request_id, "error": {"code": -32601, "message": "This operation is not supported by the pinned Codex SDK."}})
                return
            if method != "initialize" and not self.initialized:
                raise RuntimeError("SDK_AUTH_REQUIRED")
            if method == "initialize" and self.initialized:
                raise RuntimeError("SDK_ALREADY_INITIALIZED")
            if method in ("thread/start", "thread/fork", "thread/resume") and (message.get("params") or {}).get("ephemeral") is True:
                self.send({"id": request_id, "error": {"code": -32601, "message": "SDK_EPHEMERAL_UNSUPPORTED: This SDK version requires persisted threads for reliable completion recovery."}})
                return
            if method in ("turn/start", "turn/steer", "thread/resume", "thread/fork", "model/list"):
                if account_mode(self.client) != self.mode:
                    raise RuntimeError("SDK_AUTH_REQUIRED")
            if method == "turn/start":
                params = dict(message.get("params") or {})
                # SDK notifications with a turn ID never enter next_notification().
                # The public turn_start API registers the turn queue and replays early events.
                result = self.client.turn_start(params.pop("threadId"), params.pop("input"), params)
            else:
                result = self.client.request(method, message.get("params"), response_model=METHODS[method])
            if method == "initialize":
                if account_mode(self.client) != self.mode:
                    raise RuntimeError("SDK_AUTH_REQUIRED")
                self.initialized = True
            self.send({"id": request_id, "result": result.model_dump(by_alias=True, mode="json", exclude_none=True)})
            if method == "turn/start":
                # SDK 0.147.0 can discard a completed turn before its public
                # turn_start returns and registers the queue. Reconcile once
                # using the SDK's public read API; never repeat turn/start.
                completed = None
                try:
                    snapshot = self.client.request("thread/read", {"threadId": message["params"]["threadId"], "includeTurns": True}, response_model=v2.ThreadReadResponse)
                    # Persisted history can label an unfinished turn interrupted
                    # while its live thread is active. Only a terminal live thread
                    # can corroborate a missed completion; otherwise keep streaming.
                    live_status = snapshot.thread.model_dump(by_alias=True, mode="json").get("status", {}).get("type")
                    if live_status in ("idle", "systemError"):
                        completed = next((turn for turn in snapshot.thread.turns if turn.id == result.turn.id and turn.status.value in ("completed", "failed", "interrupted")), None)
                except Exception:
                    pass  # Stream ownership is already registered; do not retry execution.
                if completed is not None:
                    self.send({"method": "turn/completed", "params": {"threadId": message["params"]["threadId"], "turn": completed.model_dump(by_alias=True, mode="json", exclude_none=True)}})
                    self.client.unregister_turn_notifications(result.turn.id)
                else:
                    threading.Thread(target=self.turn_notifications, args=(result.turn.id,), daemon=True).start()
        except BaseException as exc:
            self.send({"id": request_id, "error": safe_error(exc)})
        finally:
            self.admission.release()

    def run(self) -> None:
        self.client.start()
        threading.Thread(target=self.notifications, daemon=True).start()
        try:
            for line in sys.stdin:
                if len(line.encode()) > MAX_LINE_BYTES:
                    raise RuntimeError("SDK_REQUEST_TOO_LARGE")
                message = json.loads(line)
                if not isinstance(message, dict):
                    raise RuntimeError("SDK_REQUEST_INVALID")
                if "method" not in message and "id" in message:
                    with self.pending_lock:
                        pending = self.pending.get(str(message["id"]))
                        if pending:
                            pending[1].update(message)
                            pending[0].set()
                elif "id" in message:
                    if self.admission.acquire(blocking=False):
                        threading.Thread(target=self.request, args=(message,), daemon=True).start()
                    else:
                        self.send({"id": message["id"], "error": {"code": -32001, "message": "SDK worker is busy."}})
                elif message.get("method") == "initialized" and self.initialized:
                    self.client.notify("initialized", None)
        finally:
            self.closed.set()
            with self.pending_lock:
                for event, response in self.pending.values():
                    response["result"] = {"decision": "decline"}
                    event.set()
            self.client.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--health-check", action="store_true")
    parser.add_argument("--runtime-path", action="store_true")
    parser.add_argument("--auth-status", action="store_true")
    parser.add_argument("--account-status", action="store_true")
    parser.add_argument("--login-api-key", action="store_true")
    parser.add_argument("--auth-mode", choices=["chatgpt", "api-key"], default="chatgpt")
    parser.add_argument("--profile")
    parser.add_argument("--bundle-lock")
    args = parser.parse_args()
    info = check_bundle()
    if args.check:
        print(json.dumps(info))
        return
    if args.health_check:
        configure_environment("chatgpt", None)
        # Protocol admission is offline and does not read or mutate shared auth.
        with tempfile.TemporaryDirectory(prefix="codex-sdk-health-") as temporary:
            os.environ["CODEX_HOME"] = temporary
            client = CodexClient(config=client_config("chatgpt"))
            try:
                client.start()
                client.initialize()
                print(json.dumps({**info, "protocol": "initialized"}))
            finally:
                client.close()
        return
    if args.runtime_path:
        print(str(bundled_codex_path()))
        return
    configure_environment(args.auth_mode, args.profile)
    if args.auth_status or args.login_api_key or args.account_status:
        client = CodexClient(config=client_config(args.auth_mode))
        try:
            client.start()
            client.initialize()
            if args.login_api_key:
                if args.auth_mode != "api-key":
                    raise RuntimeError("SDK_API_PROFILE_REQUIRED")
                key = sys.stdin.readline(32769).strip()
                if not key or len(key) > 32768:
                    raise RuntimeError("SDK_API_KEY_REQUIRED")
                client.request("account/login/start", {"type": "apiKey", "apiKey": key}, response_model=v2.LoginAccountResponse)
                del key
            if args.account_status:
                account = client.request("account/read", {"refreshToken": False}, response_model=v2.GetAccountResponse)
                limits = None
                if account_mode(client) == "chatgpt":
                    try:
                        limits = client.request("account/rateLimits/read", None, response_model=v2.GetAccountRateLimitsResponse).model_dump(by_alias=True, mode="json")
                    except Exception:
                        pass
                print(json.dumps({"account": account.model_dump(by_alias=True, mode="json"), "limits": limits}))
                return
            resolved = account_mode(client)
            print(json.dumps({"requestedAuthMode": args.auth_mode, "resolvedAuthMode": resolved,
                              "authenticated": resolved == args.auth_mode}))
        finally:
            client.close()
        return
    Worker(args.auth_mode).run()


if __name__ == "__main__":
    try:
        main()
    except BaseException as error:
        # A local log must never contain SDK traceback inputs or raw credential responses.
        sys.stderr.write(safe_error(error)["message"] + "\n")
        sys.exit(1)
