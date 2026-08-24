#!/usr/bin/env node
process.env.CODEX_TEST_APP_SERVER_MODE = "init-timeout";
await import("./fake-codex-app-server-protocol-core.mjs");
