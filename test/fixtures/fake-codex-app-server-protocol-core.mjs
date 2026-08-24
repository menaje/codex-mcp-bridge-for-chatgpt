import { readFileSync } from "node:fs";
import readline from "node:readline";

const mode = process.env.CODEX_TEST_APP_SERVER_MODE;
const manifest = JSON.parse(readFileSync(new URL("../../release-manifest.json", import.meta.url), "utf8"));

if (process.argv.includes("--version")) {
  process.stdout.write(`codex-cli ${manifest.toolchain.codexCli}\n`);
  process.exit(0);
}

const lines = readline.createInterface({ input: process.stdin });
let initialized = false;
let modelListRequests = 0;

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const respond = (id, result) => send({ id, result });

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.jsonrpc !== undefined) process.exit(71);

  if (message.method === "initialize") {
    if (mode === "init-error") {
      send({
        id: message.id,
        error: {
          code: -32050,
          message: "fixture initialization rejected",
          data: { pid: process.pid }
        }
      });
      return;
    }
    if (mode === "init-timeout") return;
    if (mode === "init-incompatible") {
      respond(message.id, { userAgent: "fixture-with-old-shape" });
      return;
    }
    initialized = true;
    respond(message.id, {
      userAgent: "fake-codex-app-server/1.0",
      platformFamily: "unix",
      platformOs: "test"
    });
    return;
  }

  if (message.method === "initialized") return;
  if (!initialized) {
    send({ id: message.id, error: { code: -32000, message: "Not initialized" } });
    return;
  }
  if (mode === "late-reconciliation") {
    if (message.method === "thread/start") {
      setTimeout(() => respond(message.id, {
        thread: { id: "late-created-thread", secretPayload: "SECRET_LATE_SUCCESS_PAYLOAD" }
      }), 120);
      return;
    }
    if (message.method === "thread/resume") {
      respond(message.id, { thread: { id: message.params.threadId } });
      return;
    }
    if (message.method === "turn/start") {
      setTimeout(() => respond(message.id, {
        turn: { id: "late-created-turn", secretPayload: "SECRET_LATE_SUCCESS_PAYLOAD" }
      }), 120);
      return;
    }
    if (message.method === "thread/archive") {
      setTimeout(() => {
        if (message.params.threadId === "late-archive-error") {
          send({
            id: message.id,
            error: {
              code: -32055,
              message: "SECRET_LATE_ERROR_MESSAGE",
              data: { secret: "SECRET_LATE_ERROR_DATA" }
            }
          });
        } else {
          respond(message.id, { secretPayload: "SECRET_LATE_SUCCESS_PAYLOAD" });
        }
      }, 120);
      return;
    }
    if (message.method === "thread/unarchive") {
      setTimeout(() => respond(message.id, {
        thread: { id: message.params.threadId, secretPayload: "SECRET_LATE_SUCCESS_PAYLOAD" }
      }), 120);
      return;
    }
  }
  if (message.method === "model/list") {
    modelListRequests += 1;
    const result = { data: [], nextCursor: null };
    if (mode === "late-control" && modelListRequests === 1) {
      setTimeout(() => respond(message.id, result), 300);
    } else {
      respond(message.id, result);
    }
    return;
  }
  send({ id: message.id, error: { code: -32601, message: `Unsupported fixture method: ${message.method}` } });
});
