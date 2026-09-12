import { afterEach, describe, expect, it, vi } from "vitest";
import {
  callUiToolWithFallback,
  withUiToolCallTimeout
} from "../src/uiToolCallFallback.js";

describe("MCP Apps tool-call fallback", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const options = {
    standardTimeoutMs: 20,
    compatibilityTimeoutMs: 30,
    timeoutMessage: "tool call timed out"
  };

  it("uses the standard MCP Apps result without invoking the compatibility alias", async () => {
    const compatibility = vi.fn(async () => "compatibility");

    await expect(callUiToolWithFallback(
      async () => "standard",
      compatibility,
      options
    )).resolves.toBe("standard");
    expect(compatibility).not.toHaveBeenCalled();
  });

  it("falls back when the standard call rejects", async () => {
    const attempts: string[] = [];

    await expect(callUiToolWithFallback(
      async () => {
        attempts.push("standard");
        throw new Error("standard unavailable");
      },
      async () => {
        attempts.push("compatibility");
        return "recovered";
      },
      options
    )).resolves.toBe("recovered");
    expect(attempts).toEqual(["standard", "compatibility"]);
  });

  it("does not retry through the compatibility alias after a dispatched call times out", async () => {
    const compatibility = vi.fn(async () => "duplicate");
    const dispatchedTimeout = Object.assign(new Error("dispatched timeout"), {
      code: "MCP_TOOL_CALL_DISPATCH_TIMEOUT"
    });

    await expect(callUiToolWithFallback(
      async () => { throw dispatchedTimeout; },
      compatibility,
      {
        ...options,
        shouldFallback: (error) =>
          (error as { code?: string } | undefined)?.code !== "MCP_TOOL_CALL_DISPATCH_TIMEOUT"
      }
    )).rejects.toThrow("dispatched timeout");
    expect(compatibility).not.toHaveBeenCalled();
  });

  it("falls back after a standard thenable stops responding", async () => {
    vi.useFakeTimers();
    const promise = callUiToolWithFallback(
      () => new Promise<string>(() => undefined),
      async () => "recovered",
      options
    );

    await vi.advanceTimersByTimeAsync(options.standardTimeoutMs);
    await expect(promise).resolves.toBe("recovered");
  });

  it("bounds a compatibility alias that stops responding", async () => {
    vi.useFakeTimers();
    const promise = callUiToolWithFallback(
      async () => {
        throw new Error("standard unavailable");
      },
      () => new Promise<string>(() => undefined),
      options
    );
    const rejection = expect(promise).rejects.toThrow("tool call timed out");

    await vi.advanceTimersByTimeAsync(options.compatibilityTimeoutMs);
    await rejection;
  });

  it("preserves the standard error when no compatibility alias exists", async () => {
    await expect(callUiToolWithFallback(
      async () => {
        throw new Error("standard unavailable");
      },
      undefined,
      options
    )).rejects.toThrow("standard unavailable");
  });

  it("clears its timeout after a successful attempt", async () => {
    vi.useFakeTimers();
    await expect(withUiToolCallTimeout(
      async () => "done",
      10,
      "late timeout"
    )).resolves.toBe("done");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("serializes into a self-contained card without compiler runtime helpers", async () => {
    for (const helper of [withUiToolCallTimeout, callUiToolWithFallback]) {
      const source = helper.toString();
      expect(source).not.toContain("__name");
      expect(() => new Function(`return (${source})`)()).not.toThrow();
    }
    const recreated = new Function(
      `${withUiToolCallTimeout.toString()}; return (${callUiToolWithFallback.toString()});`
    )() as typeof callUiToolWithFallback;
    await expect(recreated(
      async () => {
        throw new Error("standard unavailable");
      },
      async () => "serialized fallback",
      options
    )).resolves.toBe("serialized fallback");
  });
});
