import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { terminateManagedChildren } from "../scripts/child-shutdown.mjs";

describe("managed child shutdown", () => {
  it("waits for a graceful child exit", async () => {
    const child = new FakeChild("SIGINT");
    const result = await terminateManagedChildren(new Set([child]), {
      interruptTimeoutMs: 100,
      terminateTimeoutMs: 100,
      killTimeoutMs: 100
    });
    expect(result.exited).toBe(true);
    expect(child.signals).toEqual(["SIGINT"]);
  });

  it("escalates and still observes exit before completion", async () => {
    const child = new FakeChild("SIGKILL");
    const result = await terminateManagedChildren(new Set([child]), {
      interruptTimeoutMs: 5,
      terminateTimeoutMs: 5,
      killTimeoutMs: 100
    });
    expect(result.exited).toBe(true);
    expect(child.signals).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
    expect(child.exitCode).toBe(0);
  });
});

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: string | null = null;
  signals: string[] = [];

  constructor(private readonly exitOn: string) {
    super();
  }

  kill(signal: string): boolean {
    this.signals.push(signal);
    if (signal === this.exitOn) {
      setTimeout(() => {
        this.exitCode = 0;
        this.signalCode = signal;
        this.emit("exit", 0, signal);
      }, 1);
    }
    return true;
  }
}
