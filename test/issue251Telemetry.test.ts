import Database from "better-sqlite3";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {describe,it,expect,vi,afterEach} from "vitest";
import {BridgeStateStore} from "../src/stateStore.js";
import {sweepTelemetryHistory,visibleTransportRecords} from "../src/telemetryHistoryPolicy.js";
const now=Date.UTC(2026,9,14),day=86_400_000;
afterEach(()=>vi.restoreAllMocks());
function fixture(days:number) {
  const file=path.join(mkdtempSync(path.join(tmpdir(),"issue251-telemetry-")),"state.sqlite");
  const store=new BridgeStateStore({file});store.writeSettings({historyRetentionDays:days},0,now);
  const source=new Database(file),telemetry=new Database(":memory:");
  telemetry.exec(`CREATE TABLE transport_observations(observation_id INTEGER PRIMARY KEY,job_id TEXT,created_at INTEGER);
    CREATE TABLE runtime_measurements(measurement_id INTEGER PRIMARY KEY,created_at INTEGER);
    CREATE TABLE diagnostic_events(event_id INTEGER PRIMARY KEY,created_at INTEGER);
    CREATE TABLE telemetry_retention_state(kind TEXT PRIMARY KEY,cursor INTEGER,last_completed_at INTEGER);
    CREATE TABLE telemetry_record_deliveries(delivery_id TEXT PRIMARY KEY,record_type TEXT,record_id INTEGER,created_at INTEGER);
    CREATE TABLE telemetry_meta(key TEXT PRIMARY KEY,value TEXT);`);
  return {store,source,telemetry,close(){telemetry.close();source.close();store.close();}};
}
describe("#251 telemetry shares the persisted history policy",()=>{
  for(const days of [7,30,90,0]) it(`retains independent ${days}-day fixtures by occurrence or exact Job end`,()=>{
    const f=fixture(days);
    try {
      for(const [index,age] of [6,20,40,100].entries()) {
        const at=now-age*day;
        for(const [table,id] of [["runtime_measurements","measurement_id"],["diagnostic_events","event_id"]])
          f.telemetry.prepare(`INSERT INTO ${table}(${id},created_at) VALUES (?,?)`).run(index+1,at);
        f.store.upsertJob({jobId:`job-${age}`,requestId:`request-${age}`,scopeId:"11111111-1111-4111-8111-111111111111",status:"failed",createdAt:at-1,updatedAt:at});
        // A later transport observation must not restart the execution clock.
        f.telemetry.prepare("INSERT INTO transport_observations VALUES (?,?,?)").run(index+1,`job-${age}`,now);
      }
      f.store.upsertJob({jobId:"active",requestId:"request-active",scopeId:"11111111-1111-4111-8111-111111111111",status:"running",createdAt:now-100*day,updatedAt:now});
      f.telemetry.prepare("INSERT INTO transport_observations VALUES (5,'active',?)").run(now-100*day);
      const memory=[6,20,40,100].map(age=>({jobId:`job-${age}`,createdAt:now}));
      expect(visibleTransportRecords(memory,f.source,now).map(x=>x.jobId)).toEqual(
        [6,20,40,100].filter(age=>days===0||age<days).map(age=>`job-${age}`));
      sweepTelemetryHistory(f.telemetry,f.source,now);
      const expected=[6,20,40,100].filter(age=>days===0||age<days).length;
      expect(f.telemetry.prepare("SELECT count(*) n FROM transport_observations").get()).toEqual({n:expected+1});
      expect(f.telemetry.prepare("SELECT count(*) n FROM diagnostic_events").get()).toEqual({n:expected});
      expect(f.telemetry.prepare("SELECT count(*) n FROM runtime_measurements").get()).toEqual({n:expected});
      expect(f.source.prepare("SELECT status FROM jobs WHERE job_id='active'").get()).toEqual({status:"running"});
    } finally {f.close();}
  });
  it("rereads policy immediately before deleting and preserves everything on a read failure",()=>{
    const f=fixture(7);
    try {
      f.telemetry.prepare("INSERT INTO diagnostic_events VALUES(1,?)").run(now-100*day);
      const original=f.source.prepare.bind(f.source);let reads=0;
      vi.spyOn(f.source,"prepare").mockImplementation((sql:string)=>{
        if(sql.includes("user_settings") && ++reads===2) f.store.writeSettings({historyRetentionDays:0},1,now);
        return original(sql);
      });
      expect(()=>sweepTelemetryHistory(f.telemetry,f.source,now)).toThrow(/locked/);
      f.store.writeSettings({historyRetentionDays:0},1,now);
      expect(sweepTelemetryHistory(f.telemetry,f.source,now)).toBe(0);
      f.source.prepare("UPDATE user_settings SET payload='{}'").run();
      expect(()=>sweepTelemetryHistory(f.telemetry,f.source,now)).toThrow(/HISTORY_POLICY_UNAVAILABLE/);
      expect(f.telemetry.prepare("SELECT count(*) n FROM diagnostic_events").get()).toEqual({n:1});
    } finally {f.close();}
  });
  it("does not resurrect expired Job telemetry after a policy extension",()=>{
    const f=fixture(7);
    try {
      f.store.upsertJob({jobId:"expired",requestId:"request-expired",scopeId:"11111111-1111-4111-8111-111111111111",status:"failed",createdAt:now-40*day,updatedAt:now-40*day});
      f.store.maintainHistoryRetention(now);f.store.writeSettings({historyRetentionDays:0},1,now);
      f.telemetry.prepare("INSERT INTO transport_observations VALUES(1,'expired',?)").run(now);
      expect(visibleTransportRecords([{jobId:"expired",createdAt:now}],f.source,now)).toEqual([]);
      expect(sweepTelemetryHistory(f.telemetry,f.source,now)).toBe(1);
    } finally {f.close();}
  });
  it("uses bounded slices without imposing durable count limits in indefinite mode",()=>{
    const f=fixture(0);
    try {
      const put=f.telemetry.prepare("INSERT INTO diagnostic_events VALUES (?,?)");
      f.telemetry.transaction(()=>{for(let n=1;n<=1200;n++)put.run(n,now-100*day);})();
      for(let n=0;n<20;n++)expect(sweepTelemetryHistory(f.telemetry,f.source,now)).toBe(0);
      expect(f.telemetry.prepare("SELECT count(*) n FROM diagnostic_events").get()).toEqual({n:1200});
    } finally {f.close();}
  });
});
