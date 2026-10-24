import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { inspectClientRequestContract } from "../src/cliProtocol.js";
import { fingerprintGeneratedDirectory } from "./app-server-schema.js";
import { verifyCliConnection } from "../src/runtimeCompatibility.js";

// Only schema generation and the existing isolated initialize check are used.
// This script has no model, account, login, or turn execution path.
const commands = process.argv.slice(2);
assert(commands.length > 0, "Pass explicit CLI executable paths; no installation or selection is changed.");
const report: unknown[] = [];
for (const selected of commands) {
  const command = await realpath(selected);
  const directory = await mkdtemp(path.join(tmpdir(), "bridge-215-contract-"));
  const environment = Object.fromEntries(["PATH", "TMPDIR", "LANG", "LC_ALL", "SystemRoot"].flatMap(key =>
    process.env[key] === undefined ? [] : [[key, process.env[key]]])) as NodeJS.ProcessEnv;
  environment.CODEX_HOME = path.join(directory, "home");
  try {
    await mkdir(environment.CODEX_HOME, { recursive: true });
    const version = execFileSync(command, ["--version"], { encoding: "utf8", env: environment, timeout: 15_000 }).trim();
    const schemas = path.join(directory, "schemas");
    execFileSync(command, ["app-server", "generate-json-schema", "--experimental", "--out", schemas],
      { env: environment, timeout: 15_000, stdio: "ignore" });
    const raw = await readFile(path.join(schemas, "ClientRequest.json"), "utf8");
    const schema = JSON.parse(JSON.stringify(JSON.parse(raw), (key, value) =>
      key === "format" && /^(?:u?int)(?:32|64)?$/.test(value) ? undefined : value));
    const config = JSON.parse(await readFile(path.join(schemas, "v2", "ConfigReadResponse.json"), "utf8"));
    const support = inspectClientRequestContract(schema, config);
    assert.equal(support.compatible, true, JSON.stringify(support.missingCore));
    assert.equal(support.capabilities.supportsPerTurnServiceTier, true);
    const params = schema.oneOf.find((entry: any) => entry.properties?.method?.enum?.includes("turn/start")).properties.params;
    const validate = new AjvJsonSchemaValidator().getValidator({ ...params, definitions: schema.definitions });
    const base = { threadId: "synthetic-contract-thread", input: [{ type: "text", text: "contract only", text_elements: [] }] };
    const samples = [
      {}, { serviceTier: null }, { serviceTier: "fast" }, { serviceTier: "priority" },
      { serviceTierForTurn: null }, { serviceTierForTurn: "default" },
      { serviceTierForTurn: "fast" }, { serviceTierForTurn: "ultrafast" }
    ].map(wire => ({ wire, schemaValid: validate({ ...base, ...wire }).valid }));
    assert(samples.every(sample => sample.schemaValid), JSON.stringify(samples));
    await verifyCliConnection(command, environment);
    report.push({ command, version, executableSha256: createHash("sha256").update(await readFile(command)).digest("hex"),
      jsonSchema: fingerprintGeneratedDirectory(schemas, "json"), requestContract: support, samples,
      initialize: "passed", inference: "not-run", accountEntitlement: "not-queried" });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
const output = path.resolve("output/issue-215-cli-contracts.json");
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify({ checkedAt: new Date().toISOString(), samples: report }, null, 2) + "\n");
console.log(JSON.stringify({ output, samples: report }, null, 2));
