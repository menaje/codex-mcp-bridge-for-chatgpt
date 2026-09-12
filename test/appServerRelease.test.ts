import path from "node:path";
import { describe, expect, it } from "vitest";
import { CodexAppServerUpstreamPool } from "../src/appServerUpstream.js";
import type { UpstreamWorkerAssignment } from "../src/upstream.js";
const fixture = path.resolve("test/fixtures/fake-codex-app-server.mjs");
const args = { cwd:"/tmp", sandbox:"read-only", "approval-policy":"never", prompt:"release fixture" };
async function start(pool: CodexAppServerUpstreamPool, extra: Record<string, unknown> = {}) {
  let assigned!: UpstreamWorkerAssignment;
  await pool.callTool("codex", {...args,...extra}, undefined, value => { assigned=value; });
  return assigned;
}
describe("App Server connection release", () => {
  it("requires a verified process exit for immediate release and leaves only explicit resume available", async () => {
    const pool = new CodexAppServerUpstreamPool(fixture,1);
    try {
      const {threadId} = await start(pool);
      const released = await pool.releaseThreadConnection(threadId!, {canRelease:()=>true,eligibleThreadIds:[threadId!]});
      expect(released).toMatchObject({phase:"released",evidence:"worker-exited"});
      await expect(pool.listBackgroundTerminals(threadId!)).rejects.toThrow(/THREAD_RELEASED/);
      expect(await pool.listLoadedBackgroundTerminals(threadId!)).toBeNull();
      // A read on a fresh worker cannot reclaim ownership of the released thread.
      await pool.probeThread(threadId!);
      await expect(pool.listBackgroundTerminals(threadId!)).rejects.toThrow(/THREAD_RELEASED/);
    } finally { await pool.close(); }
  });
  it("does not terminate a shared worker containing a protected ephemeral conversation", async () => {
    const pool = new CodexAppServerUpstreamPool(fixture,1);
    try {
      const target = await start(pool);
      const protectedThread = await start(pool,{ephemeral:true});
      expect(protectedThread.workerPid).toBe(target.workerPid);
      expect(await pool.releaseThreadConnection(target.threadId!, {canRelease: id=>id===target.threadId,eligibleThreadIds:[target.threadId!]}))
        .toMatchObject({phase:"unsubscribed"});
      const result = await pool.callTool("codex-reply", {threadId:protectedThread.threadId,prompt:"report ephemeral continuation"});
      expect(result.isError).not.toBe(true);
      expect(await pool.releaseThreadConnection(protectedThread.threadId!, {canRelease:()=>true,eligibleThreadIds:[protectedThread.threadId!]}))
        .toMatchObject({phase:"blocked",reason:"persistence-unknown"});
    } finally { await pool.close(); }
  });
  it("processes thread/closed without an active turn and never treats unsubscribe acknowledgement alone as unload", async () => {
    const pool = new CodexAppServerUpstreamPool(fixture,1,{environment:{...process.env,CODEX_TEST_UNSUBSCRIBE_UNLOAD:"1"}});
    try {
      const {threadId} = await start(pool);
      const result = await pool.releaseThreadConnection(threadId!, {canRelease:()=>true,eligibleThreadIds:[]});
      expect(result).toMatchObject({phase:"released",evidence:"thread-unloaded"});
      expect(await pool.listLoadedBackgroundTerminals(threadId!)).toBeNull();
      expect((await pool.probeThread(threadId!)).runtimeStatus).toBe("notLoaded");
      await expect(pool.listBackgroundTerminals(threadId!)).rejects.toThrow(/THREAD_RELEASED/);
      await expect(pool.callTool("codex-reply",{...args,threadId,prompt:"explicit return"})).resolves.toMatchObject({structuredContent:{threadId,turnStatus:"completed"}});
    } finally { await pool.close(); }
  });
  it("defers release for retained background work and rechecks the durable gate after inspection", async () => {
    const pool = new CodexAppServerUpstreamPool(fixture,1);
    try {
      const {threadId} = await start(pool,{prompt:"leave background terminal"});
      expect(await pool.releaseThreadConnection(threadId!, {canRelease:()=>true,eligibleThreadIds:[threadId!]}))
        .toMatchObject({phase:"blocked",reason:"background-work"});
      await pool.terminateBackgroundTerminal(threadId!,"background-process-1");
      let checks=0;
      expect(await pool.releaseThreadConnection(threadId!, {canRelease:()=>++checks===1,eligibleThreadIds:[threadId!]}))
        .toMatchObject({phase:"blocked",reason:"active-work"});
      expect((await pool.probeThread(threadId!)).runtimeStatus).toBe("idle");
    } finally { await pool.close(); }
  });
});
