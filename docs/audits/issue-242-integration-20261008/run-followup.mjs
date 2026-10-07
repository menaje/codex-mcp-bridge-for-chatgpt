import { spawn,execFileSync } from 'node:child_process';
import { openSync,closeSync,writeFileSync,readFileSync,existsSync,mkdtempSync } from 'node:fs';
import path from 'node:path';
const cwd='/Volumes/Data/Dev/codex-mcp-bridge-issue-242-integration-review',base='/Volumes/Data/Dev/codex-mcp-bridge-issue-242-integration-base';
const out=path.join(cwd,'docs/audits/issue-242-integration-20261008');
while(true){const records=JSON.parse(readFileSync(path.join(out,'commands.json')));if(records.find(r=>r.id==='node-full'&&r.finishedAt))break;await new Promise(r=>setTimeout(r,5000));}
const records=[];
const env={...process.env,TMPDIR:'/tmp/cb242-int-tswwmblu'};delete env.CODEX_HOME;delete env.CODEX_MCP_BRIDGE_LIVE_COMPANION_SOCKET;
const source=dir=>execFileSync('git',['show','-s','--format=%H %P %T','HEAD'],{cwd:dir,encoding:'utf8'}).trim();
async function run(id,dir,command,args,extra={}){
 const record={id,source:source(dir),cwd:dir,command:'/usr/sbin/taskpolicy',args:['-a',command,...args],envOverrides:extra,startedAt:new Date().toISOString()};records.push(record);writeFileSync(path.join(out,'followup-commands.json'),JSON.stringify(records,null,2)+'\n');
 console.log('START '+id);const fd=openSync(path.join(out,id+'.log'),'w'),at=Date.now();
 const child=spawn(record.command,record.args,{cwd:dir,env:{...env,...extra},stdio:['ignore',fd,fd]});
 Object.assign(record,await new Promise(resolve=>{child.once('error',e=>resolve({error:String(e)}));child.once('exit',(code,signal)=>resolve({code,signal}));}),{durationMs:Date.now()-at,finishedAt:new Date().toISOString()});closeSync(fd);
 if(command.endsWith('/vitest')){try{const r=JSON.parse(readFileSync(path.join(out,id+'.json')));record.counts={passed:r.numPassedTests,failed:r.numFailedTests,skipped:r.numPendingTests,total:r.numTotalTests,files:r.testResults.length,failedFiles:r.testResults.filter(r=>r.status==='failed').length};}catch{}}
 writeFileSync(path.join(out,'followup-commands.json'),JSON.stringify(records,null,2)+'\n');console.log('END '+id+' '+record.code+' '+JSON.stringify(record.counts??{}));return record;
}
const test=(id,dir,files,args=[],extra={})=>run(id,dir,path.join(dir,'node_modules/.bin/vitest'),['run',...files,'--maxWorkers=1','--reporter=default','--reporter=json',`--outputFile.json=${path.join(out,id+'.json')}`,...args],extra);
await run('harness-typecheck',cwd,path.join(cwd,'node_modules/.bin/tsc'),['--noEmit','--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext','--strict','--skipLibCheck','--esModuleInterop','scripts/issue-242-characterization.ts','scripts/issue-242-completion.ts','scripts/issue-242-fixture.ts']);
await test('w1-followup-contracts',cwd,['test/issue242Reads.test.ts','test/displayReadPool.test.ts','test/remoteCompanionServer.test.ts','test/mcpEvents.test.ts']);
await run('w3-compiled',cwd,'node',['docs/audits/issue-242-w3-20261007/runtime-probe.mjs']);
await test('tunnel-pinned',cwd,['test/issue242R502Tunnel.test.ts'],[],{ISSUE_242_R502_TUNNEL_BINARY:'/opt/homebrew/bin/tunnel-client',ISSUE_242_R502_TUNNEL_REPORT:path.join(out,'tunnel-pinned-matrix.json')});
const baseTmp=mkdtempSync('/tmp/cb242-base-');
await run('baseline-build',base,'npm',['run','build'],{TMPDIR:baseTmp});
await run('baseline-characterization-1200',base,path.join(base,'node_modules/.bin/tsx'),['scripts/issue-242-characterization.ts','1200'],{TMPDIR:baseTmp});
writeFileSync(path.join(env.TMPDIR,'base-progress.ts'),`import assert from 'node:assert/strict';\nimport { issue242Fixture } from '${base}/scripts/issue-242-fixture.ts';\nconst f=await issue242Fixture(40);const topics={dashboard:0};const off=f.jobs.subscribeChanges(()=>topics.dashboard++);\ntry{const jobs=f.jobs.list(40,0).slice(0,4);jobs.forEach(j=>j.status='running');const measure=await f.measure(()=>{for(let i=0;i<400;i++)(f.jobs as any).recordProgress(jobs[i%4],{progress:i})});assert.equal(topics.dashboard,400);assert.equal(measure.changedRows,0);console.log(JSON.stringify({sourceHead:'f710974b33fc40432653c815d175058cba1adaee',fixture:{retainedJobs:40,progressJobs:4,progressEvents:400},progress400:{...measure,result:undefined,topics},limits:['Native claims are not inferred from direct registry notices. Legacy scheduling reads each dashboard notice; Swift measurements are separate.']},null,2));}finally{off();await f.close();}\n`);
await run('baseline-progress',base,path.join(base,'node_modules/.bin/tsx'),[path.join(env.TMPDIR,'base-progress.ts')],{TMPDIR:baseTmp});
const failures=new Map();
for(const id of ['focused-242','lifecycle-capacity-db','node-full','w1-followup-contracts']){const file=path.join(out,id+'.json');if(!existsSync(file))continue;for(const suite of JSON.parse(readFileSync(file)).testResults)for(const a of suite.assertionResults)if(a.status==='failed')failures.set(suite.name+'::'+a.fullName,{file:path.relative(cwd,suite.name),fullName:a.fullName,title:a.title,messages:a.failureMessages,stage:id});}
writeFileSync(path.join(out,'failure-selection.json'),JSON.stringify([...failures.values()],null,2)+'\n');
if(failures.size){const old=[...failures.values()].filter(f=>existsSync(path.join(base,f.file)));const missing=[...failures.values()].filter(f=>!existsSync(path.join(base,f.file)));writeFileSync(path.join(out,'baseline-selection.json'),JSON.stringify({old,missing,baselineSource:source(base)},null,2)+'\n');const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');const pattern=[...new Set(old.map(f=>escape(f.title)))].join('|');if(old.length)await test('baseline-selected-failures',base,[...new Set(old.map(f=>f.file))],['-t',pattern],{TMPDIR:baseTmp});const all=[...failures.values()];await test('candidate-selected-failures',cwd,[...new Set(all.map(f=>f.file))],['-t',[...new Set(all.map(f=>escape(f.title)))].join('|')]);}
console.log('FOLLOWUP COMPLETE');
