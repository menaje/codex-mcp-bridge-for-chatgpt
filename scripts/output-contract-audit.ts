import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  APP_ONLY_OUTPUT_SCHEMAS,
  MODEL_PRIMARY_ANSWER_MAX_JSON_BYTES,
  MODEL_VISIBLE_OUTPUT_SCHEMAS,
  validateActivityBootstrapPrivateMetadata,
  validateActivityViewPrivateMetadata,
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
const baselinePath = path.join(
  repositoryRoot,
  "docs/audits/issue-36-output-contract-baseline.json"
);

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
const activityPrivateMetadata = readJson<{
  bootstrap: Record<string, unknown>;
  view: Record<string, unknown>;
}>(path.join(fixtureRoot, "activity-private-metadata.json"));
const validatedActivityBootstrap = validateActivityBootstrapPrivateMetadata(
  activityPrivateMetadata.bootstrap
);
const validatedActivityView = validateActivityViewPrivateMetadata(activityPrivateMetadata.view);

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
const untypedNumericModelSchemaLiterals = untypedNumericLiteralPointers(
  MODEL_VISIBLE_OUTPUT_SCHEMAS
);
const issueSchemaBaselineBytes = 20_128;
const finalGenerationTargetBytes = Math.ceil(issueSchemaBaselineBytes * 0.6);
const issue40SteeringSchemaBytes = modelVisibleSchemas.byTool.codex_steer || 0;
const preIssue40ModelVisibleSchemaBytes =
  modelVisibleSchemas.totalBytes - issue40SteeringSchemaBytes;
const issue40ExpandedTargetBytes =
  finalGenerationTargetBytes + issue40SteeringSchemaBytes;
const schemaReductionBytes = issueSchemaBaselineBytes - preIssue40ModelVisibleSchemaBytes;
const schemaReductionPercent = Number(
  ((schemaReductionBytes / issueSchemaBaselineBytes) * 100).toFixed(3)
);

const report = {
  auditVersion: 3,
  issue: 36,
  regressionIssue: 38,
  featureIssue: 40,
  basis: {
    commit: "8a2cf54",
    normativeClient: "ChatGPT",
    measurement: "Buffer.byteLength(JSON.stringify(value), 'utf8')",
    fixtureProfile: "bounded deterministic W0/W1/W2/W3 plus issue-38 answer-recovery fixtures",
    phasesIncluded: ["W0", "W1", "W2", "M1", "W3", "M2", "R38"],
    phasesDeferred: [],
    m1Evidence: {
      status: "passed",
      source: "authoritative real ChatGPT Work conversation",
      activityResourceUri: "ui://codex-mcp-bridge/activity/17c24231c553.html",
      generation11InitialHydration: true,
      generation11SnapshotRefresh: true,
      retainedGeneration10Resolved: true
    },
    m2Evidence: {
      status: "passed",
      source: "authoritative real ChatGPT Work conversation",
      currentActivityResourceUri: "ui://codex-mcp-bridge/activity/17c24231c553.html",
      foregroundResult: "ISSUE36_M2_OK",
      backgroundResult: "ISSUE36_BG_OK",
      settingsHydrated: true,
      generation11InitialHydration: true,
      generation11SnapshotRefresh: true,
      sameResponseSiblingWinner: true,
      nextResponseSupersession: true,
      retainedActivityResourceUri: "ui://codex-mcp-bridge/activity/b4725cb7de0b.html",
      retainedGeneration10Hydrated: true,
      retainedGeneration10SnapshotRefresh: true
    },
    issue38Evidence: {
      status: "fixture-passed-real-host-pending",
      source: "authenticated raw ChatGPT Work conversation response plus bridge SQLite",
      exactJobStatusCalled: true,
      bridgeRetainedPrimaryContent: true,
      chatGptToolMessageStructuredContent: true,
      chatGptToolMessagePrimaryContent: false,
      chatGptToolMessagePrivateMeta: false,
      foregroundStructuredAnswerFixture: "ISSUE38_FOREGROUND_SENTINEL",
      backgroundStructuredAnswerFixture: "ISSUE38_BACKGROUND_SENTINEL"
    },
    issue40Evidence: {
      status: "passed",
      source: "authenticated Codex App Server 0.145.0 through public Bridge tools",
      canaryRecord: "docs/audits/issue-40-app-server-canary.md",
      modelVisibleTool: "codex_steer",
      activeTurnOnly: true,
      activeSteerDelivered: true,
      staleVersionRejectedBeforeDispatch: true,
      terminalSteerRejectedWithoutNewTurn: true,
      exactReplayUpstreamCalls: 1,
      durableDispatchBoundary: true,
      hostDerivedScopeRegression: true,
      exactPromptEchoRedacted: true,
      rawPromptPersisted: false,
      distributedExactlyOnceClaimed: false
    }
  },
  issueBaseline: {
    modelVisibleSchemaBytes: issueSchemaBaselineBytes,
    byTool: {
      codex_activity: 6_720,
      codex_settings: 10_664,
      codex_task: 2_078,
      otherSixToolsEach: 111
    },
    representativeResultBytes: {
      codex_activity_one_activity: { structuredContent: 3_625, content: 1_666, total: 5_291 },
      codex_models_three_models: { structuredContent: 2_061, content: 3_143, total: 5_204 },
      codex_settings: { structuredContent: 5_805, content: 7_618, total: 13_423 },
      codex_status_empty_overview: { structuredContent: 4_077, content: 5_129, total: 9_206 },
      codex_task_foreground_completed: { structuredContent: 2_075, content: 28, total: 2_103 }
    }
  },
  current: {
    schemaBytes: {
      modelVisible: modelVisibleSchemas,
      appOnly: appOnlySchemas
    },
    resultBytes: {
      structuredContent: structuredResults,
      content: contentResults,
      privateMeta: {
        deterministicFixtures: {
          "codex/activityBootstrap@11": jsonBytes(validatedActivityBootstrap),
          "codex/activityView@11": jsonBytes(validatedActivityView)
        },
        realHostCapture: {
          measured: false,
          functionalEvidence: "M1 and M2 passed",
          reason: "Exact raw ChatGPT metadata bytes were not supplied; deterministic fixture bytes are reported without fabricating a host capture."
        }
      }
    },
    contentByteCaps: TOOL_CONTENT_BYTE_CAPS,
    structuredContentByteCaps: TOOL_STRUCTURED_BYTE_CAPS,
    modelPrimaryAnswerMaxJsonBytes: MODEL_PRIMARY_ANSWER_MAX_JSON_BYTES
  },
  finalGenerationBudget: {
    targetReductionPercent: 40,
    targetModelVisibleSchemaBytes: finalGenerationTargetBytes,
    preIssue40ModelVisibleSchemaBytes,
    issue40SteeringSchemaBytes,
    issue40ExpandedTargetBytes,
    actualModelVisibleSchemaBytes: modelVisibleSchemas.totalBytes,
    reductionBytes: schemaReductionBytes,
    reductionPercent: schemaReductionPercent,
    headroomBytes: issue40ExpandedTargetBytes - modelVisibleSchemas.totalBytes,
    enforcedAt: "W3+issue40-additive-tool",
    passed:
      preIssue40ModelVisibleSchemaBytes <= finalGenerationTargetBytes &&
      modelVisibleSchemas.totalBytes <= issue40ExpandedTargetBytes
  }
};

if (process.argv.includes("--check")) {
  assert.deepStrictEqual(
    untypedNumericModelSchemaLiterals,
    [],
    "Model-visible output schemas contain typeless numeric const/enum nodes that ChatGPT cannot expose reliably."
  );
  assert.ok(
    preIssue40ModelVisibleSchemaBytes <= finalGenerationTargetBytes &&
      modelVisibleSchemas.totalBytes <= issue40ExpandedTargetBytes,
    `Model-visible schema budget exceeded: base ${preIssue40ModelVisibleSchemaBytes} > ${finalGenerationTargetBytes} or total ${modelVisibleSchemas.totalBytes} > ${issue40ExpandedTargetBytes} bytes.`
  );
  const baseline = readJson<typeof report>(baselinePath);
  assert.deepStrictEqual(report, baseline, "Output contract audit differs from the checked-in baseline.");
  console.log(`Output contract audit matches ${path.relative(repositoryRoot, baselinePath)}.`);
} else if (process.argv.includes("--write")) {
  writeFileSync(baselinePath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Wrote ${path.relative(repositoryRoot, baselinePath)}.`);
} else {
  console.log(JSON.stringify(report, null, 2));
}
