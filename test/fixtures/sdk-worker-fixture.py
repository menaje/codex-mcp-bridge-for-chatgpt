"""Test-only public SDK launch override; never packaged with the production worker."""
import dataclasses
import importlib.util
from pathlib import Path
import sys
import json
from pydantic import ValidationError

root = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("bridge_sdk_worker", root / "sdk" / "worker.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
sdk_client = module.CodexClient
node = sys.argv[1]
api_account = "--api-account" in sys.argv[2:]
sys.argv = [str(root / "sdk" / "worker.py")]


def create_client(config=None, approval_handler=None):
    command = (node, str(root / "test" / "fixtures" / "fake-codex-app-server.mjs"), "--sdk-contract") + (("--api-account",) if api_account else ())
    return sdk_client(dataclasses.replace(config, launch_args_override=command), approval_handler=approval_handler)


for method in ("start", "initialize", "request", "notify", "next_notification", "turn_start", "next_turn_notification", "unregister_turn_notifications", "close"):
    setattr(create_client, method, getattr(sdk_client, method))
module.CodexClient = create_client
original_safe_error = module.safe_error
module.safe_error = lambda exc: {"code": -32000, "message": json.dumps(exc.errors(include_input=False))} if isinstance(exc, ValidationError) else original_safe_error(exc)
module.main()
