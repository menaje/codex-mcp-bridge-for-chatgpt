import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DASHBOARD_CARD_HTML } from "../src/dashboardCard.js";
import { SETTINGS_CARD_HTML } from "../src/settingsCard.js";
import { documentationSnapshots } from "./fixtures/documentation-snapshots.js";

// Capture actual production UI, with synthetic English content and no inference.
// Output remains outside docs/images until the images have been visually reviewed.
const repository = fileURLToPath(new URL("..", import.meta.url));
const output = path.join(repository, "output/playwright/documentation");
const execute = promisify(execFile);
const snapshots = documentationSnapshots();
await mkdir(output, { recursive: true });
const run = async (command: string, args: string[], env = process.env) => {
  const result = await execute(command, args, { cwd: repository, env, timeout: 240_000, maxBuffer: 8 * 1024 * 1024 });
  return result.stdout;
};

async function native() {
  if (process.platform !== "darwin") throw new Error("Native captures require macOS and an unlocked graphical session.");
  const root = await mkdtemp("/tmp/bridge-docs-");
  const source = path.join(root, "macos");
  await cp(path.join(repository, "macos/Sources"), path.join(source, "Sources"), { recursive: true });
  await cp(path.join(repository, "macos/Package.swift"), path.join(source, "Package.swift"));
  await mkdir(path.join(source, "Tests/CodexBridgeKitTests"), { recursive: true });
  await writeFile(path.join(source, "Tests/CodexBridgeKitTests/Placeholder.swift"), "import XCTest\n");
  const main = path.join(source, "Sources/CodexBridgeMenuBar/CodexBridgeMenuBarApp.swift");
  const text = await readFile(main, "utf8");
  const entry = "@main\nstruct CodexBridgeMenuBarApp";
  if (text.split(entry).length !== 2) throw new Error("Review the changed production entry point.");
  await writeFile(main, text.replace(entry, "struct CodexBridgeMenuBarApp"));
  for (const [from, name] of [
    ["scripts/fixtures/NativeDocumentationScreenshots.swift", "NativeDocumentationScreenshots.swift"],
    ["macos/Tests/CodexBridgeKitTests/NativeRPCFixture.swift", "NativeRPCFixture.swift"]
  ]) await cp(path.join(repository, from), path.join(source, "Sources/CodexBridgeMenuBar", name));
  await writeFile(path.join(root, "snapshots.json"), JSON.stringify(snapshots));
  await run("swift", ["build", "--package-path", source, "--product", "CodexBridgeMenuBar", "-Xswiftc", "-strict-concurrency=complete", "-Xswiftc", "-warnings-as-errors"]);
  const bin = (await run("swift", ["build", "--package-path", source, "--show-bin-path"])).trim();
  const app = path.join(root, "Documentation Capture.app");
  await mkdir(path.join(app, "Contents/MacOS"), { recursive: true });
  await mkdir(path.join(app, "Contents/Resources"), { recursive: true });
  const executable = path.join(app, "Contents/MacOS/DocumentationCapture");
  await cp(path.join(bin, "CodexBridgeMenuBar"), executable);
  await writeFile(path.join(app, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.menaje.bridge-documentation-capture</string>
<key>CFBundleName</key><string>Documentation Capture</string>
<key>CFBundleExecutable</key><string>DocumentationCapture</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>LSMinimumSystemVersion</key><string>13.0</string>
</dict></plist>`);
  await run("xcrun", ["xcstringstool", "compile", path.join(repository, "macos/Resources/Localization/Localizable.xcstrings"), "--output-directory", path.join(app, "Contents/Resources"), "--serialization-format", "text"]);
  await run("codesign", ["--force", "--sign", "-", app]);
  console.log(`Native capture app: ${app}`);
  console.log(await run(executable, ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"], {
    ...process.env, BRIDGE_DOCUMENTATION_ROOT: root, BRIDGE_DOCUMENTATION_OUTPUT: output
  }));
}

async function web() {
  const server = createServer((request, response) => {
    const dashboard = request.url === "/dashboard";
    const host = `<script>
window.__documentationErrors=[];
addEventListener('error',e=>__documentationErrors.push(e.message));
addEventListener('unhandledrejection',e=>__documentationErrors.push(String(e.reason)));
const sample=${JSON.stringify(snapshots)};
window.openai={locale:'en-US',theme:'light',notifyIntrinsicHeight:()=>{},callTool:async(name,args)=>{
  if(name!=='codex_ui_read')throw Error('Documentation host is read-only');
  if(args.view==='settings')return{structuredContent:sample.settings};
  if(args.view!=='dashboard')throw Error('Unexpected documentation read');
  const next=structuredClone(sample.dashboard);
  if(args.scope!=='all'){next.scope='conversation';next.filter.mode='conversation'}
  next.historyIncluded=args.includeHistory!==false;
  if(!next.historyIncluded)next.terminalRows=[];
  return{structuredContent:next};
}};
</script>`;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end((dashboard ? DASHBOARD_CARD_HTML : SETTINGS_CARD_HTML).replace("</head>", () => host + "</head>"));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const session = `documentation-${process.pid}`;
  const cli = async (...args: string[]) => {
    const result = await run("npx", ["--yes", "--package", "@playwright/cli@0.1.19", "playwright-cli", "--session", session, "--raw", ...args]);
    if (result.includes("### Error")) throw new Error(result);
    return result;
  };
  try {
    await cli("open", origin);
    await cli("resize", "645", "1100");
    await writeFile(path.join(output, "settings.snapshot.txt"), await cli("snapshot"));
    console.log(await cli("run-code", `async page=>{
      await page.locator('#settings-form').waitFor({state:'visible'});
      const speed=page.locator('#use-priority-service-tier');
      if(JSON.stringify(await speed.locator('option:not([disabled])').allTextContents())!==JSON.stringify(['Standard','Fast']))throw Error('Unexpected speed choices');
      await page.locator('main').screenshot({path:${JSON.stringify(path.join(output, "chatgpt-settings-light-en.png"))}});
      if(await page.locator('#ui-language').inputValue()!=='en')throw Error('Card language is not English');
      if((await page.evaluate(()=>window.__documentationErrors)).length)throw Error(JSON.stringify(await page.evaluate(()=>window.__documentationErrors)));
    }`));
    await cli("goto", origin + "/dashboard");
    await writeFile(path.join(output, "dashboard.snapshot.txt"), await cli("snapshot"));
    for (const [panel, filename] of [
      ["running", "chatgpt-dashboard-light-en.png"],
      ["history", "chatgpt-execution-history-light-en.png"],
      ["problems", "chatgpt-problem-history-light-en.png"]
    ]) {
      console.log(await cli("run-code", `async page=>{
        await page.locator('#dashboard-content').waitFor({state:'visible'});
        await page.waitForFunction(()=>document.querySelector('main').getAttribute('aria-busy')==='false');
        await page.locator('[data-status-filter="${panel}"]').click();
        await page.waitForFunction(()=>document.querySelector('main').getAttribute('aria-busy')==='false');
        const text=await page.locator('main').innerText();
        if(text.match(/[가-힣一-龯ぁ-ゔァ-ヴ]/))throw Error('Non-English card content');
        if(text.match(/documentation-job-|Execution details|Load exact/))throw Error('Obsolete history controls');
        await page.locator('main').screenshot({path:${JSON.stringify(path.join(output, filename))}});
        if((await page.evaluate(()=>window.__documentationErrors)).length)throw Error(JSON.stringify(await page.evaluate(()=>window.__documentationErrors)));
      }`));
    }
  } finally {
    await cli("close").catch(() => {});
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

if (!process.argv.includes("--web-only")) await native();
if (!process.argv.includes("--native-only")) await web();
const files = (await readdir(output)).filter(file => file.endsWith("-light-en.png")).sort();
const manifest = {
  capturedAt: new Date().toISOString(), productSourceCommit: (await run("git", ["rev-parse", "HEAD"])).trim(),
  locale: "en", appearance: "light", data: "synthetic documentation fixtures",
  native: "Unmodified production SwiftUI/AppKit views in an isolated application; macOS window screencapture with OCR checks.",
  web: "Production Settings and Dashboard HTML in Chromium at 645 CSS pixels; local window.openai host fixture, not ChatGPT-host acceptance.",
  files: await Promise.all(files.map(async file => ({ file, sha256: createHash("sha256").update(await readFile(path.join(output, file))).digest("hex") })))
};
await writeFile(path.join(output, "capture-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Review ${files.length} English screenshots in ${output} before copying them into docs/images.`);
