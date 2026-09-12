import { describe, expect, it } from "vitest";
import {
  CANCELLATION_SOURCES,
  JOB_TERMINAL_ORIGINS
} from "../src/cancellation.js";

describe("cancellation taxonomy", () => {
  it("keeps cancellation authority separate from transport observations and terminal origins", () => {
    expect(CANCELLATION_SOURCES).toEqual([
      "model-tool",
      "widget-control",
      "activity-cascade",
      "operator",
      "assignment-containment"
    ]);
    expect(CANCELLATION_SOURCES).not.toContain("host-abort");
    expect(CANCELLATION_SOURCES).not.toContain("restart");
    expect(CANCELLATION_SOURCES).not.toContain("unknown");

    expect(JOB_TERMINAL_ORIGINS).toContain("bridge-restart");
    expect(JOB_TERMINAL_ORIGINS).toContain("legacy-unattributed-cancellation");
    expect(JOB_TERMINAL_ORIGINS).not.toContain("unknown");
  });
});
