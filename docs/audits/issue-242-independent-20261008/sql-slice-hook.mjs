import Database from '/Volumes/Data/Dev/codex-mcp-bridge-issue-242-independent-20261008/node_modules/better-sqlite3/lib/index.js';
import { writeFileSync } from 'node:fs';
// Instrument only the owned compiled read child. The product source is untouched.
if(process.argv.includes('--bridge-state-read-child')) {
  const original=Database.prototype.prepare;
  let held=false;
  Database.prototype.prepare=function(sql,...args) {
    const statement=original.call(this,sql,...args);
    if(!held && sql.includes('SELECT j.payload,j.job_id,j.scope_id')) {
      const all=statement.all;
      statement.all=function(...values) {
        if(!held) {
          held=true;
          writeFileSync(process.env.ISSUE_242_SQL_SLICE_MARKER,'entered');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500);
        }
        return all.apply(this,values);
      };
    }
    return statement;
  };
}
