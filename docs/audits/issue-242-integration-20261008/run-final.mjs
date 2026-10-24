import {spawn,execFileSync} from 'node:child_process';
import {openSync,closeSync,writeFileSync,readFileSync,mkdtempSync,existsSync} from 'node:fs';
import path from 'node:path';
const cwd='/Volumes/Data/Dev/codex-mcp-bridge-issue-242-integration-review',base='/Volumes/Data/Dev/codex-mcp-bridge-issue-242-integration-base';
const out=path.join(cwd,'docs/audits/issue-242-integration-20261008'),tmpdir=mkdtempSync('/tmp/cb242-final-');
if(existsSync('/tmp/package.json')||existsSync(path.join(tmpdir,'package.json')))throw new Error('Unexpected ancestor module-mode file');
const env={...process.env,TMPDIR:tmpdir};delete env.CODEX_HOME;delete env.CODEX_MCP_BRIDGE_LIVE_COMPANION_SOCKET;delete env.CODEX_MCP_BRIDGE_LIVE_REMOTE_INVITATION;
const records=[];
async function run(id,dir,command,args,extra={}){
 const source=execFileSync('git',['show','-s','--format=%H %P %T','HEAD'],{cwd:dir,encoding:'utf8'}).trim();
 const record={id,source,cwd:dir,tmpdir,command:'/usr/sbin/taskpolicy',args:['-a',command,...args],envOverrides:extra,startedAt:new Date().toISOString()};records.push(record);writeFileSync(path.join(out,'final-commands.json'),JSON.stringify(records,null,2)+'\n');
 console.log('START '+id);const fd=openSync(path.join(out,id+'.log'),'w'),at=Date.now();const child=spawn(record.command,record.args,{cwd:dir,env:{...env,...extra},stdio:['ignore',fd,fd]});Object.assign(record,await new Promise(resolve=>{child.once('error',error=>resolve({error:String(error)}));child.once('exit',(code,signal)=>resolve({code,signal}));}),{durationMs:Date.now()-at,finishedAt:new Date().toISOString()});closeSync(fd);
 if(command.endsWith('/vitest')){try{const r=JSON.parse(readFileSync(path.join(out,id+'.json')));record.counts={passed:r.numPassedTests,failed:r.numFailedTests,skipped:r.numPendingTests,total:r.numTotalTests,files:r.testResults.length,failedFiles:r.testResults.filter(s=>s.status==='failed').length};}catch{}}
 writeFileSync(path.join(out,'final-commands.json'),JSON.stringify(records,null,2)+'\n');console.log('END '+id+' '+record.code+' '+JSON.stringify(record.counts??{}));return record;
}
const test=(id,dir,files,extra={})=>run(id,dir,path.join(dir,'node_modules/.bin/vitest'),['run',...files,'--maxWorkers=1','--reporter=default','--reporter=json',`--outputFile.json=${path.join(out,id+'.json')}`],extra);
await run('final-build',cwd,'npm',['run','build']);
await run('final-tsc-noemit',cwd,path.join(cwd,'node_modules/.bin/tsc'),['--noEmit','-p','tsconfig.json']);
await run('final-validate-fast',cwd,'npm',['run','validate:fast'],{CODEX_MCP_BRIDGE_CODEX:'/tmp/codex-cli-0.153.3/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex'});
await test('final-r502-retirement',cwd,['test/issue242R502.test.ts','test/httpDiagnostics.test.ts','test/experimentRetirement.test.ts'],{ISSUE_242_R502_REPORT:path.join(out,'final-proxy-matrix.json')});
await test('baseline-proxy-controls',base,['test/issue242ProxyCharacterization.test.ts']);
await run('final-characterization-1200',cwd,path.join(cwd,'node_modules/.bin/tsx'),['scripts/issue-242-characterization.ts','1200']);
await run('final-completion-counts',cwd,path.join(cwd,'node_modules/.bin/tsx'),['scripts/issue-242-completion.ts']);
await run('final-tunnel-cost',cwd,'node',['scripts/issue-242-runtime-cost.mjs','compare','/opt/homebrew/bin/tunnel-client']);
await test('final-node-full',cwd,[],{ISSUE_242_R502_TUNNEL_BINARY:'/opt/homebrew/bin/tunnel-client',ISSUE_242_R502_REPORT:path.join(out,'final-node-proxy-matrix.json'),ISSUE_242_R502_TUNNEL_REPORT:path.join(out,'final-node-tunnel-matrix.json')});
