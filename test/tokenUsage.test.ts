import { describe, expect, it } from "vitest";
import { TurnUsageMeter } from "../src/tokenUsage.js";
const counts = (input: number, cached: number, output: number) => ({ inputTokens:input,cachedInputTokens:cached,outputTokens:output,totalTokens:input+output,reasoningOutputTokens:0 });
describe("per-turn token accounting", () => {
  it("subtracts the start baseline across multiple API requests and duplicate updates", () => {
    const meter = new TurnUsageMeter(counts(1000,800,100));
    expect(meter.observe(counts(2200,1800,200)).tokens).toMatchObject(counts(1200,1000,100));
    expect(meter.observe(counts(2200,1800,200)).tokens).toMatchObject(counts(1200,1000,100));
    expect(meter.observe(counts(4000,3300,400)).tokens).toMatchObject(counts(3000,2500,300));
  });
  it("marks reset, compaction and absent start counters unknown instead of charging thread totals again", () => {
    const meter = new TurnUsageMeter(counts(1000,800,100));
    expect(meter.observe(counts(100,0,5))).toEqual({basis:"unknown",reason:"counter-reset"});
    expect(meter.observe(counts(3000,1000,500)).basis).toBe("unknown");
    expect(new TurnUsageMeter().observe(counts(3000,1000,500))).toEqual({basis:"unknown",reason:"missing-start-counter"});
  });
});
