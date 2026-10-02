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
import { tombstoneProjectForTest } from "../test/helpers/sqliteSettings.js";
import { cardPrelude } from "./card-browser-fixtures.js";
import { connectCurrentMcpServer } from "./current-mcp-test-harness.js";

// Only this temporary database and simulated upstream catalog are used. The
// browser exercises the shipped Settings card against the real MCP mutations.
const output = path.resolve("output/playwright/issue-224");
mkdirSync(output, { recursive: true });
const root = mkdtempSync(path.join(tmpdir(), "issue-224-browser-"));
const file = path.join(root, "state.sqlite");
const state = new BridgeStateStore({ file });
const config = loadConfig({ CODEX_MCP_BRIDGE_NO_AUTH: "1", CODEX_MCP_BRIDGE_ROOTS: root });
const settings = new UserSettingsStore(config, { stateStore: state });
settings.update({ uiLocalePreference: "ko" }, 0);
settings.updateWithProjectOperations({}, [{ kind: "add", project: { name: "Recovery original", cwd: root } }], undefined, 0);
const project = settings.current.projects[0]!;
const activity = state.createActivity({ scopeId: "11111111-1111-4111-8111-111111111111",
  projectId: project.id, projectName: project.name, projectCwd: project.cwd });
tombstoneProjectForTest(file, project.id);
const catalog = new BackendAwareModelCatalog("app-server", {
  async getCatalog() { throw new Error("No CLI fallback in this fixture"); }
}, async () => ({ data: [{ id: "gpt-6-astra", model: "gpt-6-astra", displayName: "GPT-6 Astra",
  description: "Fixture model", hidden: false, isDefault: true, defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Fixture effort" }], serviceTiers: [] }] }));
const bridge = createBridgeMcpServer(config, {
  async listTools() { return { tools: [] }; },
  async callTool() { throw new Error("Model execution is outside this regression"); },
  async close() {}
}, undefined, undefined, catalog, settings);
const connection = await connectCurrentMcpServer(bridge, { name: "issue-224-browser", version: "1" });
const server = createServer(async (request, response) => {
  try {
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
    await page.locator('#project-recovery button').waitFor();
    check(await page.locator('#project-list .project-row').count()===0,'Deleted registration stays outside admission/form');
    await page.locator('#concurrency').fill('7');
    await page.locator('#project-recovery button').click();
    check(await row.getAttribute('data-project-id')===${JSON.stringify(project.id)},'Stage original UUID');
    check(await row.getAttribute('data-restore')==='true','Stage explicit restore');
    await page.locator('#ui-language').selectOption('en');
    check(await page.locator('#concurrency').inputValue()==='7','Locale change preserves ordinary draft');
    await page.locator('#ui-language').selectOption('ko');
    await save();
    let current=(await tool('codex_ui_read',{view:'settings'})).structuredContent;
    check(current.settings.projects[0].id===${JSON.stringify(project.id)},'Restore original UUID');
    check(current.settings.projects[0].projectRef===${JSON.stringify(project.projectRef)},'Restore original ref');
    check(current.settings.maxConcurrentJobs===7,'Save preserves unrelated draft');
    check(current.capabilities.recoverableProjects.length===0,'Recovered tombstone leaves recovery list');
    const mutation=await page.evaluate(()=>window.__recoveryCalls.find(x=>x.name==='codex_update_settings'));
    check(mutation.args.operation.settings.projectOperations[0].kind==='restore','Never implicitly add a new identity');
    await row.locator('.project-remove').click();await save();
    const revision=(await tool('codex_ui_read',{view:'settings'})).structuredContent.settings.registryRevision;
    await row.locator('.project-delete').click();
    await row.locator('.project-delete-confirm-accept').click();await save();
    check(await page.locator('#project-error').textContent()===${JSON.stringify(UI_TRANSLATIONS.ko["settings.projectDeleteStillPinned"])},'Explain why retained work prevents deletion');
    check((await tool('codex_ui_read',{view:'settings'})).structuredContent.settings.registryRevision===revision,'Rejected delete preserves CAS');
    await row.locator('.project-delete').click();
    await page.locator('#add-project').click();
    let added=page.locator('#project-list .project-row').last();
    await added.locator('.project-label-input').fill('New identity');
    await added.locator('.project-cwd-input').fill(${JSON.stringify(root)});await save();
    check(await page.locator('#project-error').textContent()===${JSON.stringify(UI_TRANSLATIONS.ko["settings.projectCwdStillPinned"])},'Pinned cwd points to recovery');
    await page.locator('#project-error').screenshot({path:${JSON.stringify(path.join(output, "pinned-cwd-ko.png"))}});
    await page.reload();await waitSaved();
    await row.locator('.project-remove').click();await save();
    await page.locator('#add-project').click();
    added=page.locator('#project-list .project-row').last();
    await added.locator('.project-label-input').fill('Duplicate active folder');
    await added.locator('.project-cwd-input').fill(${JSON.stringify(root)});await save();
    check(await page.locator('#project-error').textContent()===${JSON.stringify(UI_TRANSLATIONS.ko["settings.projectDuplicatePath"])},'Active conflict has a separate explanation');
    return {restorePreservedIdentity:true,deleteProtected:true,cwdMessagesDistinct:true,draftPreserved:true};
  }`);
  assert.equal(state.getActivityProjectAdmission(activity.activityId)?.projectId, project.id);
  assert.equal(settings.current.projects[0]?.id, project.id);
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
