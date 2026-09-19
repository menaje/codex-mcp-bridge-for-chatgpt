import type Database from "better-sqlite3";

export type DashboardArchivedJobRow = {
  job_id: string;
  scope_id: string;
  activity_id: string;
  agent_id: string | null;
  backend_kind: string | null;
  status: string;
  created_at: number;
  updated_at: number;
  summary: string;
  agent_total?: number;
};

export type DashboardArchivedCounts = {
  total: number;
  completed: number;
  failed: number;
  interrupted: number;
  cancelled: number;
};

const retainedHistoryPredicate = `
  archived_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM work_history_state h
     WHERE h.job_id=jobs.job_id AND h.expired_at IS NOT NULL
  )`;

/** Read-only SQL projections for cards. No method performs cleanup or writes. */
export class DashboardReadModel {
  constructor(private readonly db: Database.Database) {}

  archivedByAgent(scopeId: string | undefined, perAgentLimit: number): {
    rows: DashboardArchivedJobRow[];
    totalsByAgent: Map<string, number>;
  } {
    const limit = Math.max(1, Math.min(100, Math.floor(perAgentLimit)));
    const rows = this.db.prepare(`
      WITH ranked AS (
        SELECT job_id,scope_id,activity_id,agent_id,backend_kind,status,
               created_at,updated_at,summary,
               ROW_NUMBER() OVER (
                 PARTITION BY COALESCE(agent_id,'')
                 ORDER BY updated_at DESC,job_id DESC
               ) AS agent_rank,
               COUNT(*) OVER (PARTITION BY COALESCE(agent_id,'')) AS agent_total
          FROM jobs
         WHERE ${retainedHistoryPredicate}
           ${scopeId ? "AND scope_id=?" : ""}
      )
      SELECT job_id,scope_id,activity_id,agent_id,backend_kind,status,
             created_at,updated_at,summary,agent_total
        FROM ranked
       WHERE agent_rank<=?
       ORDER BY updated_at DESC,job_id DESC
    `).all(...(scopeId ? [scopeId, limit] : [limit])) as DashboardArchivedJobRow[];
    const totalsByAgent = new Map<string, number>();
    for (const row of rows) {
      if (row.agent_id) totalsByAgent.set(row.agent_id, Number(row.agent_total || 0));
    }
    return { rows, totalsByAgent };
  }

  agentHistory(scopeId: string, agentId: string, limit: number): {
    rows: DashboardArchivedJobRow[];
    total: number;
  } {
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = this.db.prepare(`
      SELECT job_id,scope_id,activity_id,agent_id,backend_kind,status,
             created_at,updated_at,summary,COUNT(*) OVER () AS agent_total
        FROM jobs
       WHERE ${retainedHistoryPredicate}
         AND scope_id=? AND agent_id=?
       ORDER BY updated_at DESC,job_id DESC
       LIMIT ?
    `).all(scopeId, agentId, boundedLimit) as DashboardArchivedJobRow[];
    return { rows, total: Number(rows[0]?.agent_total || 0) };
  }

  summaries(jobIds: readonly string[]): Map<string, string> {
    const summaries = new Map<string, string>();
    const uniqueJobIds = [...new Set(jobIds)];
    for (let offset = 0; offset < uniqueJobIds.length; offset += 500) {
      const chunk = uniqueJobIds.slice(offset, offset + 500);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => "?").join(",");
      const rows = this.db.prepare(`SELECT job_id,summary FROM jobs WHERE job_id IN (${placeholders})`)
        .all(...chunk) as Array<{job_id:string;summary:string}>;
      for (const row of rows) summaries.set(row.job_id, row.summary);
    }
    return summaries;
  }

  archivedCounts(scopeId?: string): DashboardArchivedCounts {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS total,
             COALESCE(SUM(status='completed'),0) AS completed,
             COALESCE(SUM(status='failed'),0) AS failed,
             COALESCE(SUM(status='interrupted'),0) AS interrupted,
             COALESCE(SUM(status='cancelled'),0) AS cancelled
        FROM jobs
       WHERE ${retainedHistoryPredicate}
         ${scopeId ? "AND scope_id=?" : ""}
    `).get(...(scopeId ? [scopeId] : [])) as DashboardArchivedCounts;
    return {
      total: Number(row.total),
      completed: Number(row.completed),
      failed: Number(row.failed),
      interrupted: Number(row.interrupted),
      cancelled: Number(row.cancelled)
    };
  }
}

/** Minimal pure status projection used for diagnostics and SQL-trace audits. */
export class StatusReadModel {
  constructor(private readonly db: Database.Database) {}

  job(jobId: string): { jobId: string; scopeId: string; status: string; version: number; updatedAt: number } | undefined {
    const row = this.db.prepare(`
      SELECT job_id,scope_id,status,job_version,updated_at FROM jobs WHERE job_id=?
    `).get(jobId) as {
      job_id:string;scope_id:string;status:string;job_version:number;updated_at:number;
    } | undefined;
    return row ? {
      jobId: row.job_id,
      scopeId: row.scope_id,
      status: row.status,
      version: row.job_version,
      updatedAt: row.updated_at
    } : undefined;
  }

  scopeOverview(scopeId: string): { total: number; active: number; terminal: number } {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS total,
             COALESCE(SUM(status IN ('running','terminating','termination-failed')),0) AS active,
             COALESCE(SUM(status IN ('completed','failed','interrupted','cancelled')),0) AS terminal
        FROM jobs WHERE scope_id=? AND archived_at IS NULL
    `).get(scopeId) as {total:number;active:number;terminal:number};
    return { total: Number(row.total), active: Number(row.active), terminal: Number(row.terminal) };
  }
}
