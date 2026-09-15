import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  APP_ONLY_OUTPUT_SCHEMAS,
  MODEL_PRIMARY_ANSWER_MAX_JSON_BYTES,
  MODEL_VISIBLE_OUTPUT_SCHEMA_BYTE_BUDGET,
  MODEL_VISIBLE_OUTPUT_SCHEMA_PER_TOOL_BYTE_BUDGET,
  MODEL_VISIBLE_OUTPUT_SCHEMAS,
  type ModelVisibleOutputToolName
} from "../src/tools.js";
import {
  TOOL_CONTENT_BYTE_CAPS,
  TOOL_STRUCTURED_BYTE_CAPS
} from "../src/toolResultContracts.js";

type StructuredFixture = {
  fixture: string;
  structuredContent: Record<string, unknown>;
};

type ContentFixture = {
  fixture: string;
  tool: string;
  support: string;
  cap: number | "retained-result-limit";
  content: string;
};

const repositoryRoot = process.cwd();
const fixtureRoot = path.join(repositoryRoot, "test/fixtures/output-contracts");

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function sortedEntries<T>(record: Record<string, T>): Array<[string, T]> {
  return Object.entries(record).sort(([left], [right]) => left.localeCompare(right));
}

function schemaAudit(schemas: Record<string, z.ZodType>) {
  const byTool = Object.fromEntries(
    sortedEntries(schemas).map(([toolName, schema]) => [
      toolName,
      jsonBytes(z.toJSONSchema(schema))
    ])
  );
  return {
    byTool,
    totalBytes: Object.values(byTool).reduce((total, bytes) => total + bytes, 0)
  };
}

function untypedNumericLiteralPointers(schemas: Record<string, z.ZodType>): string[] {
  const violations: string[] = [];
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
    if (
      literals.some((entry) => typeof entry === "number") &&
      object.type !== "number" &&
      object.type !== "integer"
    ) violations.push(pointer);
    for (const [key, entry] of Object.entries(object)) visit(entry, `${pointer}/${key}`);
  };
  for (const [toolName, schema] of sortedEntries(schemas)) {
    visit(z.toJSONSchema(schema), toolName);
  }
  return violations;
}

function fixtureAudit(fixtures: StructuredFixture[]) {
  const byFixture = Object.fromEntries(
    fixtures
      .map(({ fixture, structuredContent }) => [fixture, jsonBytes(structuredContent)] as const)
      .sort(([left], [right]) => left.localeCompare(right))
  );
  return {
    byFixture,
    maxBytes: Math.max(...Object.values(byFixture)),
    minBytes: Math.min(...Object.values(byFixture))
  };
}

const taskForms = readJson<StructuredFixture[]>(path.join(fixtureRoot, "task-forms.json"));
const modelResults = readJson<Record<ModelVisibleOutputToolName, StructuredFixture[]>>(
  path.join(fixtureRoot, "model-results.json")
);
const contentFixtures = readJson<ContentFixture[]>(
  path.join(fixtureRoot, "content-only-compatibility.json")
);
const structuredResults = Object.fromEntries(
  sortedEntries(modelResults).map(([toolName, fixtures]) => [
    toolName,
    fixtureAudit(toolName === "codex_task" ? taskForms : fixtures)
  ])
);
const contentResults = Object.fromEntries(
  contentFixtures
    .map((fixture) => [
      fixture.fixture,
      {
        tool: fixture.tool,
        support: fixture.support,
        cap: fixture.cap,
        bytes: Buffer.byteLength(fixture.content, "utf8")
      }
    ] as const)
    .sort(([left], [right]) => left.localeCompare(right))
);

const modelVisibleSchemas = schemaAudit(MODEL_VISIBLE_OUTPUT_SCHEMAS);
const appOnlySchemas = schemaAudit(APP_ONLY_OUTPUT_SCHEMAS);
const largestModelVisibleSchema = Object.entries(modelVisibleSchemas.byTool)
  .sort(([left], [right]) => left.localeCompare(right))
  .sort(([, left], [, right]) => right - left)[0];
assert.ok(largestModelVisibleSchema, "At least one model-visible output schema is required.");
// Input now shares codex_status with other reads. Ordinary Codex questions use
// the host conversation, so codex_answer is the only dedicated tool left.
const dedicatedQuestionTools = ["codex_answer"];
const dedicatedQuestionSchemaBytes = dedicatedQuestionTools.reduce((total, name) => {
  const bytes = modelVisibleSchemas.byTool[name];
  assert.ok(Number.isSafeInteger(bytes) && bytes > 0,
    `Missing current question output schema: ${name}.`);
  return total + bytes;
}, 0);
const untypedNumericModelSchemaLiterals = untypedNumericLiteralPointers(
  MODEL_VISIBLE_OUTPUT_SCHEMAS
);

const report = {
  auditVersion: 6,
  issue: 108,
  basis: {
    measurement: "Buffer.byteLength(JSON.stringify(value), 'utf8')",
    schemaInventory: {
      modelTools: Object.keys(MODEL_VISIBLE_OUTPUT_SCHEMAS).length,
      appTools: Object.keys(APP_ONLY_OUTPUT_SCHEMAS).length,
      scope: "Current exported output contracts only; retired Question and Activity card routes are absent."
    },
    inputProtocol: "Ordinary Codex questions use codex_status input queries and codex_answer."
  },
  current: {
    schemaBytes: {
      modelVisible: modelVisibleSchemas,
      appOnly: appOnlySchemas
    },
    resultBytes: {
      structuredContent: structuredResults,
      content: contentResults
    },
    contentByteCaps: TOOL_CONTENT_BYTE_CAPS,
    structuredContentByteCaps: TOOL_STRUCTURED_BYTE_CAPS,
    modelPrimaryAnswerMaxJsonBytes: MODEL_PRIMARY_ANSWER_MAX_JSON_BYTES
  },
  generationBudget: {
    targetModelVisibleSchemaBytes: MODEL_VISIBLE_OUTPUT_SCHEMA_BYTE_BUDGET,
    targetSingleModelVisibleSchemaBytes: MODEL_VISIBLE_OUTPUT_SCHEMA_PER_TOOL_BYTE_BUDGET,
    actualModelVisibleSchemaBytes: modelVisibleSchemas.totalBytes,
    largestModelVisibleSchemaTool: largestModelVisibleSchema[0],
    largestModelVisibleSchemaBytes: largestModelVisibleSchema[1],
    dedicatedQuestionTools,
    dedicatedQuestionToolsSchemaBytes: dedicatedQuestionSchemaBytes,
    sharedQuestionInputSchema: "codex_status",
    headroomBytes: MODEL_VISIBLE_OUTPUT_SCHEMA_BYTE_BUDGET - modelVisibleSchemas.totalBytes,
    singleSchemaHeadroomBytes:
      MODEL_VISIBLE_OUTPUT_SCHEMA_PER_TOOL_BYTE_BUDGET - largestModelVisibleSchema[1],
    enforcedAt: "mcp-2026-current-output-contracts",
    liveHostEvidenceProducedByThisAudit: false,
    separateLiveQuestionEvidence: "docs/audits/issue-70-unlocked-host.json",
    passed:
      modelVisibleSchemas.totalBytes <= MODEL_VISIBLE_OUTPUT_SCHEMA_BYTE_BUDGET &&
      largestModelVisibleSchema[1] <= MODEL_VISIBLE_OUTPUT_SCHEMA_PER_TOOL_BYTE_BUDGET
  }
};

if (process.argv.includes("--check")) {
  assert.deepStrictEqual(
    untypedNumericModelSchemaLiterals,
    [],
    "Model-visible output schemas contain typeless numeric const/enum nodes that ChatGPT cannot expose reliably."
  );
  assert.ok(
    modelVisibleSchemas.totalBytes <= MODEL_VISIBLE_OUTPUT_SCHEMA_BYTE_BUDGET,
    `Model-visible schema budget exceeded: ${modelVisibleSchemas.totalBytes} > ` +
      `${MODEL_VISIBLE_OUTPUT_SCHEMA_BYTE_BUDGET} bytes.`
  );
  assert.ok(
    largestModelVisibleSchema[1] <= MODEL_VISIBLE_OUTPUT_SCHEMA_PER_TOOL_BYTE_BUDGET,
    `Single model-visible schema budget exceeded: ${largestModelVisibleSchema[0]} ` +
      `${largestModelVisibleSchema[1]} > ${MODEL_VISIBLE_OUTPUT_SCHEMA_PER_TOOL_BYTE_BUDGET} bytes.`
  );
  const retired = [
    "codex_ask_user", "codex_user_answer", "codex_question_action", "codex_activity",
    "codex_activity_rehydrate", "codex_activity_snapshot", "codex_activity_handoff",
    "codex_activity_job_cancel", "codex_background_process_terminate", "codex_job_steer",
    "codex_ui_history"
  ];
  assert.deepStrictEqual(
    retired.filter(name => name in MODEL_VISIBLE_OUTPUT_SCHEMAS || name in APP_ONLY_OUTPUT_SCHEMAS),
    [],
    "Retired Question or Activity routes still export an output contract."
  );
  console.log("Current output contracts satisfy the #108 inventory and schema budget.");
} else {
  console.log(JSON.stringify(report, null, 2));
}
