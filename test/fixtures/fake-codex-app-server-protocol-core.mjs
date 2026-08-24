import readline from "node:readline";

const mode = process.env.CODEX_TEST_APP_SERVER_MODE;
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
