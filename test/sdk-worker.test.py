"""Exact SDK auth/redaction contract. Mocked credentials only; no model calls."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("bridge_sdk_worker", root / "sdk" / "worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

class WorkerPolicyTests(unittest.TestCase):
    def test_chatgpt_strips_all_ambient_api_credentials_without_changing_shared_home(self):
        values = {"HOME": "/safe/home", "CODEX_HOME": "/safe/codex", "OPENAI_API_KEY": "PRIVATE", "CODEX_API_KEY": "PRIVATE", "OPENAI_BASE_URL": "https://untrusted.example", "PYTHONPATH": "/untrusted"}
        with patch.dict(os.environ, values, clear=True):
            worker.configure_environment("chatgpt", None)
            self.assertEqual(os.environ["CODEX_HOME"], "/safe/codex")
            for key in ("OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "PYTHONPATH"):
                self.assertNotIn(key, os.environ)

    def test_api_mode_requires_a_separate_explicit_profile(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "SDK_API_PROFILE_REQUIRED"):
                worker.configure_environment("api-key", None)
            with self.assertRaisesRegex(RuntimeError, "SDK_SHARED_AUTH_MUTATION_FORBIDDEN"):
                worker.configure_environment("api-key", str(Path.home() / ".codex"))
            with tempfile.TemporaryDirectory() as profile:
                worker.configure_environment("api-key", profile)
                self.assertEqual(os.environ["CODEX_HOME"], profile)
                self.assertIn('cli_auth_credentials_store="file"', worker.client_config("api-key").config_overrides)

    def test_chatgpt_inspection_never_forces_a_login_method_or_overwrites_shared_auth(self):
        self.assertFalse(any("forced_login_method" in arg for arg in worker.client_config("chatgpt").config_overrides))
        with patch.dict(os.environ, {}, clear=True):
            with tempfile.TemporaryDirectory() as profile:
                worker.configure_environment("chatgpt", profile)
                self.assertEqual(os.environ["CODEX_HOME"], profile)

    def test_errors_cannot_expose_keys_tokens_claims_or_account_payloads(self):
        secret = "sk-secret token refresh_token chatgpt_account_id plan_type private@example.com"
        for exc in (RuntimeError(secret), ValueError(secret), RuntimeError("SDK_AUTH_REQUIRED " + secret)):
            value = json.dumps(worker.safe_error(exc))
            for fragment in secret.split():
                self.assertNotIn(fragment, value)

    def test_allowlist_has_no_auth_mutations_or_unsupported_terminal_controls(self):
        self.assertNotIn("account/login/start", worker.METHODS)
        self.assertNotIn("account/logout", worker.METHODS)
        self.assertNotIn("thread/backgroundTerminals/terminate", worker.METHODS)
        self.assertIn("turn/interrupt", worker.METHODS)
        self.assertIn("thread/fork", worker.METHODS)

if __name__ == "__main__":
    unittest.main()
