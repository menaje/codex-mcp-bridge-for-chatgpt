import { randomUUID } from 'node:crypto';
import { mkdtempSync,mkdirSync,realpathSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach,beforeEach,describe,expect,it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { BridgeStateStore } from '../src/stateStore.js';
import { UserSettingsStore } from '../src/userSettings.js';
import { ProjectLifecycleController } from '../src/projectLifecycle.js';
import type { CodexJobRegistry } from '../src/tools.js';
import type { ProjectRegistryOperation,ProjectTarget } from '../src/projectRegistry.js';
import type { CodexUpstream } from '../src/upstream.js';

describe('project recovery and actual work protection (#224 / #240)',()=>{
 let root:string,file:string,state:BridgeStateStore,settings:UserSettingsStore,controller:ProjectLifecycleController;
 beforeEach(()=>{
  root=realpathSync(mkdtempSync(path.join(tmpdir(),'project-recovery-')));file=path.join(root,'state.sqlite');state=new BridgeStateStore({file});
  settings=new UserSettingsStore(loadConfig({CODEX_MCP_BRIDGE_NO_AUTH:'1'}),{stateStore:state});
  controller=new ProjectLifecycleController(state,{stopForProjectArchive:async()=>{},refreshRetiredProjectState:()=>{}} as unknown as CodexJobRegistry,{releaseThreadConnection:async()=>({phase:'released',evidence:'thread-unloaded'})} as unknown as CodexUpstream);
 });
 afterEach(async()=>{await controller.close();state.close();rmSync(root,{recursive:true});});
 function apply(...ops:ProjectRegistryOperation[]){return settings.updateWithProjectOperations({},ops,undefined,settings.current.registryRevision);}
 function register(name='Original',folder='original'){const cwd=path.join(root,folder);mkdirSync(cwd,{recursive:true});apply({kind:'add',project:{name,cwd}});return settings.current.projects.find(p=>p.cwd===cwd)!;}
 function activity(p:ProjectTarget){return state.createActivity({scopeId:'11111111-1111-4111-8111-111111111111',projectId:p.id,projectName:p.name,projectCwd:p.cwd});}
 async function archive(p:ProjectTarget){apply({kind:'archive',projectId:p.id});await controller.sweep();}
 it.each(['open','sealed','terminating'])('retires a %s Activity without calling unfinished work completed',async lifecycle=>{
  const project=register(),work=activity(project);const db=new Database(file);db.prepare('UPDATE activities SET lifecycle=? WHERE activity_id=?').run(lifecycle,work.activityId);db.close();
  await archive(project);expect(state.getActivity(work.activityId)?.lifecycle).toBe('abandoned');apply({kind:'delete',projectId:project.id});expect(state.getActivity(work.activityId)).toBeUndefined();
  apply({kind:'add',project:{name:project.name,cwd:project.cwd}});expect(settings.current.projects[0]?.id).not.toBe(project.id);
 });
 it.each(['running','terminating','termination-failed'])('protects a real %s Job while archive remains unresolved',async status=>{
  const project=register(),work=activity(project);state.upsertJob({jobId:randomUUID(),requestId:randomUUID(),scopeId:work.scopeId,activityId:work.activityId,projectId:project.id,projectName:project.name,cwd:project.cwd,status,updatedAt:3});
  await archive(project);expect(settings.current.projects[0]?.archiveState).toBe('unresolved');expect(settings.current.projects[0]?.archivedAt).toBeUndefined();
  const before=settings.current;expect(()=>apply({kind:'delete',projectId:project.id})).toThrow('PROJECT_DELETE_REQUIRES_ARCHIVE');expect(settings.current).toEqual(before);
  expect(()=>apply({kind:'add',project:{name:'Replacement',cwd:project.cwd}})).toThrow('PROJECT_CWD_STILL_PINNED');
 });
 it('rolls back ordinary and unrelated project edits when archive completion is required',()=>{
  const project=register(),other=register('Other','other');apply({kind:'archive',projectId:project.id});const before=settings.current;
  expect(()=>settings.updateWithProjectOperations({maxConcurrentJobs:8},[{kind:'rename',projectId:other.id,name:'Changed'},{kind:'delete',projectId:project.id}],before.settingsRevision,before.registryRevision)).toThrow('PROJECT_DELETE_REQUIRES_ARCHIVE');expect(settings.current).toEqual(before);
 });
 it('restores only a completed registration and maintains active name/cwd conflicts',async()=>{
  const project=register();await archive(project);register(project.name,'replacement');const before=settings.current;
  expect(()=>apply({kind:'restore',projectId:project.id})).toThrow('PROJECT_NAME_CONFLICT');expect(settings.current).toEqual(before);
  apply({kind:'restore',projectId:project.id,name:'Recovered'});expect(settings.current.projects.find(p=>p.id===project.id)?.archiveState).toBe('active');
 });
 it('physically deletes rather than restoring a removed identity and rejects stale revisions',async()=>{
  const project=register();await archive(project);apply({kind:'delete',projectId:project.id});apply({kind:'add',project:{name:'Replacement',cwd:project.cwd}});
  expect(()=>apply({kind:'restore',projectId:project.id})).toThrow('PROJECT_NOT_FOUND');expect(settings.recoverableProjects).toEqual([]);
  expect(()=>settings.updateWithProjectOperations({},[{kind:'delete',projectId:project.id}],undefined,0)).not.toThrow();
 });
});
