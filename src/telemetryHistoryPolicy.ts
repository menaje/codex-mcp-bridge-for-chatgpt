import type Database from "better-sqlite3";
import { historyExpired, readAppliedHistoryPolicy, type AppliedHistoryPolicy } from "./historyPolicy.js";

type TransportClock = {job_id?:string|null;created_at:number};
function policy(source:Database.Database|undefined,now:number):AppliedHistoryPolicy {
  // Standalone/new diagnostic fixtures have no saved settings. Production
  // always supplies its existing operational DB as a read-only policy source.
  return source ? readAppliedHistoryPolicy(source,now) : {retentionDays:30,policyRevision:"new-installation-30",
    settingsRevision:0,evaluatedAt:now,cutoffAt:now-30*86_400_000};
}
function jobClocks(source:Database.Database|undefined,records:readonly TransportClock[]) {
  const clocks=new Map<string,{at:number|null;expired:boolean}>();
  const ids=[...new Set(records.flatMap(x=>x.job_id ? [x.job_id] : []))];
  if(!source) return clocks;
  for(let offset=0;offset<ids.length;offset+=500) {
    const part=ids.slice(offset,offset+500);
    const rows=source.prepare(`SELECT j.job_id,j.ended_at,h.expired_at FROM jobs j
      LEFT JOIN work_history_state h ON h.job_id=j.job_id WHERE j.job_id IN (${part.map(()=>"?").join(",")})`)
      .all(...part) as Array<{job_id:string;ended_at:number|null;expired_at:number|null}>;
    for(const row of rows) clocks.set(row.job_id,{at:row.ended_at,expired:row.expired_at!==null});
  }
  return clocks;
}

export function visibleTransportRecords<T extends {jobId?:string;createdAt:number}>(
  records:readonly T[],source:Database.Database|undefined,now=Date.now()
):T[] {
  const current=policy(source,now),clocks=jobClocks(source,records.map(x=>({job_id:x.jobId,created_at:x.createdAt})));
  return records.filter(record=>{
    const clock=record.jobId ? clocks.get(record.jobId) : undefined;
    return !clock?.expired && !historyExpired(clock ? clock.at : record.createdAt,current);
  });
}

/** A bounded slice in the telemetry owner's transaction. Every actual delete
 * rereads the persisted source policy; no policy/cutoff crosses IPC as a plan. */
export function sweepTelemetryHistory(database:Database.Database,source?:Database.Database,now=Date.now(),limit=64):number {
  return database.transaction(()=>{
    const initial=policy(source,now);
    let removed=0;
    const domains=[['transport','transport_observations','observation_id'],
      ['measurement','runtime_measurements','measurement_id'],['diagnostic','diagnostic_events','event_id']] as const;
    for(const [kind,table,id] of domains) {
      const marker=`history/${kind}`;
      const saved=database.prepare("SELECT cursor FROM telemetry_retention_state WHERE kind=?").get(marker) as {cursor:number}|undefined;
      const rows=database.prepare(`SELECT * FROM ${table} WHERE ${id}>? ORDER BY ${id} LIMIT ?`)
        .all(saved?.cursor || 0,Math.max(1,Math.min(64,limit))) as Array<Record<string,unknown>>;
      const clocks=kind==='transport' ? jobClocks(source,rows as unknown as TransportClock[]) : new Map();
      for(const row of rows) {
        const latest=policy(source,now);
        const clock=typeof row.job_id==='string' ? clocks.get(row.job_id) : undefined;
        if(clock?.expired || historyExpired(clock ? clock.at : Number(row.created_at),latest)) {
          removed+=database.prepare(`DELETE FROM ${table} WHERE ${id}=?`).run(row[id]).changes;
        }
      }
      database.prepare(`INSERT INTO telemetry_retention_state(kind,cursor,last_completed_at) VALUES (?,?,?)
        ON CONFLICT(kind) DO UPDATE SET cursor=excluded.cursor,last_completed_at=excluded.last_completed_at`)
        .run(marker,rows.length<Math.min(64,limit) ? 0 : Number(rows.at(-1)?.[id] || 0),now);
    }
    // Only the most recent local ACK/retry window needs orphan delivery UUIDs.
    // This is a control receipt, with no event body, scope, message or diagnostic.
    database.prepare(`DELETE FROM telemetry_record_deliveries WHERE delivery_id IN (
      SELECT d.delivery_id FROM telemetry_record_deliveries d WHERE
      d.delivery_id NOT IN (SELECT delivery_id FROM telemetry_record_deliveries ORDER BY created_at DESC,rowid DESC LIMIT 64)
      AND ((record_type='transport' AND NOT EXISTS (SELECT 1 FROM transport_observations WHERE observation_id=d.record_id))
       OR (record_type='measurement' AND NOT EXISTS (SELECT 1 FROM runtime_measurements WHERE measurement_id=d.record_id))
       OR (record_type='diagnostic' AND NOT EXISTS (SELECT 1 FROM diagnostic_events WHERE event_id=d.record_id))) LIMIT 64
    )`).run();
    database.prepare(`INSERT INTO telemetry_meta(key,value) VALUES ('history_policy',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify({policyRevision:initial.policyRevision,
        retentionDays:initial.retentionDays,evaluatedAt:now,removed}));
    return removed;
  })();
}
