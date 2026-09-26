// Loaded only by isolated tests through NODE_OPTIONS, never by production.
import childProcess from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const spawn = childProcess.spawn;
childProcess.spawn = function(command, args, options) {
  const gate = process.env.CODEX_TEST_PS_FAULT;
  if (command === "/bin/ps" && gate && existsSync(gate)) {
    const mode = readFileSync(gate, "utf8").trim();
    if (mode === "slow") return spawn.call(this, "/bin/sleep", ["60"], options);
    if (mode === "output-limit") return spawn.call(this, process.execPath,
      ["-e", "process.stdout.write('x'.repeat(5*1024*1024))"], options);
    return spawn.call(this, "/usr/bin/false", [], options);
  }
  return spawn.call(this, command, args, options);
};
syncBuiltinESMExports();
const setIntervalOriginal = globalThis.setInterval;
globalThis.setInterval = (callback, ms, ...args) => setIntervalOriginal(() => {
  if (ms === 250 && process.argv.includes("--codex-execution-child") &&
      process.env.CODEX_TEST_NO_HEARTBEAT === "1") return;
  callback(...args);
}, ms);
