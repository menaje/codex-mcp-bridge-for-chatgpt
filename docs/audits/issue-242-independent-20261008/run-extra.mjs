import {spawn,execFileSync} from 'node:child_process';
import {openSync,closeSync,writeFileSync,readFileSync,mkdtempSync} from 'node:fs';
import path from 'node:path';
const cwd='/Volumes/Data/Dev/codex-mcp-bridge-issue-242-independent-20261008',out='/tmp/issue-242-independent-20261008';
const prior=JSON.parse(readFileSync(path.join(out,'commands.json')));
if(prior.length!==8||prior.some(row=>row.code!==0))throw new Error('Prior validation must finish successfully before focused extras');
const tmpdir=mkdtempSync('/tmp/cb242-independent-extra-');
const env={...process.env,TMPDIR:tmpdir};
for(const k of Object.keys(env))if(k==='CODEX_HOME'||k.startsWith('CODEX_MCP_BRIDGE_LIVE_')||k.startsWith('CONTROL_PLANE_')||k==='OPENAI_API_KEY'||k==='CODEX_API_KEY')delete env[k];
const records=[];
for(const id of ['harness-typecheck','sql-slice','read-samples']) {
  const command='/usr/sbin/taskpolicy',args=id==='harness-typecheck'
    ? ['-a',path.join(cwd,'node_modules/.bin/tsc'),'--noEmit','--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext','--strict','--skipLibCheck','--esModuleInterop','scripts/issue-242-characterization.ts','scripts/issue-242-completion.ts','scripts/issue-242-fixture.ts']
    : ['-a',path.join(cwd,'node_modules/.bin/tsx'),path.join(out,id+'.mts')];
  const record={id,cwd,tmpdir,command,args,source:execFileSync('git',['show','-s','--format=%H %P %T','HEAD'],{cwd,encoding:'utf8'}).trim(),startedAt:new Date().toISOString()};
  records.push(record);writeFileSync(path.join(out,'extra-commands.json'),JSON.stringify(records,null,2)+'\n');
  console.log('START '+id);const fd=openSync(path.join(out,id+'.log'),'w'),at=Date.now();
  const child=spawn(command,args,{cwd,env,stdio:['ignore',fd,fd]});
  Object.assign(record,await new Promise(resolve=>{child.once('error',error=>resolve({error:String(error)}));child.once('exit',(code,signal)=>resolve({code,signal}));}),{durationMs:Date.now()-at,finishedAt:new Date().toISOString()});
  closeSync(fd);writeFileSync(path.join(out,'extra-commands.json'),JSON.stringify(records,null,2)+'\n');
  console.log('END '+id+' '+record.code);
  if(record.code!==0){process.exitCode=1;break;}
}
