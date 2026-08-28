import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ACTIVITY_BOOTSTRAP_PRIVATE_MAX_BYTES,
  ACTIVITY_VIEW_PRIVATE_MAX_BYTES,
  MODEL_VISIBLE_OUTPUT_SCHEMAS,
  validateActivityBootstrapPrivateMetadata,
  validateActivityViewPrivateMetadata,
  validateModelVisibleStructuredOutput,
  type ModelVisibleOutputToolName
} from "../src/tools.js";
import {
  TOOL_CONTENT_BYTE_CAPS,
  boundedUtf8JsonString,
  boundedUtf8Text,
  contentTextBytes,
  defineToolResultContract,
  projectToolResult
} from "../src/toolResultContracts.js";

type StructuredFixture = {
  fixture: string;
  structuredContent: Record<string, unknown>;
};

type ContentFixture = {
  fixture: string;
  tool: string;
  support: "documented-support-level" | "primary-payload";
  cap: number | "retained-result-limit";
  content: string;
};

const fixtureRoot = path.resolve("test/fixtures/output-contracts");

function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(fixtureRoot, name), "utf8")) as T;
}

const taskForms = readFixture<StructuredFixture[]>("task-forms.json");
const modelResults = readFixture<Record<ModelVisibleOutputToolName, StructuredFixture[]>>(
  "model-results.json"
);
const compatibilityFixtures = readFixture<ContentFixture[]>("content-only-compatibility.json");
const activityPrivateMetadata = readFixture<{
  bootstrap: Record<string, unknown>;
  view: Record<string, any>;
}>("activity-private-metadata.json");

describe("model-visible output contracts", () => {
  it("validates every documented task state, including replay and structured errors", () => {
    expect(taskForms.map(({ fixture }) => fixture)).toEqual([
      "setup",
      "replay",
      "running",
      "completed",
      "failed",
      "cancelled"
    ]);
    for (const fixture of taskForms) {
      expect(() =>
        validateModelVisibleStructuredOutput("codex_task", fixture.structuredContent)
      ).not.toThrow();
    }

    const failed = structuredClone(
      taskForms.find(({ fixture }) => fixture === "failed")!.structuredContent
    ) as Record<string, any>;
    failed.error.uncontracted = true;
    expect(() => validateModelVisibleStructuredOutput("codex_task", failed)).toThrow();
  });

  it("validates fixtures for every model-visible tool and rejects root expansion", () => {
    const expectedTools = Object.keys(MODEL_VISIBLE_OUTPUT_SCHEMAS).sort();
    expect(Object.keys(modelResults).sort()).toEqual(expectedTools);

    for (const toolName of expectedTools as ModelVisibleOutputToolName[]) {
      const fixtures = toolName === "codex_task" ? taskForms : modelResults[toolName];
      expect(fixtures.length, `${toolName} must have at least one contract fixture`).toBeGreaterThan(0);
      for (const fixture of fixtures) {
        expect(() =>
          validateModelVisibleStructuredOutput(toolName, fixture.structuredContent)
        ).not.toThrow();
      }
      expect(() =>
        validateModelVisibleStructuredOutput(toolName, {
          ...fixtures[0]!.structuredContent,
          uncontractedRootField: true
        })
      ).toThrow();
    }
  });

  it("emits closed JSON Schema envelopes without model-visible opaque leaves", () => {
    const opaqueLeaves: string[] = [];
    const violations: string[] = [];

    const visit = (value: unknown, pointer: string): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach((entry, index) => visit(entry, `${pointer}/${index}`));
        return;
      }
      const object = value as Record<string, unknown>;
      const describesObject = object.type === "object" ||
        object.properties !== undefined ||
        Object.prototype.hasOwnProperty.call(object, "additionalProperties");
      if (describesObject) {
        if (object.additionalProperties === false) {
          // Closed, projection-owned envelope.
        } else if (
          object.additionalProperties &&
          typeof object.additionalProperties === "object" &&
          !Array.isArray(object.additionalProperties) &&
          Object.keys(object.additionalProperties as Record<string, unknown>).length === 0 &&
          object.properties === undefined
        ) {
          opaqueLeaves.push(pointer);
        } else {
          violations.push(pointer);
        }
      }
      for (const [key, entry] of Object.entries(object)) visit(entry, `${pointer}/${key}`);
    };

    for (const [toolName, schema] of Object.entries(MODEL_VISIBLE_OUTPUT_SCHEMAS)) {
      const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
      expect(jsonSchema.additionalProperties, `${toolName} root must be closed`).toBe(false);
      visit(jsonSchema, toolName);
    }

    expect(violations).toEqual([]);
    expect(opaqueLeaves).toEqual([]);
  });

  it("keeps every primitive literal explicitly typed for ChatGPT tool-loader compatibility", () => {
    const untypedPrimitiveLiterals: string[] = [];
    const visit = (value: unknown, pointer: string): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach((entry, index) => visit(entry, `${pointer}/${index}`));
        return;
      }
      const object = value as Record<string, unknown>;
      const literals = Object.prototype.hasOwnProperty.call(object, "const")
        ? [object.const]
        : Array.isArray(object.enum)
          ? object.enum
          : [];
      for (const literal of literals) {
        const primitive = typeof literal;
        const types = Array.isArray(object.type) ? object.type : [object.type];
        const typed = primitive === "number"
          ? types.includes("number") || types.includes("integer")
          : primitive === "string" || primitive === "boolean"
            ? types.includes(primitive)
            : true;
        if (!typed) untypedPrimitiveLiterals.push(pointer);
      }
      for (const [key, entry] of Object.entries(object)) visit(entry, `${pointer}/${key}`);
    };

    for (const [toolName, schema] of Object.entries(MODEL_VISIBLE_OUTPUT_SCHEMAS)) {
      visit(z.toJSONSchema(schema), toolName);
    }
    expect(untypedPrimitiveLiterals).toEqual([]);
    expect(
      (z.toJSONSchema(MODEL_VISIBLE_OUTPUT_SCHEMAS.codex_task) as any)
        .properties.contractVersion
    ).toEqual({ type: "string", enum: ["1"] });
  });

  it("publishes codex_task as a strict all-required schema with nullable absence", () => {
    const schema = z.toJSONSchema(MODEL_VISIBLE_OUTPUT_SCHEMAS.codex_task) as any;
    expect(schema.required.sort()).toEqual(Object.keys(schema.properties).sort());
    expect(schema.properties.jobId.type).toEqual(["string", "null"]);
    expect(schema.properties.answer.type).toEqual(["string", "null"]);
    expect(schema.properties.error.type).toEqual(["object", "null"]);
    expect(schema.properties.error.required.sort())
      .toEqual(Object.keys(schema.properties.error.properties).sort());

    const missingDeliveredAnswer = structuredClone(
      taskForms.find(({ fixture }) => fixture === "completed")!.structuredContent
    );
    missingDeliveredAnswer.answer = null;
    expect(() => validateModelVisibleStructuredOutput("codex_task", missingDeliveredAnswer))
      .toThrow(/model-authoritative answer/);

    const unexpectedPendingAnswer = structuredClone(
      taskForms.find(({ fixture }) => fixture === "running")!.structuredContent
    );
    unexpectedPendingAnswer.answer = "not terminal";
    expect(() => validateModelVisibleStructuredOutput("codex_task", unexpectedPendingAnswer))
      .toThrow(/model-authoritative answer/);
  });

  it("enforces the final model-visible schema budget", () => {
    const bytes = Object.values(MODEL_VISIBLE_OUTPUT_SCHEMAS).reduce(
      (total, schema) => total + Buffer.byteLength(JSON.stringify(z.toJSONSchema(schema)), "utf8"),
      0
    );
    expect(bytes).toBe(12_009);
    expect(bytes).toBeLessThanOrEqual(12_077);
  });

  it("retires public Activity hydration while retaining private generation 11 contracts", () => {
    for (const fixture of taskForms) {
      expect(fixture.structuredContent).not.toHaveProperty("bridgeSession");
      expect(fixture.structuredContent).not.toHaveProperty("bridgeActivity");
      expect(fixture.structuredContent).not.toHaveProperty("activityTracking");
      expect(fixture.structuredContent).not.toHaveProperty("activityPresentationId");
      expect(fixture.structuredContent).toMatchObject({ rerouted: expect.any(Boolean) });
      expect(fixture.structuredContent).not.toHaveProperty("executionAudit");
      expect(fixture.structuredContent).not.toHaveProperty("source");
      expect(fixture.structuredContent).not.toHaveProperty("evidence");
      expect(fixture.structuredContent).not.toHaveProperty("result");
      const error = fixture.structuredContent.error as Record<string, unknown> | null;
      if (error) {
        expect(error).not.toHaveProperty("policyRevision");
        expect(error).not.toHaveProperty("nextActions");
      }
    }
    const activity = modelResults.codex_activity[0]!.structuredContent;
    for (const retiredLeaf of [
      "feed",
      "activities",
      "agents",
      "mountedActivity",
      "mountedPresentation",
      "watcherPolicy"
    ]) expect(activity).not.toHaveProperty(retiredLeaf);
  });

  it("keeps documented text compatibility bounded and explicitly incomplete", () => {
    expect(compatibilityFixtures.map(({ fixture }) => fixture)).toEqual([
      "task-completed-primary",
      "task-running",
      "task-structured-error",
      "status-running",
      "status-completed-primary",
      "cancel-success"
    ]);
    for (const fixture of compatibilityFixtures) {
      if (typeof fixture.cap === "number") {
        expect(Buffer.byteLength(fixture.content, "utf8"), fixture.fixture).toBeLessThanOrEqual(
          fixture.cap
        );
      }
    }
    expect(
      compatibilityFixtures.filter(({ support }) => support === "documented-support-level").length
    ).toBeGreaterThan(0);
  });

  it("keeps completed answers model-authoritative when ChatGPT retains only structuredContent", () => {
    const completed = taskForms.find(({ fixture }) => fixture === "completed")!.structuredContent;
    const primary = compatibilityFixtures.find(({ fixture }) => fixture === "task-completed-primary")!;
    const result = {
      structuredContent: completed,
      content: [{ type: "text" as const, text: primary.content }]
    };

    expect(completed).toMatchObject({
      delivery: "primary-content",
      resultAvailability: "delivered",
      resultOmitted: false,
      answer: primary.content
    });
    const chatGptStoredToolMessage = JSON.stringify(completed);
    expect(chatGptStoredToolMessage).toContain("ISSUE38_FOREGROUND_SENTINEL");
    expect(chatGptStoredToolMessage).toContain("## Files");
    expect(chatGptStoredToolMessage).toContain("## Tests");
    expect(completed.answer).toBe(primary.content);
    expect(result.content[0].text).toBe(primary.content);

    const completedStatus = modelResults.codex_status.find(
      ({ fixture }) => fixture === "completed-job"
    )!.structuredContent;
    expect(JSON.stringify(completedStatus)).toContain("ISSUE38_BACKGROUND_SENTINEL");
    expect((completedStatus.items as Array<Record<string, unknown>>)[0]).toMatchObject({
      result: { availability: "delivered", omitted: false },
      answer: expect.stringContaining("background report recovered")
    });
  });

  it("enforces the typed projection boundary before results cross MCP", () => {
    const schema = z.strictObject({ ok: z.literal(true), revision: z.number().int() });
    const contract = defineToolResultContract({
      toolName: "fixture_tool",
      channel: "model-orchestrator-semantic",
      outputSchema: schema,
      structured: { maxBytes: 128 },
      compatibility: {
        channel: "text-protocol-compatibility",
        format: "plain-text",
        maxBytes: 24,
        completeness: "summary-only"
      }
    });
    const result = projectToolResult(contract, {
      canonical: { private: true },
      authoritative: {
        channel: "model-orchestrator-semantic",
        value: { ok: true, revision: 2 }
      },
      compatibility: {
        channel: "text-protocol-compatibility",
        text: "상태 요약이 바이트 한도를 넘으면 잘립니다."
      }
    });

    expect(result.structuredContent).toEqual({ ok: true, revision: 2 });
    expect(contentTextBytes(result.content)).toBeLessThanOrEqual(24);
    expect(() => projectToolResult(contract, {
      canonical: {},
      authoritative: {
        channel: "model-orchestrator-semantic",
        value: { ok: true, revision: 2, unexpected: true }
      },
      compatibility: { channel: "text-protocol-compatibility", text: "invalid" }
    } as any)).toThrow(/output contract rejected/);
    expect(Buffer.byteLength(boundedUtf8Text("가".repeat(100), 32), "utf8")).toBeLessThanOrEqual(32);
    const escaped = boundedUtf8JsonString('"\\\n'.repeat(100), 64);
    expect(Buffer.byteLength(JSON.stringify(escaped), "utf8") - 2).toBeLessThanOrEqual(64);
    expect(escaped).toContain("truncated");
  });

  it("keeps compact Settings free of editor-only project identity and paths", () => {
    const settings = modelResults.codex_settings[0]!.structuredContent;
    const serialized = JSON.stringify(settings);
    expect(serialized).not.toContain("cwd");
    expect(serialized).not.toContain("projectId");
    expect(serialized).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
  });

  it("publishes the documented compatibility byte caps", () => {
    expect(TOOL_CONTENT_BYTE_CAPS).toMatchObject({
      codex_status: 1024,
      codex_settings: 768,
      codex_cancel: 768,
      codex_task_state: 1024,
      codex_task_error: 1536
    });
  });

  it("validates bounded generation 11 private Activity metadata exactly", () => {
    expect(validateActivityBootstrapPrivateMetadata(activityPrivateMetadata.bootstrap))
      .toEqual(activityPrivateMetadata.bootstrap);
    expect(validateActivityViewPrivateMetadata(activityPrivateMetadata.view))
      .toEqual(activityPrivateMetadata.view);
    expect(Buffer.byteLength(JSON.stringify(activityPrivateMetadata.bootstrap), "utf8"))
      .toBeLessThanOrEqual(ACTIVITY_BOOTSTRAP_PRIVATE_MAX_BYTES);
    expect(Buffer.byteLength(JSON.stringify(activityPrivateMetadata.view), "utf8"))
      .toBeLessThanOrEqual(ACTIVITY_VIEW_PRIVATE_MAX_BYTES);

    expect(() => validateActivityBootstrapPrivateMetadata({
      ...activityPrivateMetadata.bootstrap,
      version: 10
    })).toThrow();
    expect(() => validateActivityBootstrapPrivateMetadata({
      ...activityPrivateMetadata.bootstrap,
      authority: true
    })).toThrow();
    const mismatchedBootstrap = structuredClone(activityPrivateMetadata.bootstrap) as Record<string, any>;
    mismatchedBootstrap.presentation.reservationOwnerId = "another-job";
    expect(() => validateActivityBootstrapPrivateMetadata(mismatchedBootstrap))
      .toThrow(/correlated Job/);

    const mismatchedView = structuredClone(activityPrivateMetadata.view);
    mismatchedView.correlation.scopeVersion += 1;
    expect(() => validateActivityViewPrivateMetadata(mismatchedView))
      .toThrow(/scope versions/);

    const oversized = structuredClone(activityPrivateMetadata.view);
    oversized.view.feed = { padding: "x".repeat(ACTIVITY_VIEW_PRIVATE_MAX_BYTES) };
    expect(() => validateActivityViewPrivateMetadata(oversized)).toThrow(/above its/);
  });
});
