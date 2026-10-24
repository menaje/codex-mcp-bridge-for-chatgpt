import { describe, expect, it } from "vitest";
import { issue242Fixture } from "../scripts/issue-242-fixture.js";
import { createIsolatedHttpServer } from "../src/runtimeProcess.js";

describe("issue 242 read transport", () => {
  it("forwards local deadlines and cancellation through supervisor IPC without cancelling work", async () => {
    const f = await issue242Fixture(0);
    f.store.close();
    let pid = 0;
    const server = await createIsolatedHttpServer(f.config, {
      childEnvironment: f.environment, onRuntimeProcessSpawn: value => { pid = value; }
    });
    let stopped = false;
    try {
      process.kill(pid, "SIGSTOP"); stopped = true;
      const cancel = new AbortController();
      const a = server.applicationService.dashboardSnapshot({}, { signal: cancel.signal });
      const aFailure = expect(a).rejects.toThrow("STATE_READ_CANCELLED");
      cancel.abort(); await aFailure;
      await expect(server.applicationService.dashboardSnapshot({}, { deadlineAt: Date.now() + 30 }))
        .rejects.toThrow("STATE_READ_STALE");
      process.kill(pid, "SIGCONT"); stopped = false;
      expect((await server.applicationService.dashboardSnapshot()).counts.retainedJobs).toBe(0);
      expect(server.applicationService.runtimeHealth?.().activeJobs).toBe(0);
    } finally {
      if (stopped) process.kill(pid, "SIGCONT");
      await new Promise<void>(resolve => server.close(() => resolve()));
      await f.close();
    }
  }, 20_000);
});
