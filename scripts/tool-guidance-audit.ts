import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as z from "zod/v4";

async function inventory(directory: string) {
  const source = (file: string) => import(pathToFileURL(path.join(directory, "src", file + ".ts")).href);
  const [{ loadConfig }, { createBridgeMcpServer }, { BridgeStateStore }, { SessionRegistry },
    { UserSettingsStore }, { CodexJobRegistry, MODEL_VISIBLE_OUTPUT_SCHEMAS }] = await Promise.all([
    source("config"), source("server"), source("stateStore"), source("sessionRegistry"), source("userSettings"), source("tools")
  ]);
  const config = loadConfig({ CODEX_MCP_BRIDGE_NO_AUTH: "1" });
  const stateStore = new BridgeStateStore({ file: ":memory:" });
  const forbidden = async () => { throw new Error("Descriptor audit must not execute Codex or query an upstream catalog."); };
  const server = createBridgeMcpServer(config,
    { listTools: async () => ({ tools: [] }), callTool: forbidden, close: async () => {} },
    new SessionRegistry({ stateStore }), new CodexJobRegistry({ stateStore }),
    { getCatalog: forbidden }, new UserSettingsStore(config, { stateStore }));
  const client = new Client({ name: "tool-guidance-audit", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(a), server.connect(b)]);
    const { tools } = await client.listTools();
    const current = tools.filter(tool => tool._meta?.["codex/registrationTier"] !== "compatibility");
    const task = current.find(tool => tool.name === "codex_task")!;
    const sourceFiles = new Set(execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "src"],
      { cwd: directory, encoding: "utf8" }).split("\0").filter(Boolean));
    const hash = createHash("sha256");
    for (const file of [...sourceFiles].sort()) hash.update(file).update("\0").update(await readFile(path.join(directory, file)));
    return {
      commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).trim(),
      sourceSha256: hash.digest("hex"),
      currentModel: current.filter(tool => !(tool._meta?.ui as any)?.visibility?.every((value: string) => value === "app")).length,
      currentApp: current.filter(tool => (tool._meta?.ui as any)?.visibility?.every((value: string) => value === "app")).length,
      compatibilityDescriptors: tools.length - current.length,
      currentDescriptorBytes: Buffer.byteLength(JSON.stringify(current)),
      currentRootDescriptionBytes: current.reduce((sum, tool) => sum + Buffer.byteLength(tool.description || ""), 0),
      modelOutputSchemaBytes: Object.values(MODEL_VISIBLE_OUTPUT_SCHEMAS).reduce((sum: number, schema) =>
        sum + Buffer.byteLength(JSON.stringify(z.toJSONSchema(schema as z.ZodType))), 0),
      taskInputOutputBytes: Buffer.byteLength(JSON.stringify(task.inputSchema)) + Buffer.byteLength(JSON.stringify(task.outputSchema)),
      currentTools: current.map(tool => ({ name: tool.name, description: tool.description })).sort((a, b) => a.name.localeCompare(b.name))
    };
  } finally { await client.close(); await server.close(); stateStore.close(); }
}

const baselineDirectory = process.argv[2];
const current = await inventory(process.cwd());
const baseline = baselineDirectory ? await inventory(path.resolve(baselineDirectory)) : undefined;
const report = {
  issue: 70, date: "2026-09-08", upstreamExecution: false, liveRuntimeModified: false,
  baseline, current,
  ...(baseline ? { rootDescriptionReductionPercent: Math.round(1000 *
    (1 - current.currentRootDescriptionBytes / baseline.currentRootDescriptionBytes)) / 10,
    toolNamesUnchanged: JSON.stringify(current.currentTools.map(tool => tool.name)) === JSON.stringify(baseline.currentTools.map(tool => tool.name)) } : {})
};
const output = path.resolve("docs/audits/issue-70-tool-guidance.json");
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
process.stdout.write(JSON.stringify({ output, ...report, baseline: baseline && { ...baseline, currentTools: undefined },
  current: { ...current, currentTools: undefined } }) + "\n");
