import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import { cardPrelude } from './card-browser-fixtures.js';
const directory = process.argv.includes("--built") ? "dist" : "src";
const [{ DASHBOARD_CARD_HTML }, { ACTIVITY_CARD_HTML, ACTIVITY_CARD_CONTRACT_GENERATION }] = await Promise.all([
  import(`../${directory}/dashboardCard.js`), import(`../${directory}/activityCard.js`)
]);

const artifactDir = path.resolve('output/playwright/card-information', directory);
mkdirSync(artifactDir, { recursive: true });
const scenarios = ['dashboard-stale-usage', 'dashboard-failed-enrichment', 'dashboard-unknown-runtime', 'activity-stale-usage', 'dashboard-unavailable-runtime'];
const fixtures = Object.fromEntries(scenarios.map(name => {
  const activity = name.startsWith('activity');
  const kind = activity ? 'activity' : 'dashboard';
  const html = activity ? ACTIVITY_CARD_HTML : DASHBOARD_CARD_HTML;
  return [name, html.replace('</head>', () => `${cardPrelude(kind)}<script>
    const originalCall=window.openai.callTool;
    window.openai.callTool=async(name,args)=>{
      if(args.afterVersion!==undefined)return new Promise(()=>{});
      const result=await originalCall(name,args);
      const view=result.structuredContent;
      view.generatedAt=new Date().toISOString();
      view.enrichment.state=args.enrich?'enriched':'structural';
      view.enrichment.usageTimedOut=Boolean(args.enrich)&&!window.__recover&&${name !== "dashboard-unavailable-runtime"};
      view.enrichment.runtimeUnavailable=${name === "dashboard-unavailable-runtime" ? 1 : 0};
      view.weeklyUsage={source:'codex-account-rate-limits',limitId:'codex',usedPercent:35.5,remainingPercent:64.5,
        windowDurationMins:10080,resetsAt:new Date(Date.now()+86400000).toISOString(),observedAt:new Date(Date.now()-(window.__recover?0:14*60000)).toISOString()};
      if(view.counts){view.counts.runtimeUnknownAgents=${name === 'dashboard-unknown-runtime' ? 2 : 0};view.counts.runtimeProbeSkippedAgents=${name === 'dashboard-unknown-runtime' ? 3 : 0}}
      if(view.mountedActivity)view.mountedActivity.cardGeneration=${ACTIVITY_CARD_CONTRACT_GENERATION};
      if(${name === 'dashboard-failed-enrichment'}&&args.enrich&&!window.__recover)throw new Error('Fixture supplemental read failure');
      return result;
    };
  </script></head>`)]
}));
const server = createServer((req, res) => {
  const name = new URL(req.url || '/', 'http://127.0.0.1').pathname.slice(1);
  if (!fixtures[name]) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(fixtures[name]);
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert(address && typeof address === 'object');
const session = 'display-audit-' + process.pid;
const exec = promisify(execFile);
async function cli(...args: string[]) {
  const result = await exec('npx', ['--yes', '--package', '@playwright/cli@0.1.19', 'playwright-cli', '--session', session, '--raw', ...args],
    { encoding: 'utf8', timeout: 55000, maxBuffer: 4 * 1024 * 1024 });
  return result.stdout.trim();
}
const report: Record<string, unknown> = {};
try {
  await cli('open', 'about:blank');
  for (const name of scenarios) {
    await cli('goto', `http://127.0.0.1:${address.port}/${name}`);
    const snapshot = await cli('snapshot');
    writeFileSync(path.join(artifactDir, name + '.snapshot.txt'), snapshot);
    await cli('run-code', `async page=>{await page.waitForFunction(()=>window.__cardCalls.some(call=>call.args.enrich===true));await page.locator('#weekly-usage-value').waitFor({state:'visible'});}`);
    const state = JSON.parse(await cli('eval', `()=>({usage:document.querySelector('#weekly-usage-value')?.textContent,message:document.querySelector('#message')?.textContent,observed:document.querySelector('#weekly-usage-observed')?.textContent,updated:document.querySelector('#updated')?.textContent,errors:window.__cardErrors,calls:window.__cardCalls.map(call=>({name:call.name,enrich:call.args.enrich}))})`));
    report[name] = state;
    assert.deepEqual(state.errors, []);
    assert.equal(state.usage, '64.5%');
    assert(state.observed?.includes('사용량 확인:'), name + ': missing actual observation time');
    assert(state.message?.includes('마지막 확인값'), name + ': missing incomplete-details notice');
    if (name === 'dashboard-unknown-runtime') assert(state.message.includes('2') && state.message.includes('3'));
    await cli('screenshot', '--filename', path.join(artifactDir, name + '.png'));
    if (name === 'dashboard-failed-enrichment') {
      await cli('run-code', "async page=>{await page.evaluate(()=>window.__recover=true);await page.locator('#refresh').click();await page.waitForFunction(()=>window.__cardCalls.length>=4&&!document.querySelector('#message').textContent);}");
      report['dashboard-enrichment-recovery'] = JSON.parse(await cli('eval', "()=>({message:document.querySelector('#message').textContent,observed:document.querySelector('#weekly-usage-observed').textContent})"));
    }
    console.log('Passed ' + name);
  }
} finally {
  await cli('close').catch(() => {});
  server.close();
  writeFileSync(path.join(artifactDir, 'report.json'), JSON.stringify(report, null, 2));
}
