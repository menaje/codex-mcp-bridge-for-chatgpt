import { spawn, execFileSync } from 'node:child_process';
import { openSync, closeSync, writeFileSync, readFileSync, mkdtempSync, existsSync } from 'node:fs';
import path from 'node:path';
const cwd='/Volumes/Data/Dev/codex-mcp-bridge-issue-242-independent-20261008';
const out='/tmp/issue-242-independent-20261008';
const tmpdir=mkdtempSync('/tmp/cb242-independent-tests-');
if(existsSync('/tmp/package.json')) throw new Error('Ancestor package.json contaminates fixture module mode');
const env={...process.env,TMPDIR:tmpdir};
for(const k of Object.keys(env)) if(k==='CODEX_HOME'||k.startsWith('CODEX_MCP_BRIDGE_LIVE_')||k.startsWith('CONTROL_PLANE_')||k==='OPENAI_API_KEY'||k==='CODEX_API_KEY') delete env[k];
const records=[];
async function run(id,command,args,extra={}) {
  const source=execFileSync('git',['show','-s','--format=%H %P %T','HEAD'],{cwd,encoding:'utf8'}).trim();
  const record={id,source,cwd,tmpdir,command:'/usr/sbin/taskpolicy',args:['-a',command,...args],envOverrides:extra,startedAt:new Date().toISOString()};
  records.push(record);
  writeFileSync(path.join(out,'commands.json'),JSON.stringify(records,null,2)+'\n');
  console.log('START '+id);
  const fd=openSync(path.join(out,id+'.log'),'w');
  const start=Date.now();
  const child=spawn(record.command,record.args,{cwd,env:{...env,...extra},stdio:['ignore',fd,fd]});
  Object.assign(record,await new Promise(resolve=>{child.once('error',error=>resolve({error:String(error)}));child.once('exit',(code,signal)=>resolve({code,signal}));}),{durationMs:Date.now()-start,finishedAt:new Date().toISOString()});
  closeSync(fd);
  if(command.endsWith('/vitest')) {
    try { const r=JSON.parse(readFileSync(path.join(out,id+'.json'))); record.counts={passed:r.numPassedTests,failed:r.numFailedTests,skipped:r.numPendingTests,total:r.numTotalTests,files:r.testResults.length}; } catch {}
  }
  writeFileSync(path.join(out,'commands.json'),JSON.stringify(records,null,2)+'\n');
  console.log('END '+id+' '+record.code+' '+JSON.stringify(record.counts??{}));
  if(record.code!==0) {process.exitCode=1;return false;} return true;
}
const cli='/tmp/codex-cli-0.153.3/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex';
if(!await run('build','npm',['run','build'])) process.exit(1);
if(!await run('typecheck',path.join(cwd,'node_modules/.bin/tsc'),['--noEmit','-p','tsconfig.json'])) process.exit(1);
if(!await run('validate-fast','npm',['run','validate:fast'],{CODEX_MCP_BRIDGE_CODEX:cli})) process.exit(1);
if(!await run('node-full',path.join(cwd,'node_modules/.bin/vitest'),['run','--maxWorkers=1','--reporter=default','--reporter=json','--outputFile.json='+path.join(out,'node-full.json')],{ISSUE_242_R502_TUNNEL_BINARY:'/opt/homebrew/bin/tunnel-client',ISSUE_242_R502_REPORT:path.join(out,'proxy-matrix.json'),ISSUE_242_R502_TUNNEL_REPORT:path.join(out,'tunnel-matrix.json')})) process.exit(1);
if(!await run('native-full','npm',['run','macos:check'])) process.exit(1);
if(!await run('characterization-1200',path.join(cwd,'node_modules/.bin/tsx'),['scripts/issue-242-characterization.ts','1200'])) process.exit(1);
if(!await run('completion-counts',path.join(cwd,'node_modules/.bin/tsx'),['scripts/issue-242-completion.ts'])) process.exit(1);
if(!await run('tunnel-cost','node',['scripts/issue-242-runtime-cost.mjs','compare','/opt/homebrew/bin/tunnel-client'])) process.exit(1);
