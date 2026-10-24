// Isolated runtime observation cost fixture; never opens operational state.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { writeManagedRuntimeStatus } from './runtime-status.mjs';
import { computeSourceHash } from './build-fingerprint.mjs';
import { fileURLToPath } from 'node:url';

const implementationSourceHash = computeSourceHash(fileURLToPath(new URL('..', import.meta.url)));
const mode = process.argv[2] ?? 'compare';
if (!['baseline', 'compare'].includes(mode)) throw new Error('Use baseline or compare');
const tunnelClient = process.argv[3] ?? 'tunnel-client';
const root = fs.mkdtempSync(join(tmpdir(), 'issue-242-w4-cost-'));
const pidFile = join(root, 'pid');
const urlFile = join(root, 'url');
let delay = 0;
const server = createServer((req, res) => {
  setTimeout(() => {
    if (req.url === '/metrics') res.end('commands_poll_last_successful_timestamp_seconds ' + Date.now() / 1000 + '\n');
    else res.end(req.url === '/healthz' ? 'live\n' : 'ready\n');
  }, req.url === '/metrics' ? 0 : delay);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
fs.writeFileSync(urlFile, `http://127.0.0.1:${server.address().port}\n`, {mode: 0o600});
fs.writeFileSync(pidFile, String(process.pid), {mode: 0o600});
const summarize = values => {
  const sorted = values.toSorted((a,b) => a-b);
  const at = q => Number(sorted[Math.max(0, Math.ceil(sorted.length*q)-1)].toFixed(3));
  return {n: sorted.length, p50: at(.5), p95: at(.95), p99: at(.99), max: at(1)};
};
const command = args => new Promise(resolve => {
  const started = performance.now();
  const child = execFile(tunnelClient, args, { timeout: 5000, killSignal:'SIGKILL', maxBuffer:64*1024 }, (error, stdout) => {
    let report;
    try { report = JSON.parse(stdout); } catch {}
    resolve({ durationMs: performance.now()-started, code:error?.code ?? 0,
      healthz: report?.healthz?.status ?? null, readyz:report?.readyz?.status ?? null,
      pollOK:report?.control_plane_poll?.ok ?? null });
  });
});
const healthArgs = ['health','--json','--url-file',urlFile,'--pid-file',pidFile,'--require-control-plane-poll'];
let observerForCleanup;
const loop = monitorEventLoopDelay({resolution:10}); loop.enable();
try {
  const version = await new Promise(resolve => execFile(tunnelClient,['--version'],(err,out) => resolve(err ? 'unavailable' : out.trim())));
  const samples = [];
  for(let i=0;i<60;i++) samples.push(await command(healthArgs));
  const emptyExec=[], spawnTime=[], spawnTotal=[];
  for(let i=0;i<60;i++) {
    const start=performance.now();
    await new Promise(resolve => execFile(process.execPath,['-e',''],resolve));
    emptyExec.push(performance.now()-start);
    const startSpawn=performance.now();
    await new Promise((resolve,reject) => {
      const child=spawn(process.execPath,['-e',''], {stdio:'ignore'});
      child.once('spawn',()=>spawnTime.push(performance.now()-startSpawn));
      child.once('error',reject);
      child.once('exit',()=>{spawnTotal.push(performance.now()-startSpawn);resolve();});
    });
  }
  const writes=[], fileSync=[], directorySync=[];
  const originalSync=fs.fsyncSync;
  fs.fsyncSync=fd => {
    const start=performance.now();
    try { return originalSync(fd); }
    finally {(fs.fstatSync(fd).isDirectory() ? directorySync : fileSync).push(performance.now()-start);}
  };
  syncBuiltinESMExports();
  try {
    for(let i=0;i<60;i++) {
      const start=performance.now();
      writeManagedRuntimeStatus(join(root,'status.json'),{phase:'running',runtimeBuildId:'fixture',
        tunnel:{phase:'connected',profile:'managed',transport:'stdio',doctorPassed:true,processRunning:true,
          connected:true,lastCheckedAt:new Date().toISOString(),lastError:null,lastProblem:null}});
      writes.push(performance.now()-start);
    }
  } finally {fs.fsyncSync=originalSync;syncBuiltinESMExports();}
  const output={mode,implementationSourceHash,node:process.version,platform:process.platform,arch:process.arch,tunnelClientVersion:version,
    samples:60,units:'milliseconds',baseline:{healthExec:summarize(samples.map(v=>v.durationMs)),
      healthFailureCount:samples.filter(v=>v.code!==0).length,emptyNodeExec:summarize(emptyExec),
      emptyNodeSpawnEvent:summarize(spawnTime),emptyNodeSpawnExit:summarize(spawnTotal),
      managedAtomicJSON:summarize(writes),managedJSONBytes:fs.statSync(join(root,'status.json')).size,fileFsync:summarize(fileSync),directoryFsync:summarize(directorySync)},
    delayFixtures:[]};
  let observer;
  if(mode==='compare') {
    const {createTunnelHealthObserver}=await import('./tunnel-health.mjs');
    observer=observerForCleanup=createTunnelHealthObserver({urlFile,pidFile,expectedPid:process.pid});
    const direct=[], afterWrites=[], afterFileSync=[], afterDirectorySync=[];
    for(let i=0;i<60;i++) {
      const start=performance.now();
      const result=await observer.probe();
      if(!result.connected) throw new Error('direct fixture not connected');
      direct.push(performance.now()-start);
    }
    fs.fsyncSync=fd => {
      const start=performance.now();
      try { return originalSync(fd); }
      finally {(fs.fstatSync(fd).isDirectory() ? afterDirectorySync : afterFileSync).push(performance.now()-start);}
    };
    syncBuiltinESMExports();
    try {
      const observation=(await observer.probe()).observation;
      for(let i=0;i<60;i++) {
        const start=performance.now();
        writeManagedRuntimeStatus(join(root,'after-status.json'),{phase:'running',runtimeBuildId:'fixture',
          tunnel:{phase:'connected',profile:'managed',transport:'stdio',doctorPassed:true,processRunning:true,
            connected:true,lastCheckedAt:new Date().toISOString(),lastError:null,lastProblem:null,observation}});
        afterWrites.push(performance.now()-start);
      }
    } finally {fs.fsyncSync=originalSync;syncBuiltinESMExports();}
    output.after={directHealth:summarize(direct),repetitiveHealthSubprocesses:0,
      managedAtomicJSON:summarize(afterWrites),managedJSONBytes:fs.statSync(join(root,'after-status.json')).size,fileFsync:summarize(afterFileSync),
      directoryFsync:summarize(afterDirectorySync),writeCadenceMs:5000};
  }
  for(const endpointDelayMs of [700,3000]) {
    delay=endpointDelayMs;
    const before=await command(healthArgs);
    let after;
    if(observer) {
      const start=performance.now(); const result=await observer.probe();
      after={durationMs:Number((performance.now()-start).toFixed(3)),...result};
    }
    output.delayFixtures.push({endpointDelayMs,before,after});
  }
  output.parentEventLoopDelayMs={p99:Number((loop.percentile(99)/1e6).toFixed(3)),max:Number((loop.max/1e6).toFixed(3))};
  process.stdout.write(JSON.stringify(output,null,2)+'\n');
} finally {
  loop.disable();observerForCleanup?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  fs.rmSync(root,{recursive:true,force:true});
}
