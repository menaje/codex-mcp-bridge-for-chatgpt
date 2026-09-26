// Loaded only by isolated tests through NODE_OPTIONS, never by production.
import childProcess from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const spawn = childProcess.spawn;
const role = process.argv.includes("--codex-execution-child") ? "execution" : "control";
let probeSequence = 0;
function record(value) {
  const file = process.env.CODEX_TEST_PS_TRACE;
  if (file) appendFileSync(file, JSON.stringify({ at: Date.now(), pid: process.pid, role, ...value }) + "\n");
}
childProcess.spawn = function(command, args, options) {
  if (command !== "/bin/ps" || !args?.includes("-axo")) return spawn.call(this, command, args, options);
  const gate = process.env.CODEX_TEST_PS_FAULT;
  let fault;
  if (gate && existsSync(gate)) {
    const text = readFileSync(gate, "utf8").trim();
    fault = text.startsWith("{") ? JSON.parse(text) : { mode: text };
  }
  const mode = fault && (!fault.role || fault.role === role) ? fault.mode : undefined;
  const probe = ++probeSequence;
  record({ event: "probe-start", probe, mode: mode || "healthy" });
  let child;
  if (mode === "slow") child = spawn.call(this, "/bin/sleep", ["60"], options);
  else if (mode === "spawn") child = spawn.call(this, "/nonexistent/issue-186-ps", [], options);
  else if (mode === "output-limit") child = spawn.call(this, process.execPath,
    ["-e", "process.stdout.write('x'.repeat(5*1024*1024))"], options);
  else if (mode === "output-invalid") child = spawn.call(this, process.execPath,
    ["-e", "process.stdout.write('not a process table\\n')"], options);
  else if (mode === "output-utf8") child = spawn.call(this, process.execPath,
    ["-e", "process.stdout.write(Buffer.from([0xc3,0x28]))"], options);
  else if (mode) child = spawn.call(this, "/usr/bin/false", [], options);
  else child = spawn.call(this, command, args, options);
  child.once("close", (code, signal) => record({ event: "probe-close", probe, code, signal }));
  return child;
};
syncBuiltinESMExports();
const setIntervalOriginal = globalThis.setInterval;
globalThis.setInterval = (callback, ms, ...args) => setIntervalOriginal(() => {
  if (ms === 250 && process.argv.includes("--codex-execution-child") &&
      process.env.CODEX_TEST_NO_HEARTBEAT === "1") return;
  callback(...args);
}, ms);

// Optional isolated-test metrics, independent of ps and of Bridge diagnostics.
if (process.env.CODEX_TEST_PS_TRACE && role === "execution") {
  const sample = () => record({ event: "resources", cpu: process.cpuUsage(), memory: process.memoryUsage() });
  sample();
  setIntervalOriginal(sample, 1000).unref();
}
