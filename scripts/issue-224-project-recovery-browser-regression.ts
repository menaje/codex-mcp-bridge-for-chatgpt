import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "../src/config.js";
import { BackendAwareModelCatalog } from "../src/modelCatalog.js";
import { createBridgeMcpServer } from "../src/server.js";
import { SETTINGS_CARD_HTML } from "../src/settingsCard.js";
import { BridgeStateStore } from "../src/stateStore.js";
import { UI_TRANSLATIONS } from "../src/uiI18n.js";
import { UserSettingsStore } from "../src/userSettings.js";
import { SessionRegistry } from "../src/sessionRegistry.js";
import { cardPrelude } from "./card-browser-fixtures.js";
import { connectCurrentMcpServer } from "./current-mcp-test-harness.js";

// Only this temporary database and simulated upstream catalog are used. The
// browser exercises the shipped Settings card against the real MCP mutations.
const output = path.resolve("output/playwright/issue-224");
mkdirSync(output, { recursive: true });
const root = mkdtempSync(path.join(tmpdir(), "issue-224-browser-"));
const file = path.join(root, "state.sqlite");
const state = new BridgeStateStore({ file });
const config = loadConfig({
  CODEX_MCP_BRIDGE_NO_AUTH: "1",
  CODEX_MCP_BRIDGE_ROOTS: root,
  CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: file,
  CODEX_MCP_BRIDGE_TELEMETRY_DATABASE_FILE: path.join(root, "telemetry.sqlite"),
  CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE: path.join(root, "models.json"),
  CODEX_MCP_BRIDGE_SKILLS_DIRECTORY: path.join(root, "skills")
});
const settings = new UserSettingsStore(config, { stateStore: state });
settings.update({ uiLocalePreference: "ko" }, 0);
settings.updateWithProjectOperations({}, [{ kind: "add", project: { name: "Recovery original", cwd: root } }], undefined, 0);
const project = settings.current.projects[0]!;
const activity = state.createActivity({ scopeId: "11111111-1111-4111-8111-111111111111",
  projectId: project.id, projectName: project.name, projectCwd: project.cwd });
let releaseAllowed = false;
const sessions = new SessionRegistry({ stateStore: state, allowedRoots: [root] });
sessions.record({ threadId: "fixture-idle-thread", scopeId: activity.scopeId, projectId: project.id,
  projectName: project.name, cwd: root, backendKind: "app-server", sandbox: "read-only",
  persistence: "ephemeral", createdAt: 1, updatedAt: 1, lastUsedAt: 1 });
const catalog = new BackendAwareModelCatalog("app-server", {
  async getCatalog() { throw new Error("No CLI fallback in this fixture"); }
}, async () => ({ data: [{ id: "gpt-6-astra", model: "gpt-6-astra", displayName: "GPT-6 Astra",
  description: "Fixture model", hidden: false, isDefault: true, defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Fixture effort" }], serviceTiers: [] }] }));
const bridge = createBridgeMcpServer(config, {
  async listTools() { return { tools: [] }; },
  async callTool() { throw new Error("Model execution is outside this regression"); },
  async releaseThreadConnection() { return releaseAllowed
    ? { phase: "released" as const, evidence: "thread-unloaded" as const }
    : { phase: "release-failed" as const, reason: "fixture termination confirmation unavailable" }; },
  async close() {}
}, undefined, undefined, catalog, settings);
const connection = await connectCurrentMcpServer(bridge, { name: "issue-224-browser", version: "1" });
const server = createServer(async (request, response) => {
  try {
    if (request.method === "POST" && request.url === "/allow-release") {
      releaseAllowed = true; response.writeHead(200); response.end("ok"); return;
    }
    if (request.method === "POST" && request.url === "/tool") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const result = await connection.client.callTool({ name: body.name, arguments: body.args });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
      return;
    }
    const prelude = cardPrelude("settings") + `<script>
      window.__recoveryCalls=[];
      window.openai.callTool=async(name,args)=>{
        window.__recoveryCalls.push({name,args:structuredClone(args)});
        return await (await fetch('/tool',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name,args})})).json();
      };
    </script>`;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(SETTINGS_CARD_HTML.replace("</head>", () => prelude + "</head>"));
  } catch (error) {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: String(error) }));
  }
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address === "object");
const session = `issue-224-${process.pid}`;
const exec = promisify(execFile);
async function cli(...args: string[]) {
  const result = await exec("npx", ["--yes", "--package", "@playwright/cli@0.1.19", "playwright-cli",
    "--session", session, "--raw", ...args], { encoding: "utf8", timeout: 55_000, maxBuffer: 1024 * 1024 });
  if (/Error:|TimeoutError:/.test(result.stdout)) throw new Error(result.stdout);
  return result.stdout;
}
try {
  await cli("open", `http://127.0.0.1:${address.port}`);
  writeFileSync(path.join(output, "initial.snapshot.txt"), await cli("snapshot"));
  const result = await cli("run-code", `async page => {
    const check=(value,message)=>{if(!value)throw new Error(message)};
    const tool=async(name,args={})=>page.evaluate(async({name,args})=>window.openai.callTool(name,args),{name,args});
    const waitSaved=()=>page.waitForFunction(()=>!document.querySelector('#save').disabled);
    const save=async()=>{await page.locator('#save').click();await waitSaved();};
    const row=page.locator('#project-list .project-row').first();
    const read=async()=>(await tool('codex_ui_read',{view:'settings'})).structuredContent;
    const waitState=async(state)=>{for(let i=0;i<150;i++){if((await read()).settings.projects[0]?.archiveState===state)return;await page.waitForTimeout(100);}throw new Error('archive state '+state)};
    await waitSaved();
    await page.locator('#concurrency').fill('7');
    await page.locator('#ui-language').selectOption('en');
    check(await page.locator('#concurrency').inputValue()==='7','Locale change preserves ordinary draft');
    await page.locator('#ui-language').selectOption('ko');
    await row.locator('.project-remove').click();await save();
    await waitState('unresolved');await page.reload();await waitSaved();
    check((await row.locator('.project-availability').textContent()).includes(${JSON.stringify(UI_TRANSLATIONS.ko["settings.projectArchiveUnresolved"])}),'Show unresolved archive');
    check((await row.locator('.project-availability').textContent()).includes('fixture termination confirmation unavailable'),'Show concrete unresolved reason');
    check(await row.locator('.project-delete').isHidden(),'No delete before confirmation');
    await row.screenshot({path:${JSON.stringify(path.join(output, "unresolved-ko.png"))}});
    await page.evaluate(()=>fetch('/allow-release',{method:'POST'}));
    await row.locator('.project-remove').click();await save();await waitState('complete');
    await page.reload();await waitSaved();
    check((await read()).settings.maxConcurrentJobs===7,'Save preserves unrelated draft');
    const identities=[${JSON.stringify(project.id)}];
    for(let cycle=0;cycle<2;cycle++){
      await row.locator('.project-delete').click();await row.locator('.project-delete-confirm-accept').click();await save();
      check((await read()).settings.projects.length===0,'Delete removes registration');
      await page.locator('#add-project').click();
      const added=page.locator('#project-list .project-row').last();
      await added.locator('.project-label-input').fill('New identity '+cycle);
      await added.locator('.project-cwd-input').fill(${JSON.stringify(root)});await save();
      const current=(await read()).settings.projects[0];
      check(!identities.includes(current.id),'Same cwd receives new identity');identities.push(current.id);
      await row.locator('.project-remove').click();await save();await waitState('complete');
      await page.reload();await waitSaved();
    }
    await row.locator('.project-delete').click();await row.locator('.project-delete-confirm-accept').click();await save();
    check((await read()).settings.projects.length===0,'Repeated final delete succeeds');
    return {archiveUnresolvedVisible:true,retryConfirmed:true,deleteRemovesManagement:true,sameCwdNewIdentity:identities,draftPreserved:true};
  }`);
  assert.equal(state.getActivityProjectAdmission(activity.activityId), undefined);
  assert.equal(settings.current.projects.length, 0);
  writeFileSync(path.join(output, "result.txt"), result);
  console.log(result);
} catch (error) {
  writeFileSync(path.join(output, "failure.snapshot.txt"), await cli("snapshot").catch(String));
  throw error;
} finally {
  await cli("close").catch(() => undefined);
  await new Promise<void>(resolve => server.close(() => resolve()));
  await connection.close();
  await bridge.close();
  try { state.close(); } finally { rmSync(root, { recursive: true }); }
}
