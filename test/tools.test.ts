import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { loadConfig } from "../src/config.js";
import type { CodexModelCatalogProvider, CodexModelCatalogSnapshot } from "../src/modelCatalog.js";
import { createHttpServer, type BridgeHttpServer } from "../src/server.js";
import { BRIDGE_SKILL_LIMITS } from "../src/skillLibrary.js";
import { BridgeStateStore } from "../src/stateStore.js";
import { DASHBOARD_CARD_URI } from "../src/dashboardCard.js";
import {
  DECISION_CARD_METADATA_KEY,
  DECISION_CARD_MINIMAL_HTML_EXAMPLE,
  DECISION_CARD_URI
} from "../src/decisionCard.js";
import type {
  CodexInteractionResponse,
  CodexPendingInteraction,
  CodexProgress,
  CodexUpstream,
  ToolResult,
  UpstreamWorkerAssignment
} from "../src/upstream.js";
import { UserSettingsStore } from "../src/userSettings.js";

const selection = { model: "gpt-5.6-sol", reasoningEffort: "medium" };
const metadata = { "openai/session": "current-tool-contract-test" };
const fixtureThreadId = "99999999-9999-4999-8999-999999999999";
const fixtureTurnId = "fixture-turn";

type HeldFixtureCall = {
  started: () => void;
  result: Promise<ToolResult>;
  release: (result: ToolResult) => void;
  onProgress?: (progress: CodexProgress) => void;
  onAssigned?: (assignment: UpstreamWorkerAssignment) => void;
};

class FixtureUpstream implements CodexUpstream {
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  readonly interactionResponses: Array<{ interactionId: string; response: CodexInteractionResponse }> = [];
  private heldCall?: HeldFixtureCall;

  async listTools(): Promise<unknown> {
    return { tools: [{ name: "codex" }] };
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult> {
    this.calls.push({ name, args });
    const held = this.heldCall;
    if (held) {
      this.heldCall = undefined;
      held.onProgress = onProgress;
      held.onAssigned = onAssigned;
      held.started();
      return held.result;
    }
    return {
      structuredContent: { threadId: fixtureThreadId, content: "Completed fixture work." },
      content: [{ type: "text", text: "Completed fixture work." }]
    };
  }

  holdNextCall(): {
    started: Promise<void>;
    assign(threadId: string, upstreamRequestId?: string): void;
    progress(progress: CodexProgress): void;
    release(): void;
  } {
    let started!: () => void;
    let release!: (result: ToolResult) => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const result = new Promise<ToolResult>((resolve) => { release = resolve; });
    const heldCall: HeldFixtureCall = { started, result, release };
    this.heldCall = heldCall;
    return {
      started: startedPromise,
      assign: (threadId, upstreamRequestId = fixtureTurnId) => {
        if (!heldCall.onAssigned) {
          throw new Error("The held upstream call has not registered its assignment callback.");
        }
        heldCall.onAssigned({
          backendKind: "app-server",
          workerId: "fixture-worker",
          workerGeneration: 1,
          threadId,
          upstreamRequestId
        });
      },
      progress: (progress) => {
        if (!heldCall.onProgress) {
          throw new Error("The held upstream call has not registered its progress callback.");
        }
        heldCall.onProgress(progress);
      },
      release: () => release({
        structuredContent: { threadId: "tool-contract-thread", content: "Completed delayed fixture work." },
        content: [{ type: "text", text: "Completed delayed fixture work." }]
      })
    };
  }

  async respondToInteraction(interactionId: string, response: CodexInteractionResponse): Promise<void> {
    this.interactionResponses.push({ interactionId, response });
  }

  async close(): Promise<void> {}
}

class FixtureCatalog implements CodexModelCatalogProvider {
  private readonly snapshot: CodexModelCatalogSnapshot = {
    source: "codex-cli",
    fetchedAt: "2026-09-14T00:00:00.000Z",
    validatedAt: "2026-09-14T00:00:00.000Z",
    fingerprint: "f".repeat(64),
    cached: true,
    stale: false,
    validation: "valid",
    models: [{
      id: selection.model,
      displayName: "Fixture Sol",
      defaultReasoningEffort: selection.reasoningEffort,
      supportedReasoningEfforts: [{ effort: selection.reasoningEffort }],
      isDefault: true,
      defaultServiceTier: undefined,
      serviceTiers: [],
      inputModalities: ["text"]
    }]
  };

  async getCatalog(): Promise<CodexModelCatalogSnapshot> {
    return this.snapshot;
  }

  getCachedCatalog(): CodexModelCatalogSnapshot {
    return this.snapshot;
  }
}

describe("current bridge tool contracts", () => {
  let root: string;
  let state: BridgeStateStore;
  let settings: UserSettingsStore;
  let config: ReturnType<typeof loadConfig>;
  let client: Client;
  let server: BridgeHttpServer;
  let upstream: FixtureUpstream;
  let endpoint: URL;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "current-tools-"));
    state = new BridgeStateStore({ file: path.join(root, "state.sqlite") });
    config = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ROOTS: root,
      CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: path.join(root, "state.sqlite"),
      CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE: path.join(root, "models.json")
    });
    settings = new UserSettingsStore(config, { stateStore: state });
    settings.update({
      modelPolicy: {
        mode: "automatic",
        constraints: { allowDelegation: false },
        allowedSelections: { kind: "explicit", selections: [selection] }
      }
    }, settings.current.revision);
    settings.updateWithProjectOperations(
      {},
      [{ kind: "add", project: { name: "Fixture", cwd: root } }],
      undefined,
      settings.current.registryRevision
    );
    upstream = new FixtureUpstream();
    server = createHttpServer(
      config,
      upstream,
      new FixtureCatalog(),
      { stateStore: state }
    );
    client = new Client(
      { name: "current-tool-contract-test", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } }
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    endpoint = new URL(`http://127.0.0.1:${port}/mcp`);
    await client.connect(new StreamableHTTPClientTransport(endpoint));
  });

  afterEach(async () => {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    state.close();
    await rm(root, { recursive: true, force: true });
  });

  it("publishes one current tool surface without compatibility tiers", async () => {
    const tools = await client.listTools();
    const names = new Set(tools.tools.map((tool) => tool.name));
    for (const current of ["codex_task", "codex_cancel", "codex_models", "codex_settings", "codex_dashboard", "codex_decision", "codex_decision_result", "codex_ui_decision", "codex_ui_read", "bridge_skill", "bridge_skill_manage"]) {
      expect(names.has(current)).toBe(true);
    }
    for (const retired of [
      "codex_skill",
      "codex_skill_manage",
      "codex_dashboard_snapshot",
      "codex_settings_snapshot",
      "codex_question_card",
      "codex_question_submit",
      "codex_question_notify",
      "codex_ui_stop"
    ]) expect(names.has(retired)).toBe(false);
    const bridgeSkill = tools.tools.find((tool) => tool.name === "bridge_skill")!;
    const bridgeSkillManage = tools.tools.find((tool) => tool.name === "bridge_skill_manage")!;
    const status = tools.tools.find((tool) => tool.name === "codex_status")!;
    expect(JSON.stringify(bridgeSkill.inputSchema)).not.toContain('"project"');
    expect(JSON.stringify(bridgeSkillManage.inputSchema)).toContain('"content"');
    expect(JSON.stringify(bridgeSkillManage.inputSchema)).not.toContain('"document"');
    expect(JSON.stringify(status.inputSchema)).toContain("defaults to 20000 milliseconds");
    expect(status.description).toContain("terminal wait wakes only for terminal lifecycle state");
    expect(status.description).toContain("do not keep a parallel terminal wait");
    expect(tools.tools.some((tool) => "codex/registrationTier" in (tool._meta || {}))).toBe(false);
  });

  it("publishes a compact, complete decision-card authoring contract in MCP discovery", async () => {
    const tools = await client.listTools();
    const decision = tools.tools.find((tool) => tool.name === "codex_decision")!;
    const discovery = JSON.stringify({ description: decision.description, inputSchema: decision.inputSchema });

    for (const guidance of [
      "operation", "native input", "stable name", "visible label", "data-decision-label",
      "data-decision-unit", "data-decision-output-for", "required", "Static inline SVG",
      "scripts", "remote resources", "96", "64", "100"
    ]) expect(discovery).toContain(guidance);
    expect(decision.description).toContain(DECISION_CARD_MINIMAL_HTML_EXAMPLE);
    expect(Buffer.byteLength(discovery, "utf8")).toBeLessThan(12_000);
    expect(decision.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    });
    expect(tools.tools.some((tool) => tool.name === "codex_decision_guide")).toBe(false);

    const branches = (decision.inputSchema as any).oneOf as Array<{ required?: string[] }>;
    expect(branches).toHaveLength(2);
    expect(branches.every((branch) => branch.required?.includes("operation"))).toBe(true);
  });

  it("returns an actionable authoring error and accepts a corrected retry without Codex work", async () => {
    const requestId = randomUUID();
    const invalid = await client.callTool({
      name: "codex_decision",
      arguments: {
        operation: "create",
        requestId,
        title: "Choose a rollout",
        html: '<input type="radio" name="plan" value="staged">'
      },
      _meta: metadata
    });
    expect(invalid.isError).toBe(true);
    expect(JSON.stringify(invalid)).toMatch(
      /DECISION_FIELD_LABEL_REQUIRED: plan\..*(wrapping <label>|label for|data-decision-label)/
    );

    const corrected = await client.callTool({
      name: "codex_decision",
      arguments: {
        operation: "create",
        requestId,
        title: "Choose a rollout",
        html: `
          <fieldset><legend>Rollout plan</legend>
            <label><input type="radio" name="plan" value="staged" required>Staged rollout</label>
            <label><input type="radio" name="plan" value="direct">Direct rollout</label>
          </fieldset>
        `
      },
      _meta: metadata
    });
    expect(corrected.isError, JSON.stringify(corrected)).not.toBe(true);
    expect(corrected.structuredContent).toMatchObject({ kind: "decision-card", fieldCount: 1 });
    expect(upstream.calls).toEqual([]);
    expect(state.listJobs()).toEqual([]);
    expect(state.listActivities()).toEqual([]);
  });

  it("runs a Job-independent decision card through durable submission and same-conversation retrieval", async () => {
    const opened = await client.callTool({
      name: "codex_decision",
      arguments: {
        operation: "create",
        requestId: randomUUID(),
        title: "Choose the migration path",
        html: `
          <section><h2>Options</h2><table><tr><th>Path</th><th>Risk</th></tr><tr><td>Staged</td><td>Low</td></tr></table>
          <label>Path <select name="path" required><option value="staged">Staged transition</option><option value="rewrite">Immediate rewrite</option></select></label>
          <label>Condition <textarea name="condition"></textarea></label></section>
        `
      },
      _meta: metadata
    });
    expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
    expect(opened.structuredContent).toMatchObject({
      kind: "decision-card",
      operation: "create",
      state: "open",
      fieldCount: 2
    });
    const hydration = (opened._meta as any)[DECISION_CARD_METADATA_KEY];
    expect(hydration).toMatchObject({
      kind: "codex/decisionCard",
      card: {
        html: expect.stringContaining("<table>"),
        policy: { scripts: "blocked", externalNetwork: "blocked" }
      }
    });
    expect(JSON.stringify(opened.structuredContent)).not.toContain("<table>");
    expect((await client.listResources()).resources.map((resource) => resource.uri)).toContain(DECISION_CARD_URI);
    expect(state.listJobs()).toEqual([]);
    expect(state.listActivities()).toEqual([]);

    const widgetInstanceId = randomUUID();
    const identity = {
      cardId: hydration.card.cardId,
      cardVersion: hydration.card.cardVersion,
      presentationRef: hydration.card.presentationRef,
      widgetInstanceId
    };
    const submitted = await client.callTool({
      name: "codex_ui_decision",
      arguments: {
        operation: "submit",
        ...identity,
        submissionId: randomUUID(),
        intent: "confirm",
        fields: [
          { name: "path", values: ["staged"] },
          { name: "condition", values: ["Keep the existing API during rollout."] }
        ],
        comment: "Stop if error rate rises."
      },
      _meta: metadata
    });
    expect(submitted.isError, JSON.stringify(submitted)).not.toBe(true);
    expect(submitted.structuredContent).toMatchObject({
      kind: "decision-ui",
      operation: "submit",
      deliveryState: "stored",
      send: false,
      submission: {
        summary: expect.stringContaining("Path: Staged transition"),
        attemptCount: 0
      }
    });
    const receipt = (submitted.structuredContent as any).receipt;
    const claimed = await client.callTool({
      name: "codex_ui_decision",
      arguments: { operation: "claim", ...identity, receipt },
      _meta: metadata
    });
    expect(claimed.structuredContent).toMatchObject({
      deliveryState: "leased",
      send: true,
      submission: { attemptCount: 1 }
    });
    const accepted = await client.callTool({
      name: "codex_ui_decision",
      arguments: { operation: "outcome", ...identity, receipt, outcome: "accepted" },
      _meta: metadata
    });
    expect(accepted.structuredContent).toMatchObject({ deliveryState: "host-accepted" });

    const foreign = await client.callTool({
      name: "codex_decision_result",
      arguments: { receipt },
      _meta: { "openai/session": "foreign-decision-tool-contract-test" }
    });
    expect(foreign.isError).toBe(true);

    const result = await client.callTool({
      name: "codex_decision_result",
      arguments: { receipt },
      _meta: metadata
    });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      kind: "decision-result",
      card: { title: "Choose the migration path" },
      submission: {
        intent: "confirm",
        deliveryState: "host-accepted",
        resultOfferedAt: expect.any(String),
        selections: [
          expect.objectContaining({ label: "Path", values: [{ value: "staged", label: "Staged transition" }] }),
          expect.objectContaining({ label: "Condition", values: [{ value: "Keep the existing API during rollout.", label: "Keep the existing API during rollout." }] })
        ]
      },
      authority: { executionApproved: false }
    });
    expect((result.content[0] as any).text).toContain("Stop if error rate rises.");
    expect(state.listJobs()).toEqual([]);
  });

  it("keeps a card decision separate from a live Codex question, execution policy, and answer dispatch", async () => {
    const descriptor = (await client.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    const properties = descriptor.inputSchema.properties as Record<string, { const?: string }>;
    const project = settings.current.projects[0]!;
    const hold = upstream.holdNextCall();
    const task = await client.callTool({
      name: "codex_task",
      arguments: {
        requestId: randomUUID(),
        taskContractVersion: properties.taskContractVersion?.const,
        executionEnvelopeRef: properties.executionEnvelopeRef?.const,
        prompt: "Ask which rollout should be documented, then wait for the exact answer without changing files.",
        project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision },
        selection
      },
      _meta: metadata
    });
    expect(task.isError, JSON.stringify(task)).not.toBe(true);
    const jobId = (task.structuredContent as { jobId: string }).jobId;
    await hold.started;
    hold.assign(fixtureThreadId, fixtureTurnId);
    await eventually(() => state.listJobs().some((job) =>
      job.jobId === jobId && job.threadId === fixtureThreadId && job.upstreamRequestId === fixtureTurnId
    ));

    const question: CodexPendingInteraction = {
      interactionId: "rollout-question",
      kind: "user-input",
      origin: "codex-question",
      isBlocking: true,
      threadId: fixtureThreadId,
      turnId: fixtureTurnId,
      itemId: "rollout-question-item",
      summary: "Choose the rollout to document",
      questions: [{
        id: "rollout",
        header: "Rollout",
        question: "Which rollout should be documented?",
        isSecret: false,
        isOther: false,
        options: [
          { label: "Staged rollout", description: "Document a reversible staged rollout." },
          { label: "Direct rollout", description: "Document one immediate transition." }
        ]
      }]
    };
    hold.progress({
      progress: 1,
      event: {
        eventId: "rollout-question",
        type: "input-required",
        phase: "updated",
        createdAt: Date.now(),
        summary: question.summary,
        details: { interaction: question }
      }
    });
    await eventually(() => state.listJobs().some((job) =>
      job.jobId === jobId && job.pendingInteractions.some((input) => input.interactionId === question.interactionId)
    ));

    const beforeInput = await client.callTool({
      name: "codex_status",
      arguments: { query: { kind: "input", jobId } },
      _meta: metadata
    });
    expect(beforeInput.isError, JSON.stringify(beforeInput)).not.toBe(true);
    const inputSnapshot = beforeInput.structuredContent as any;
    expect(inputSnapshot).toMatchObject({
      kind: "codex-input",
      active: true,
      questions: [{
        questionRef: expect.stringMatching(/^[a-f0-9]{64}$/),
        questions: [{ id: "rollout", options: [{ label: "Staged rollout" }, { label: "Direct rollout" }] }]
      }],
      approvals: []
    });
    const questionRef = inputSnapshot.questions[0].questionRef as string;
    const jobBeforeCard = state.listJobs().find((job) => job.jobId === jobId)!;
    const activityCount = state.listActivities(jobBeforeCard.scopeId).length;
    const agentCount = state.listAgents(jobBeforeCard.scopeId).length;
    const jobCount = state.listJobs().filter((job) => job.scopeId === jobBeforeCard.scopeId).length;
    const accessStrategy = settings.current.accessStrategy;
    const executionDecision = structuredClone(jobBeforeCard.executionDecision);
    expect(jobBeforeCard).toMatchObject({ status: "running", trackingState: "connected", sandbox: "read-only" });
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]!.args).toMatchObject({ sandbox: "read-only", "approval-policy": "on-request" });

    const opened = await client.callTool({
      name: "codex_decision",
      arguments: {
        operation: "create",
        requestId: randomUUID(),
        title: "Choose the rollout to document",
        html: `
          <fieldset><legend>Rollout</legend>
            <label><input type="radio" name="rollout" value="staged" required>Staged rollout</label>
            <label><input type="radio" name="rollout" value="direct">Direct rollout</label>
          </fieldset>
          <label>Documentation condition <textarea name="condition"></textarea></label>
        `
      },
      _meta: metadata
    });
    expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
    const hydration = (opened._meta as any)[DECISION_CARD_METADATA_KEY];
    const identity = {
      cardId: hydration.card.cardId,
      cardVersion: hydration.card.cardVersion,
      presentationRef: hydration.card.presentationRef,
      widgetInstanceId: randomUUID()
    };
    const submitted = await client.callTool({
      name: "codex_ui_decision",
      arguments: {
        operation: "submit",
        ...identity,
        submissionId: randomUUID(),
        intent: "confirm",
        fields: [
          { name: "rollout", values: ["staged"] },
          { name: "condition", values: ["Documentation only; do not change files."] }
        ]
      },
      _meta: metadata
    });
    const receipt = (submitted.structuredContent as any).receipt as string;
    await client.callTool({
      name: "codex_ui_decision",
      arguments: { operation: "claim", ...identity, receipt },
      _meta: metadata
    });
    await client.callTool({
      name: "codex_ui_decision",
      arguments: { operation: "outcome", ...identity, receipt, outcome: "accepted" },
      _meta: metadata
    });
    const decision = await client.callTool({
      name: "codex_decision_result",
      arguments: { receipt },
      _meta: metadata
    });
    expect(decision.isError, JSON.stringify(decision)).not.toBe(true);
    expect(decision.structuredContent).toMatchObject({
      submission: {
        selections: [
          expect.objectContaining({ label: "Rollout", values: [{ value: "staged", label: "Staged rollout" }] }),
          expect.objectContaining({ label: "Documentation condition", values: [{ value: "Documentation only; do not change files.", label: "Documentation only; do not change files." }] })
        ]
      },
      authority: { scope: "same-conversation", executionApproved: false }
    });

    const afterInput = await client.callTool({
      name: "codex_status",
      arguments: { query: { kind: "input", jobId, afterCursor: inputSnapshot.cursor, waitMs: 0 } },
      _meta: metadata
    });
    expect(afterInput.structuredContent).toMatchObject({
      kind: "codex-input",
      changed: false,
      active: true,
      questions: [{ questionRef }],
      approvals: []
    });
    const jobAfterCard = state.listJobs().find((job) => job.jobId === jobId)!;
    expect(jobAfterCard.pendingInteractions).toEqual([question]);
    expect(jobAfterCard.sandbox).toBe(jobBeforeCard.sandbox);
    expect(jobAfterCard.executionDecision).toEqual(executionDecision);
    expect(settings.current.accessStrategy).toBe(accessStrategy);
    expect(state.listActivities(jobBeforeCard.scopeId)).toHaveLength(activityCount);
    expect(state.listAgents(jobBeforeCard.scopeId)).toHaveLength(agentCount);
    expect(state.listJobs().filter((job) => job.scopeId === jobBeforeCard.scopeId)).toHaveLength(jobCount);
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.interactionResponses).toEqual([]);

    const answered = await client.callTool({
      name: "codex_answer",
      arguments: {
        requestId: randomUUID(),
        jobId,
        questionRef,
        answers: { rollout: ["Staged rollout"] }
      },
      _meta: metadata
    });
    expect(answered.isError, JSON.stringify(answered)).not.toBe(true);
    expect(answered.structuredContent).toMatchObject({
      kind: "codex-answer",
      jobId,
      questionRef,
      delivery: "delivered",
      answersPersisted: false
    });
    expect(upstream.interactionResponses).toEqual([{
      interactionId: question.interactionId,
      response: { answers: { rollout: ["Staged rollout"] } }
    }]);
    expect(state.listJobs().find((job) => job.jobId === jobId)?.pendingInteractions).toEqual([]);
    expect(upstream.calls).toHaveLength(1);

    hold.release();
    await eventually(() => state.listJobs().some((job) => job.jobId === jobId && job.status === "completed"));
  });

  it("lets GPT search, read, and version Bridge Markdown skills without starting Codex", async () => {
    const originalContent = "# Evidence review\n\n| Claim | Evidence | Risk |\n| --- | --- | --- |";
    const created = await client.callTool({
      name: "bridge_skill_manage",
      arguments: {
        operation: "create",
        requestId: randomUUID(),
        name: "Evidence review",
        description: "Review reports with an evidence table.",
        content: originalContent,
        files: [{ path: "references/policy.md", content: "# Policy\n\nKeep the immutable evidence chain." }]
      }
    });
    expect(created.isError, JSON.stringify(created)).not.toBe(true);
    const createdSkill = (created.structuredContent as any).skill;
    const createdReference = { skillId: createdSkill.skillId, source: createdSkill.source, version: createdSkill.version };

    const found = await client.callTool({ name: "bridge_skill", arguments: { operation: "search", query: "evidence report" } });
    expect(found.isError, JSON.stringify(found)).not.toBe(true);
    const candidates = (found.structuredContent as any).skills;
    expect(candidates).toEqual([expect.objectContaining({ skillId: createdSkill.skillId, source: "bridge", version: "1" })]);

    const read = await client.callTool({ name: "bridge_skill", arguments: { operation: "read", skill: createdReference } });
    expect(read.isError, JSON.stringify(read)).not.toBe(true);
    expect(read.structuredContent).toMatchObject({
      kind: "skill",
      skill: {
        name: "Evidence review",
        content: originalContent,
        format: "markdown",
        legacy: false,
        sourceSnapshot: "versioned-bridge-record",
        files: [expect.objectContaining({ path: "references/policy.md", format: "markdown" })]
      }
    });
    expect(JSON.parse((read.content[0] as any).text)).toEqual(read.structuredContent);

    const fileRead = await client.callTool({
      name: "bridge_skill",
      arguments: { operation: "read-file", skill: createdReference, path: "references/policy.md" }
    });
    expect(fileRead.isError, JSON.stringify(fileRead)).not.toBe(true);
    expect(fileRead.structuredContent).toMatchObject({
      kind: "skill-file",
      path: "references/policy.md",
      content: expect.stringContaining("immutable evidence chain"),
      format: "markdown"
    });
    expect(JSON.parse((fileRead.content[0] as any).text)).toEqual(fileRead.structuredContent);

    const oldReferenceOperation = await client.callTool({
      name: "bridge_skill", arguments: { operation: "reference", skill: createdReference, referenceId: "unused" }
    });
    expect(oldReferenceOperation.isError).toBe(true);

    const updated = await client.callTool({
      name: "bridge_skill_manage",
      arguments: {
        operation: "update", requestId: randomUUID(), skillId: createdSkill.skillId,
        expectedVersion: createdSkill.version, content: "# Evidence review\n\nUpdated Markdown body.",
        files: {
          remove: ["references/policy.md"],
          upsert: [{ path: "references/current.md", content: "# Current policy" }]
        }
      }
    });
    expect(updated.isError, JSON.stringify(updated)).not.toBe(true);
    const updatedSkill = (updated.structuredContent as any).skill;
    expect(updatedSkill.version).toBe("2");

    const versions = await client.callTool({ name: "bridge_skill", arguments: { operation: "versions", skillId: createdSkill.skillId } });
    expect(versions.structuredContent).toMatchObject({ kind: "skill-versions", currentVersion: "2" });
    expect((versions.structuredContent as any).versions).toEqual(expect.arrayContaining([
      expect.objectContaining({ version: "2", format: "markdown", legacy: false }),
      expect.objectContaining({ version: "1", format: "markdown", legacy: false })
    ]));

    const archived = await client.callTool({
      name: "bridge_skill_manage",
      arguments: { operation: "set-enabled", requestId: randomUUID(), skillId: createdSkill.skillId, expectedVersion: updatedSkill.version, enabled: false }
    });
    expect((archived.structuredContent as any).skill).toMatchObject({ enabled: false, availability: "disabled" });
    const historical = await client.callTool({ name: "bridge_skill", arguments: { operation: "read", skill: createdReference } });
    expect(historical.structuredContent).toMatchObject({ skill: { content: originalContent } });
    expect(upstream.calls).toEqual([]);
  });

  it("uses Unicode-scalar name limits and exact opaque Bridge references", async () => {
    const name = "😀".repeat(BRIDGE_SKILL_LIMITS.nameMaxCharacters);
    const created = await client.callTool({
      name: "bridge_skill_manage",
      arguments: {
        operation: "create",
        requestId: randomUUID(),
        name,
        content: "# Unicode scalar boundary"
      }
    });
    expect(created.isError, JSON.stringify(created)).not.toBe(true);
    const skill = (created.structuredContent as any).skill;
    expect(skill.name).toBe(name);

    const overflow = await client.callTool({
      name: "bridge_skill_manage",
      arguments: {
        operation: "create",
        requestId: randomUUID(),
        name: `${name}😀`,
        content: "# Too long"
      }
    });
    expect(overflow.isError).toBe(true);

    const paddedReference = await client.callTool({
      name: "bridge_skill",
      arguments: {
        operation: "read",
        skill: { skillId: ` ${skill.skillId}`, source: "bridge", version: skill.version }
      }
    });
    expect(paddedReference.isError).toBe(true);
  });

  it("keeps Bridge skills outside the Codex task schema and prompt", async () => {
    const created = await client.callTool({
      name: "bridge_skill_manage",
      arguments: {
        operation: "create",
        requestId: randomUUID(),
        name: "Local review",
        description: "Review a local report before editing it.",
        content: "Inspect the report, then make only evidence-backed edits."
      }
    });
    const skill = (created.structuredContent as any).skill;
    const descriptor = (await client.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    const properties = descriptor.inputSchema.properties as Record<string, { const?: string }>;
    const project = settings.current.projects[0]!;

    const result = await client.callTool({
      name: "codex_task",
      arguments: {
        scopeId: "73737373-7373-4737-8737-737373737373",
        requestId: randomUUID(),
        taskContractVersion: properties.taskContractVersion?.const,
        executionEnvelopeRef: properties.executionEnvelopeRef?.const,
        prompt: "Review the local report.",
        project: {
          name: project.name,
          projectRef: project.projectRef,
          projectRevision: project.projectRevision
        },
        selection
      },
      _meta: metadata
    });

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    await eventually(() => upstream.calls.length === 1);
    const dispatched = upstream.calls[0]!.args;
    expect(properties).not.toHaveProperty("requiredSkills");
    expect(dispatched.prompt).toBe("Review the local report.");
    expect(dispatched.prompt).not.toContain("evidence-backed edits");
    expect(dispatched).not.toHaveProperty("skillInputs");
    const job = state.listJobs().find((candidate) => candidate.requestId === (result.structuredContent as any).requestId)!;
    expect(job.sessionDecision).not.toHaveProperty("requiredSkills");
  });

  it("publishes Settings hydration without undefined optional catalog fields", async () => {
    const result = await client.callTool({
      name: "codex_ui_read",
      arguments: { view: "settings" }
    });

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toBeDefined();
    expect(JSON.parse(JSON.stringify(result.structuredContent))).toStrictEqual(result.structuredContent);
    const settingsView = result.structuredContent as any;
    expect(settingsView.catalog.models[0]).not.toHaveProperty("defaultServiceTier");
    expect(settingsView.settings).not.toHaveProperty("dashboardAutoOpen");
    expect(settingsView.settings).not.toHaveProperty("completionFollowUp");
    expect(settingsView.settings).not.toHaveProperty("activityCardVisibility");
    expect(settingsView.settings).not.toHaveProperty("completionHandoff");
    expect(settingsView.capabilities).not.toHaveProperty("availableActivityCardVisibilities");
    expect(settingsView.capabilities).not.toHaveProperty("availableCompletionHandoffs");
  });

  it("keeps developer-only startup diagnostics out of normal Settings", async () => {
    const diagnostic = "This development build explicitly targets the stable state profile.";
    config.developerStartupWarnings.push(diagnostic);

    const result = await client.callTool({
      name: "codex_ui_read",
      arguments: { view: "settings" }
    });

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect((result.structuredContent as { warnings: string[] }).warnings).not.toContain(diagnostic);
  });

  it("publishes Dashboard hydration without undefined thread-handoff fields", async () => {
    const descriptor = (await client.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    const properties = descriptor.inputSchema.properties as Record<string, { const?: string }>;
    const project = settings.current.projects[0]!;
    const hold = upstream.holdNextCall();
    const task = await client.callTool({
      name: "codex_task",
      arguments: {
        scopeId: "77777777-7777-4777-8777-777777777777",
        requestId: randomUUID(),
        taskContractVersion: properties.taskContractVersion?.const,
        executionEnvelopeRef: properties.executionEnvelopeRef?.const,
        prompt: "Create a completed Dashboard handoff fixture.",
        project: {
          name: project.name,
          projectRef: project.projectRef,
          projectRevision: project.projectRevision
        },
        selection
      },
      _meta: metadata
    });
    expect(task.isError, JSON.stringify(task)).not.toBe(true);
    const admitted = task.structuredContent as { jobId: string };
    await hold.started;
    hold.assign(fixtureThreadId);
    await eventually(() => state.listJobs().some((job) =>
      job.jobId === admitted.jobId && job.threadId === fixtureThreadId
    ));

    const result = await client.callTool({
      name: "codex_ui_read",
      arguments: {
        view: "dashboard",
        widgetInstanceId: randomUUID(),
        scope: "all",
        statusFilter: "all",
        enrich: false,
        includeHistory: false
      }
    });
    hold.release();
    await eventually(() => state.listJobs().some((job) =>
      job.jobId === admitted.jobId && job.status === "completed"
    ));

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toBeDefined();
    expect(JSON.parse(JSON.stringify(result.structuredContent))).toStrictEqual(result.structuredContent);
    const dashboard = result.structuredContent as any;
    const rows = [
      ...dashboard.activeRows,
      ...dashboard.terminalRows,
      ...dashboard.idleRows,
      ...(dashboard.statusRows || [])
    ];
    const row = rows.find((candidate: any) =>
      candidate.codexThreadUrl === `codex://threads/${fixtureThreadId}`
    );
    expect(row).toBeDefined();
    expect(row?.handoff).toMatchObject({
      phase: "connected",
      requested: false,
      canOpen: false
    });
    expect(row?.handoff).not.toHaveProperty("reason");
  });

  it("keeps created-time representatives and exact historical recovery metadata in bounded Dashboard reads", async () => {
    const scopeId = "78787878-7878-4787-8787-787878787878";
    const agentId = "79797979-7979-4797-8797-797979797979";
    const olderFailedJobId = randomUUID();
    const newerCompletedJobId = randomUUID();
    const base = Date.now() - 1_000;
    state.createAgent({
      scopeId,
      agentId,
      agentName: "dashboard-selection-fixture",
      now: base
    });
    state.upsertJob({
      jobId: olderFailedJobId,
      scopeId,
      requestId: randomUUID(),
      status: "failed",
      agentId,
      createdAt: base + 10,
      updatedAt: base + 100
    });
    state.upsertJob({
      jobId: newerCompletedJobId,
      scopeId,
      requestId: randomUUID(),
      status: "completed",
      agentId,
      createdAt: base + 20,
      updatedAt: base + 90
    });
    state.deleteJob(olderFailedJobId);
    state.deleteJob(newerCompletedJobId);

    const recovery = state.automaticRecovery.begin({
      key: "a".repeat(64),
      scopeId,
      agentId,
      jobId: olderFailedJobId,
      kind: "retry-stop"
    }, base + 110)!;
    state.automaticRecovery.finish(recovery.key, recovery.attempts, {
      resolved: false,
      reason: "fixture-blocked",
      retryable: false
    }, base + 111);

    const bounded = await client.callTool({
      name: "codex_ui_read",
      arguments: {
        view: "dashboard",
        widgetInstanceId: randomUUID(),
        scope: "all",
        statusFilter: "problems",
        enrich: false,
        includeHistory: false
      }
    });
    expect(bounded.isError, JSON.stringify(bounded)).not.toBe(true);
    expect((bounded.structuredContent as any).statusRows.some((row: any) =>
      row.agentName === "dashboard-selection-fixture"
    )).toBe(false);

    const result = await client.callTool({
      name: "codex_ui_read",
      arguments: {
        view: "dashboard",
        widgetInstanceId: randomUUID(),
        scope: "all",
        statusFilter: "all",
        enrich: false,
        includeHistory: true,
        problems: {
          view: "automatic",
          review: "pending",
          kind: "all",
          offset: 0
        }
      }
    });

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const dashboard = result.structuredContent as any;
    const representative = dashboard.terminalRows.find((row: any) =>
      row.agentName === "dashboard-selection-fixture"
    );
    expect(representative?.latestTurn).toMatchObject({
      status: "completed",
      startedAt: new Date(base + 20).toISOString(),
      updatedAt: new Date(base + 90).toISOString()
    });
    expect(dashboard.problems.automaticCount).toBe(1);
    expect(dashboard.problems.rows).toHaveLength(1);
    expect(dashboard.problems.rows[0]).toMatchObject({
      source: "recovery",
      automatic: {
        kind: "retry-stop",
        state: "blocked",
        reason: "fixture-blocked"
      },
      row: {
        status: "failed",
        createdAt: new Date(base + 10).toISOString(),
        updatedAt: new Date(base + 100).toISOString(),
        latestTurn: {
          status: "failed",
          startedAt: new Date(base + 10).toISOString(),
          updatedAt: new Date(base + 100).toISOString()
        }
      }
    });
  });

  it("keeps Dashboard summary and deferred history on the same representative beyond the twelve-row boundary", async () => {
    const scopeId = "80808080-8080-4080-8080-808080808080";
    const agentId = "81818181-8181-4181-8181-818181818181";
    const base = Date.now() - 10_000;
    state.createAgent({
      scopeId,
      agentId,
      agentName: "dashboard-history-boundary",
      now: base
    });
    for (let index = 1; index <= 13; index += 1) {
      const jobId = `history-boundary-old-${String(index).padStart(2, "0")}`;
      state.upsertJob({
        jobId,
        scopeId,
        requestId: randomUUID(),
        status: "failed",
        agentId,
        createdAt: base + index,
        updatedAt: base + 2_000 + index
      });
      state.deleteJob(jobId);
    }
    state.upsertJob({
      jobId: "history-boundary-newest-run",
      scopeId,
      requestId: randomUUID(),
      status: "completed",
      agentId,
      createdAt: base + 1_000,
      updatedAt: base + 1_001
    });
    state.deleteJob("history-boundary-newest-run");

    const summaryResult = await client.callTool({
      name: "codex_ui_read",
      arguments: {
        view: "dashboard",
        widgetInstanceId: randomUUID(),
        scope: "all",
        statusFilter: "all",
        enrich: false,
        includeHistory: true
      }
    });
    expect(summaryResult.isError, JSON.stringify(summaryResult)).not.toBe(true);
    const summary = (summaryResult.structuredContent as any).terminalRows.find((row: any) =>
      row.agentName === "dashboard-history-boundary"
    );
    expect(summary?.latestTurn).toMatchObject({
      status: "completed",
      startedAt: new Date(base + 1_000).toISOString(),
      updatedAt: new Date(base + 1_001).toISOString()
    });
    expect(summary?.historyRevision).toEqual(expect.any(String));

    const detailResult = await client.callTool({
      name: "codex_ui_read",
      arguments: {
        view: "dashboard-history",
        rowKey: summary.rowKey,
        widgetInstanceId: randomUUID(),
        scope: "all"
      }
    });
    expect(detailResult.isError, JSON.stringify(detailResult)).not.toBe(true);
    const detail = detailResult.structuredContent as any;
    expect(detail.historyRevision).toBe(summary.historyRevision);
    expect(detail.historyCount).toBe(13);
    expect(detail.history).toHaveLength(12);
    expect(detail.history.map((turn: any) => turn.startedAt)).toEqual(
      Array.from({length: 12}, (_, index) =>
        new Date(base + 13 - index).toISOString()
      )
    );
  });

  it("publishes draft-2020-12-compatible v6 asynchronous task input without retired fields", async () => {
    const tools = await client.listTools();
    const task = tools.tools.find((tool) => tool.name === "codex_task")!;
    const properties = task.inputSchema.properties as Record<string, { const?: string }>;
    expect(properties.taskContractVersion?.const).toBe("6");
    expect(properties.executionEnvelopeRef?.const).toMatch(/^[a-f0-9]{64}$/);
    expect(properties).toHaveProperty("project");
    for (const retired of ["projectLookup", "sandbox", "executionPolicyRef", "presentationId", "waitToken", "executionMode"]) {
      expect(properties).not.toHaveProperty(retired);
    }
    const status = tools.tools.find((tool) => tool.name === "codex_status")!;
    expect(status.inputSchema.properties).not.toHaveProperty("includeAllScopes");
  });

  it("admits a current v6 task and returns the durable asynchronous admission contract", async () => {
    const descriptor = (await client.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    const properties = descriptor.inputSchema.properties as Record<string, { const?: string }>;
    const project = settings.current.projects[0]!;
    const hold = upstream.holdNextCall();
    const result = await client.callTool({
      name: "codex_task",
      arguments: {
        scopeId: "77777777-7777-4777-8777-777777777777",
        requestId: randomUUID(),
        taskContractVersion: properties.taskContractVersion?.const,
        executionEnvelopeRef: properties.executionEnvelopeRef?.const,
        prompt: "Complete fixture work.",
        project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision },
        selection
      },
      _meta: metadata
    });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      contractVersion: "4",
      state: "running",
      terminal: false,
      completionDeliveryPolicy: "live-card",
      jobId: expect.any(String),
      requestId: expect.any(String),
      threadId: null,
      resultAvailability: "pending"
    });
    expect(result.structuredContent).not.toHaveProperty("waitContext");
    expect(result._meta).not.toHaveProperty("openai/outputTemplate");
    await hold.started;
    expect(upstream.calls).toHaveLength(1);
    hold.release();
    await eventually(() => state.listJobs().some((job) =>
      job.jobId === (result.structuredContent as any).jobId && job.status === "completed"
    ));
  });

  it("snapshots experimental direct-result delivery per Job and keeps the default live-card path unchanged", async () => {
    const descriptorBefore = (await client.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    const properties = descriptorBefore.inputSchema.properties as Record<string, { const?: string }>;
    const project = settings.current.projects[0]!;
    const enabled = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedSettingsRevision: settings.current.settingsRevision,
        operation: {
          kind: "patch",
          settings: { experimentalDirectResultDelivery: true }
        }
      },
      _meta: metadata
    });
    expect(enabled.isError, JSON.stringify(enabled)).not.toBe(true);
    expect(enabled.structuredContent).toHaveProperty(
      "settings.experimentalDirectResultDelivery",
      true
    );
    const enabledRevision = (enabled.structuredContent as any).settings.settingsRevision as number;
    const descriptorAfter = (await client.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    expect((descriptorAfter.inputSchema.properties as any).executionEnvelopeRef.const)
      .toBe(properties.executionEnvelopeRef?.const);
    expect(descriptorAfter.description).toContain("Follow the returned Job's completionDeliveryPolicy and nextActions");
    expect(descriptorAfter.description).toContain("repeat that same Job wait after timeout or host abort");

    const hold = upstream.holdNextCall();
    const requestId = randomUUID();
    const argumentsValue = {
      scopeId: "78787878-7878-4878-8878-787878787878",
      requestId,
      taskContractVersion: properties.taskContractVersion?.const,
      executionEnvelopeRef: properties.executionEnvelopeRef?.const,
      prompt: "Complete the direct-result fixture work.",
      project: {
        name: project.name,
        projectRef: project.projectRef,
        projectRevision: project.projectRevision
      },
      selection
    };
    const admitted = await client.callTool({
      name: "codex_task",
      arguments: argumentsValue,
      _meta: metadata
    });
    expect(admitted.isError, JSON.stringify(admitted)).not.toBe(true);
    await hold.started;
    const task = admitted.structuredContent as any;
    expect(task).toMatchObject({
      contractVersion: "4",
      state: "running",
      completionDeliveryPolicy: "direct-wait"
    });
    expect(task.nextActions).toContainEqual(expect.objectContaining({
      kind: "tool",
      tool: "codex_status",
      arguments: {
        query: {
          kind: "job",
          id: task.jobId,
          waitFor: "terminal",
          waitMs: 60_000
        }
      }
    }));
    expect(task.nextActions.some((action: any) => action.tool === "codex_dashboard")).toBe(false);
    expect(JSON.stringify(admitted.content)).toContain("Required before replying:");
    expect(JSON.stringify(admitted.content)).toContain("codex_status");

    const timedOut = await client.callTool({
      name: "codex_status",
      arguments: {
        query: { kind: "job", id: task.jobId, waitFor: "terminal", waitMs: 1 }
      },
      _meta: metadata
    });
    expect(timedOut.isError, JSON.stringify(timedOut)).not.toBe(true);
    expect(timedOut.structuredContent).toMatchObject({
      kind: "job",
      items: [expect.objectContaining({
        id: task.jobId,
        state: "running",
        completionDeliveryPolicy: "direct-wait",
        wait: expect.objectContaining({ waitFor: "terminal", timedOut: true }),
        nextActions: expect.arrayContaining([expect.objectContaining({
          tool: "codex_status",
          arguments: { query: expect.objectContaining({ id: task.jobId, waitFor: "terminal" }) }
        })])
      })]
    });

    const replay = await client.callTool({
      name: "codex_task",
      arguments: argumentsValue,
      _meta: metadata
    });
    expect(replay.isError, JSON.stringify(replay)).not.toBe(true);
    expect(replay.structuredContent).toMatchObject({
      jobId: task.jobId,
      replay: true,
      completionDeliveryPolicy: "direct-wait"
    });
    expect(upstream.calls).toHaveLength(1);

    const disabled = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedSettingsRevision: enabledRevision,
        operation: {
          kind: "patch",
          settings: { experimentalDirectResultDelivery: false }
        }
      },
      _meta: metadata
    });
    expect(disabled.isError, JSON.stringify(disabled)).not.toBe(true);
    expect(disabled.structuredContent).toHaveProperty(
      "settings.experimentalDirectResultDelivery",
      false
    );

    hold.release();
    await eventually(() => state.listJobs().some((job) =>
      job.jobId === task.jobId && job.status === "completed"
    ));
    const terminal = await client.callTool({
      name: "codex_status",
      arguments: {
        query: { kind: "job", id: task.jobId, waitFor: "terminal", waitMs: 60_000 }
      },
      _meta: metadata
    });
    expect(terminal.isError, JSON.stringify(terminal)).not.toBe(true);
    expect(terminal.structuredContent).toMatchObject({
      kind: "job",
      items: [expect.objectContaining({
        id: task.jobId,
        state: "completed",
        completionDeliveryPolicy: "direct-wait",
        answer: expect.stringContaining("Completed delayed fixture work")
      })]
    });
    const directDelivery = state.getJobCompletionDelivery(task.jobId)!;
    expect(directDelivery).toMatchObject({
      state: "pending",
      attemptCount: 0,
      directResultOfferedAt: expect.any(Number)
    });
    expect(state.claimJobCompletionDelivery(
      task.jobId,
      directDelivery.scopeId,
      randomUUID()
    )).toBeUndefined();

    const defaultTask = await client.callTool({
      name: "codex_task",
      arguments: {
        ...argumentsValue,
        requestId: randomUUID(),
        prompt: "Complete the default delivery fixture work."
      },
      _meta: metadata
    });
    expect(defaultTask.isError, JSON.stringify(defaultTask)).not.toBe(true);
    expect(defaultTask.structuredContent).toMatchObject({
      state: "running",
      completionDeliveryPolicy: "live-card",
      nextActions: expect.arrayContaining([expect.objectContaining({ tool: "codex_dashboard" })])
    });
  });

  it("returns durable admission immediately while the admitted Job runs for more than one minute", async () => {
    const descriptor = (await client.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    const properties = descriptor.inputSchema.properties as Record<string, { const?: string }>;
    const project = settings.current.projects[0]!;
    const hold = upstream.holdNextCall();
    const requestId = randomUUID();
    const startedAt = Date.now();
    let jobId: string | undefined;

    try {
      const admitted = await client.callTool({
        name: "codex_task",
        arguments: {
          scopeId: "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a",
          requestId,
          taskContractVersion: properties.taskContractVersion?.const,
          executionEnvelopeRef: properties.executionEnvelopeRef?.const,
          prompt: "Remain active for the long asynchronous admission acceptance fixture.",
          project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision },
          selection
        },
        _meta: metadata
      });
      const admissionElapsedMs = Date.now() - startedAt;
      expect(admitted.isError, JSON.stringify(admitted)).not.toBe(true);
      expect(admissionElapsedMs).toBeLessThan(5_000);
      jobId = (admitted.structuredContent as { jobId: string }).jobId;
      await hold.started;

      await new Promise<void>((resolve) => setTimeout(resolve, 61_000));

      expect(state.listJobs().find((job) => job.jobId === jobId)).toMatchObject({
        requestId,
        status: "running"
      });
      const recovered = await client.callTool({
        name: "codex_status",
        arguments: { query: { kind: "request", requestId } },
        _meta: metadata
      });
      expect(recovered.isError, JSON.stringify(recovered)).not.toBe(true);
      expect(recovered.structuredContent).toMatchObject({
        kind: "job",
        items: [{ id: jobId, state: "running" }]
      });
      expect(upstream.calls).toHaveLength(1);
    } finally {
      hold.release();
    }

    await eventually(() => state.listJobs().some((job) =>
      job.jobId === jobId && job.status === "completed"
    ));
  }, 75_000);

  it("does not admit a task when transport fails before dispatch and admits it once on exact retry", async () => {
    const descriptor = (await client.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    const properties = descriptor.inputSchema.properties as Record<string, { const?: string }>;
    const project = settings.current.projects[0]!;
    const requestId = randomUUID();
    const arguments_ = {
      scopeId: "7b7b7b7b-7b7b-4b7b-8b7b-7b7b7b7b7b7b",
      requestId,
      taskContractVersion: properties.taskContractVersion?.const,
      executionEnvelopeRef: properties.executionEnvelopeRef?.const,
      prompt: "Recover a request that was lost before durable admission.",
      project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision },
      selection
    };
    let dropBeforeDispatch = false;
    const lossyFetch: typeof globalThis.fetch = async (input, init) => {
      if (
        dropBeforeDispatch &&
        typeof init?.body === "string" &&
        init.body.includes('"name":"codex_task"')
      ) {
        dropBeforeDispatch = false;
        throw new TypeError("simulated pre-admission transport loss");
      }
      return globalThis.fetch(input, init);
    };
    const lossyClient = new Client(
      { name: "pre-admission-loss-test", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } }
    );
    await lossyClient.connect(new StreamableHTTPClientTransport(endpoint, { fetch: lossyFetch }));

    try {
      dropBeforeDispatch = true;
      await expect(lossyClient.callTool({
        name: "codex_task",
        arguments: arguments_,
        _meta: metadata
      })).rejects.toThrow("simulated pre-admission transport loss");
      expect(state.listJobs().filter((job) => job.requestId === requestId)).toEqual([]);
      expect(upstream.calls).toHaveLength(0);

      const missing = await client.callTool({
        name: "codex_status",
        arguments: { query: { kind: "request", requestId } },
        _meta: metadata
      });
      expect(missing.isError).toBe(true);
      expect(JSON.stringify(missing)).toContain("HANDLE_UNAVAILABLE");

      const admitted = await client.callTool({ name: "codex_task", arguments: arguments_, _meta: metadata });
      expect(admitted.isError, JSON.stringify(admitted)).not.toBe(true);
      await eventually(() => state.listJobs().some((job) =>
        job.requestId === requestId && job.status === "completed"
      ));
      expect(state.listJobs().filter((job) => job.requestId === requestId)).toHaveLength(1);
      expect(upstream.calls).toHaveLength(1);
    } finally {
      await lossyClient.close();
    }
  });

  it("recovers a durable Job when the admission response is lost in transport", async () => {
    const descriptor = (await client.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    const properties = descriptor.inputSchema.properties as Record<string, { const?: string }>;
    const project = settings.current.projects[0]!;
    const hold = upstream.holdNextCall();
    const requestId = randomUUID();
    const arguments_ = {
      scopeId: "7c7c7c7c-7c7c-4c7c-8c7c-7c7c7c7c7c7c",
      requestId,
      taskContractVersion: properties.taskContractVersion?.const,
      executionEnvelopeRef: properties.executionEnvelopeRef?.const,
      prompt: "Recover this Job after its durable admission response is lost.",
      project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision },
      selection
    };
    let dropTaskResponse = false;
    const lossyFetch: typeof globalThis.fetch = async (input, init) => {
      const response = await globalThis.fetch(input, init);
      if (
        dropTaskResponse &&
        typeof init?.body === "string" &&
        init.body.includes('"name":"codex_task"')
      ) {
        dropTaskResponse = false;
        await response.body?.cancel();
        throw new TypeError("simulated lost admission response");
      }
      return response;
    };
    const lossyClient = new Client(
      { name: "admission-response-loss-test", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } }
    );
    await lossyClient.connect(new StreamableHTTPClientTransport(endpoint, { fetch: lossyFetch }));
    let jobId: string | undefined;

    try {
      dropTaskResponse = true;
      await expect(lossyClient.callTool({
        name: "codex_task",
        arguments: arguments_,
        _meta: metadata
      })).rejects.toThrow("simulated lost admission response");
      await hold.started;
      const admitted = state.listJobs().filter((job) => job.requestId === requestId);
      expect(admitted).toHaveLength(1);
      expect(admitted[0]).toMatchObject({ status: "running" });
      jobId = admitted[0]!.jobId;

      const recovered = await client.callTool({
        name: "codex_status",
        arguments: { query: { kind: "request", requestId } },
        _meta: metadata
      });
      expect(recovered.isError, JSON.stringify(recovered)).not.toBe(true);
      expect(recovered.structuredContent).toMatchObject({
        kind: "job",
        items: [{ id: jobId, state: "running" }]
      });

      const replay = await client.callTool({ name: "codex_task", arguments: arguments_, _meta: metadata });
      expect(replay.isError, JSON.stringify(replay)).not.toBe(true);
      expect(replay.structuredContent).toMatchObject({ jobId, replay: true, state: "running" });
      expect(upstream.calls).toHaveLength(1);
    } finally {
      hold.release();
      await lossyClient.close();
    }

    await eventually(() => state.listJobs().some((job) =>
      job.jobId === jobId && job.status === "completed"
    ));
  });

  it("deduplicates concurrent exact retries into one durable Job and one upstream execution", async () => {
    const descriptor = (await client.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    const properties = descriptor.inputSchema.properties as Record<string, { const?: string }>;
    const project = settings.current.projects[0]!;
    const hold = upstream.holdNextCall();
    const requestId = randomUUID();
    const arguments_ = {
      scopeId: "7d7d7d7d-7d7d-4d7d-8d7d-7d7d7d7d7d7d",
      requestId,
      taskContractVersion: properties.taskContractVersion?.const,
      executionEnvelopeRef: properties.executionEnvelopeRef?.const,
      prompt: "Deduplicate simultaneous durable admission retries.",
      project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision },
      selection
    };
    let jobId: string | undefined;

    try {
      const [first, second] = await Promise.all([
        client.callTool({ name: "codex_task", arguments: arguments_, _meta: metadata }),
        client.callTool({ name: "codex_task", arguments: arguments_, _meta: metadata })
      ]);
      expect(first.isError, JSON.stringify(first)).not.toBe(true);
      expect(second.isError, JSON.stringify(second)).not.toBe(true);
      const firstResult = first.structuredContent as { jobId: string; replay: boolean; state: string };
      const secondResult = second.structuredContent as { jobId: string; replay: boolean; state: string };
      expect(firstResult.jobId).toBe(secondResult.jobId);
      expect([firstResult.replay, secondResult.replay].sort()).toEqual([false, true]);
      expect(firstResult.state).toBe("running");
      expect(secondResult.state).toBe("running");
      jobId = firstResult.jobId;
      await hold.started;
      expect(state.listJobs().filter((job) => job.requestId === requestId)).toHaveLength(1);
      expect(upstream.calls).toHaveLength(1);
    } finally {
      hold.release();
    }

    await eventually(() => state.listJobs().some((job) =>
      job.jobId === jobId && job.status === "completed"
    ));
  });

  it("recovers an admitted Job by requestId and rejects conflicting reuse without redispatch", async () => {
    const descriptor = (await client.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    const properties = descriptor.inputSchema.properties as Record<string, { const?: string }>;
    const project = settings.current.projects[0]!;
    const hold = upstream.holdNextCall();
    const requestId = randomUUID();
    const arguments_ = {
      scopeId: "79797979-7979-4797-8797-797979797979",
      requestId,
      taskContractVersion: properties.taskContractVersion?.const,
      executionEnvelopeRef: properties.executionEnvelopeRef?.const,
      prompt: "Recover this durable admission after a lost response.",
      project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision },
      selection
    };

    const admitted = await client.callTool({ name: "codex_task", arguments: arguments_, _meta: metadata });
    expect(admitted.isError, JSON.stringify(admitted)).not.toBe(true);
    await hold.started;
    const jobId = (admitted.structuredContent as any).jobId as string;

    const recovered = await client.callTool({
      name: "codex_status",
      arguments: { query: { kind: "request", requestId } },
      _meta: metadata
    });
    expect(recovered.isError, JSON.stringify(recovered)).not.toBe(true);
    expect(recovered.structuredContent).toMatchObject({
      kind: "job",
      items: [{ id: jobId, state: "running" }]
    });

    const replay = await client.callTool({ name: "codex_task", arguments: arguments_, _meta: metadata });
    expect(replay.isError, JSON.stringify(replay)).not.toBe(true);
    expect(replay.structuredContent).toMatchObject({ jobId, replay: true, state: "running" });
    expect(upstream.calls).toHaveLength(1);

    const conflict = await client.callTool({
      name: "codex_task",
      arguments: { ...arguments_, prompt: "A different task must not reuse this requestId." },
      _meta: metadata
    });
    expect(conflict.isError).toBe(true);
    expect(JSON.stringify(conflict)).toContain("requestId was already used");
    expect(upstream.calls).toHaveLength(1);

    hold.release();
    await eventually(() => state.listJobs().some((job) => job.jobId === jobId && job.status === "completed"));
  });

  it("does not distinguish scope-mismatched handles from missing handles", async () => {
    const descriptor = (await client.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    const properties = descriptor.inputSchema.properties as Record<string, { const?: string }>;
    const project = settings.current.projects[0]!;
    const admitted = await client.callTool({
      name: "codex_task",
      arguments: {
        scopeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        requestId: randomUUID(),
        taskContractVersion: properties.taskContractVersion?.const,
        executionEnvelopeRef: properties.executionEnvelopeRef?.const,
        prompt: "Create handles for the scope-isolation fixture.",
        project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision },
        selection
      },
      _meta: metadata
    });
    expect(admitted.isError, JSON.stringify(admitted)).not.toBe(true);
    const handles = admitted.structuredContent as {
      jobId: string | null;
      activityId: string | null;
      agentId: string | null;
      threadId: string | null;
      jobVersion: number | null;
    };
    expect(handles).toMatchObject({
      jobId: expect.any(String),
      activityId: expect.any(String),
      agentId: expect.any(String),
      threadId: null,
      jobVersion: expect.any(Number)
    });
    await eventually(() => state.listJobs().some((job) =>
      job.jobId === handles.jobId && job.status === "completed" && Boolean(job.threadId)
    ));
    const durableHandles = state.listJobs().find((job) => job.jobId === handles.jobId)!;
    const foreignMetadata = { "openai/session": "foreign-tool-contract-test" };
    const errorText = async (name: string, arguments_: Record<string, unknown>): Promise<string> => {
      const result = await client.callTool({ name, arguments: arguments_, _meta: foreignMetadata });
      expect(result.isError, JSON.stringify(result)).toBe(true);
      const content = result.content || [];
      return content
        .filter((item): item is { type: "text"; text: string } => item.type === "text")
        .map((item) => item.text)
        .join("\n");
    };
    const expectSameUnavailable = async (
      name: string,
      foreignArguments: Record<string, unknown>,
      missingArguments: Record<string, unknown>
    ) => {
      const [foreign, missing] = await Promise.all([
        errorText(name, foreignArguments),
        errorText(name, missingArguments)
      ]);
      expect(foreign).toContain("HANDLE_UNAVAILABLE");
      expect(foreign).toBe(missing);
      expect(foreign).not.toMatch(/another conversation|does not exist|unknown/i);
    };

    await expectSameUnavailable(
      "codex_status",
      { query: { kind: "job", id: handles.jobId } },
      { query: { kind: "job", id: "missing-job" } }
    );
    await expectSameUnavailable(
      "codex_status",
      { query: { kind: "activity", id: handles.activityId } },
      { query: { kind: "activity", id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } }
    );
    await expectSameUnavailable(
      "codex_status",
      { query: { kind: "thread", id: durableHandles.threadId } },
      { query: { kind: "thread", id: "missing-thread" } }
    );
    await expectSameUnavailable(
      "codex_agent",
      { agentId: handles.agentId, requestId: randomUUID(), operation: { kind: "rename", name: "Foreign" } },
      {
        agentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        requestId: randomUUID(), operation: { kind: "rename", name: "Missing" }
      }
    );
    await expectSameUnavailable(
      "codex_cancel",
      {
        requestId: randomUUID(), target: { kind: "job", id: handles.jobId },
        expectedVersion: durableHandles.version, reason: "fixture"
      },
      {
        requestId: randomUUID(), target: { kind: "job", id: "missing-job" },
        expectedVersion: durableHandles.version, reason: "fixture"
      }
    );
    await expectSameUnavailable(
      "codex_activity_update",
      {
        activityId: handles.activityId, expectedVersion: 1,
        operation: { kind: "set-policy", policy: { kind: "review" } }
      },
      {
        activityId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", expectedVersion: 1,
        operation: { kind: "set-policy", policy: { kind: "review" } }
      }
    );
  });

  it("records a detached HTTP task call without turning it into cancellation", async () => {
    const descriptor = (await client.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    const properties = descriptor.inputSchema.properties as Record<string, { const?: string }>;
    const project = settings.current.projects[0]!;
    const hold = upstream.holdNextCall();
    const controller = new AbortController();
    const requestId = randomUUID();
    const arguments_ = {
      scopeId: "77777777-7777-4777-8777-777777777777",
      requestId,
      taskContractVersion: properties.taskContractVersion?.const,
      executionEnvelopeRef: properties.executionEnvelopeRef?.const,
      prompt: "Keep this task alive while the HTTP response is detached.",
      project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision },
      selection
    };
    const pending = client.callTool({
      name: "codex_task",
      arguments: arguments_,
      _meta: metadata
    }, { signal: controller.signal });
    const outcome = pending.then(
      () => "completed" as const,
      () => "detached" as const
    );
    await hold.started;
    controller.abort();

    const disposition = await outcome;
    expect(["completed", "detached"]).toContain(disposition);
    const admitted = state.listJobs().find((item) =>
      (item as { requestId?: unknown }).requestId === requestId
    ) as { status?: unknown; cancelRequestedAt?: unknown } | undefined;
    expect(admitted).toMatchObject({ status: "running" });
    expect(admitted?.cancelRequestedAt).toBeFalsy();

    const recovered = await client.callTool({
      name: "codex_status",
      arguments: { query: { kind: "request", requestId } },
      _meta: metadata
    });
    expect(recovered.isError, JSON.stringify(recovered)).not.toBe(true);
    expect(recovered.structuredContent).toMatchObject({
      kind: "job",
      items: [{ id: (admitted as { jobId: string }).jobId, state: "running" }]
    });
    const replay = await client.callTool({ name: "codex_task", arguments: arguments_, _meta: metadata });
    expect(replay.isError, JSON.stringify(replay)).not.toBe(true);
    expect(replay.structuredContent).toMatchObject({
      jobId: (admitted as { jobId: string }).jobId,
      replay: true,
      state: "running"
    });
    expect(upstream.calls).toHaveLength(1);

    hold.release();
    await eventually(() => state.listJobs().some((item) =>
      (item as { requestId?: unknown; status?: unknown }).requestId === requestId &&
      (item as { status?: unknown }).status === "completed"
    ));
  });

  it("records an aborted exact status wait while the same Job keeps running", async () => {
    const descriptor = (await client.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    const properties = descriptor.inputSchema.properties as Record<string, { const?: string }>;
    const project = settings.current.projects[0]!;
    const hold = upstream.holdNextCall();
    const task = await client.callTool({
      name: "codex_task",
      arguments: {
        requestId: randomUUID(),
        taskContractVersion: properties.taskContractVersion?.const,
        executionEnvelopeRef: properties.executionEnvelopeRef?.const,
        prompt: "Stay active while an exact status read is aborted.",
        project: {
          name: project.name,
          projectRef: project.projectRef,
          projectRevision: project.projectRevision
        },
        selection
      },
      _meta: metadata
    });
    expect(task.isError, JSON.stringify(task)).not.toBe(true);
    await hold.started;
    const jobId = (task.structuredContent as { jobId: string }).jobId;
    try {
      const projectRevisionReads = vi.spyOn(state, "getProjectRegistryRevision");
      projectRevisionReads.mockClear();
      const controller = new AbortController();
      const waiting = client.callTool({
        name: "codex_status",
        arguments: { query: { kind: "job", id: jobId, waitFor: "terminal", waitMs: 5_000 } },
        _meta: metadata
      }, { signal: controller.signal });
      await eventually(() => projectRevisionReads.mock.calls.length > 0);
      controller.abort();

      await expect(waiting).rejects.toThrow();
      await eventually(() => state.listTransportObservations("status-wait-aborted").length === 1);
      expect(state.listTransportObservations("status-wait-aborted")).toEqual([
        expect.objectContaining({
          kind: "status-wait-aborted",
          jobId,
          toolName: "codex_status",
          reasonCode: "host-aborted-read-wait"
        })
      ]);
      expect(state.listJobs().find((job) => job.jobId === jobId)).toMatchObject({
        status: "running"
      });
      expect(state.listJobs().find((job) => job.jobId === jobId)?.cancelRequestedAt)
        .toBeUndefined();
    } finally {
      hold.release();
      await eventually(() => state.listJobs().some((job) =>
        job.jobId === jobId && job.status === "completed"
      )).catch(() => undefined);
    }
  });

  it("keeps an asynchronous admission valid before App Server assigns its thread", async () => {
    const descriptor = (await client.listTools()).tools.find((tool) => tool.name === "codex_task")!;
    const properties = descriptor.inputSchema.properties as Record<string, { const?: string }>;
    const project = settings.current.projects[0]!;
    const hold = upstream.holdNextCall();
    const requestId = randomUUID();
    const result = await client.callTool({
      name: "codex_task",
      arguments: {
        scopeId: "78787878-7878-4787-8787-787878787878",
        requestId,
        taskContractVersion: properties.taskContractVersion?.const,
        executionEnvelopeRef: properties.executionEnvelopeRef?.const,
        prompt: "Wait for an App Server thread assignment.",
        project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision },
        selection
      },
      _meta: metadata
    });

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    await hold.started;
    const admitted = result.structuredContent as { jobId: string; state: string; threadId: string | null };
    expect(admitted).toMatchObject({
      jobId: expect.any(String),
      state: "running",
      threadId: null
    });
    const pendingJob = state.listJobs().find((job) => job.jobId === admitted.jobId);
    expect(pendingJob?.threadId ?? null).toBeNull();

    hold.assign("assigned-after-admission-thread");
    await eventually(() => state.listJobs().some((job) =>
      job.jobId === admitted.jobId && job.threadId === "assigned-after-admission-thread"
    ));
    const status = await client.callTool({
      name: "codex_status",
      arguments: { query: { kind: "job", id: admitted.jobId } },
      _meta: metadata
    });
    expect(status.isError, JSON.stringify(status)).not.toBe(true);
    expect(status.structuredContent).toMatchObject({
      kind: "job",
      items: [{
        threadId: "assigned-after-admission-thread",
        state: "running"
      }]
    });

    hold.release();
    await eventually(() => state.listJobs().some((job) =>
      job.jobId === admitted.jobId && job.status === "completed"
    ));
  });

  it("automatically opens the originating conversation Dashboard for admitted work and queues completion delivery", async () => {
    const tools = await client.listTools();
    const descriptor = tools.tools.find((tool) => tool.name === "codex_task")!;
    const statusDescriptor = tools.tools.find((tool) => tool.name === "codex_status")!;
    const dashboardDescriptor = tools.tools.find((tool) => tool.name === "codex_dashboard")!;
    expect(statusDescriptor.description).toContain(
      "does not prove GPT received the result and does not settle or cancel live-card delivery"
    );
    expect(statusDescriptor.description).not.toContain("settles any still-pending live-card follow-up");
    const properties = descriptor.inputSchema.properties as Record<string, { const?: string }>;
    const project = settings.current.projects[0]!;
    expect((dashboardDescriptor._meta as Record<string, any>)["openai/outputTemplate"])
      .toBe(DASHBOARD_CARD_URI);
    expect((dashboardDescriptor._meta as Record<string, any>).ui)
      .toMatchObject({ resourceUri: DASHBOARD_CARD_URI });
    const hold = upstream.holdNextCall();
    const result = await client.callTool({
      name: "codex_task",
      arguments: {
        scopeId: "88888888-8888-4888-8888-888888888888",
        requestId: randomUUID(),
        taskContractVersion: properties.taskContractVersion?.const,
        executionEnvelopeRef: properties.executionEnvelopeRef?.const,
        prompt: "Complete background fixture work.",
        project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision },
        activity: {
          mode: "new",
          title: "Fixture completion delivery"
        },
        selection
      },
      _meta: metadata
    });

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    await hold.started;
    expect(result._meta || {}).not.toHaveProperty("openai/outputTemplate");
    expect(result._meta || {}).not.toHaveProperty("codex/dashboardOpen@1");
    const task = result.structuredContent as any;
    const renderAction = task.nextActions.find((action: any) =>
      action.kind === "tool" &&
      action.tool === "codex_dashboard" &&
      action.arguments.scope === "conversation" &&
      action.arguments.jobId === task.jobId
    );
    expect(renderAction).toMatchObject({
      kind: "tool",
      tool: "codex_dashboard",
      arguments: {
        scope: "conversation",
        jobId: task.jobId,
        presentationRef: expect.stringMatching(/^[a-f0-9]{64}$/)
      },
      message: expect.stringContaining("originating Dashboard")
    });
    const origin = state.listJobs().find((job) =>
      job.jobId === task.jobId
    );
    expect(origin).toBeDefined();
    const runningStatus = await client.callTool({
      name: "codex_status",
      arguments: { query: { kind: "job", id: origin!.jobId } },
      _meta: metadata
    });
    expect(runningStatus.isError, JSON.stringify(runningStatus)).not.toBe(true);
    expect(state.getJobCompletionDelivery(origin!.jobId, origin!.scopeId)).toBeUndefined();

    const mismatchedDashboardOpen = await client.callTool({
      name: "codex_dashboard",
      arguments: {
        ...renderAction.arguments,
        presentationRef: "0".repeat(64)
      },
      _meta: metadata
    });
    expect(mismatchedDashboardOpen.isError).toBe(true);

    const dashboardOpen = await client.callTool({
      name: "codex_dashboard",
      arguments: renderAction.arguments,
      _meta: metadata
    });
    expect(dashboardOpen.isError, JSON.stringify(dashboardOpen)).not.toBe(true);
    expect(dashboardOpen._meta || {}).not.toHaveProperty("openai/outputTemplate");
    const dashboardOpenMeta = dashboardOpen._meta as Record<string, any>;
    expect(dashboardOpenMeta["codex/dashboardOpen@1"]).toMatchObject({
      scope: "conversation",
      automatic: true,
      presentationRef: renderAction.arguments.presentationRef,
      completionDeliveryRoute: "live-card"
    });
    expect(dashboardOpenMeta["codex/dashboardOpen@1"]).not.toHaveProperty("presentationToken");
    expect(dashboardOpenMeta["codex/dashboardOpen@1"]).not.toHaveProperty("jobId");
    expect(dashboardOpenMeta["codex/dashboardOpen@1"]).not.toHaveProperty("scopeId");

    const repeatedDashboardOpen = await client.callTool({
      name: "codex_dashboard",
      arguments: renderAction.arguments,
      _meta: metadata
    });
    expect(repeatedDashboardOpen.isError, JSON.stringify(repeatedDashboardOpen)).not.toBe(true);
    expect((repeatedDashboardOpen._meta as Record<string, any>)["codex/dashboardOpen@1"])
      .toEqual(dashboardOpenMeta["codex/dashboardOpen@1"]);

    const differentJobWithSameReference = await client.callTool({
      name: "codex_dashboard",
      arguments: {
        ...renderAction.arguments,
        jobId: randomUUID()
      },
      _meta: metadata
    });
    expect(differentJobWithSameReference.isError).toBe(true);

    const foreignConversationWithOriginFallback = await client.callTool({
      name: "codex_dashboard",
      arguments: {
        ...renderAction.arguments,
        scopeId: origin!.scopeId
      },
      _meta: { "openai/session": "foreign-tool-contract-test" }
    });
    expect(foreignConversationWithOriginFallback.isError).toBe(true);

    hold.release();
    await eventually(() => state.listJobs().some((job) =>
      job.jobId === origin!.jobId && job.status === "completed"
    ));
    const completedActivity = state.getActivity(origin!.activityId);
    expect(completedActivity).toMatchObject({
      lifecycle: "open",
      handoffPolicy: "none",
      completionTrigger: "manual"
    });
    const completionDelivery = state.getJobCompletionDelivery(origin!.jobId, origin!.scopeId)!;
    expect(completionDelivery).toMatchObject({
      jobId: origin!.jobId,
      scopeId: origin!.scopeId,
      state: "pending",
      attemptCount: 0,
      receipt: expect.stringMatching(/^completion-[0-9a-f]{64}$/)
    });
    const widgetInstanceId = randomUUID();
    const claimedCompletion = await client.callTool({
      name: "codex_ui_completion",
      arguments: {
        operation: "wait",
        jobId: origin!.jobId,
        presentationRef: renderAction.arguments.presentationRef,
        widgetInstanceId
      },
      _meta: metadata
    });
    expect(claimedCompletion.isError, JSON.stringify(claimedCompletion)).not.toBe(true);
    expect(claimedCompletion.structuredContent).toMatchObject({
      kind: "job-completion-delivery",
      state: "claimed",
      receipt: completionDelivery.receipt,
      attempt: 1,
      deliveryState: "leased"
    });
    const directReadAfterLease = await client.callTool({
      name: "codex_status",
      arguments: { query: { kind: "job", id: origin!.jobId } },
      _meta: metadata
    });
    expect(directReadAfterLease.isError, JSON.stringify(directReadAfterLease)).not.toBe(true);
    expect(state.getJobCompletionDelivery(origin!.jobId, origin!.scopeId)).toMatchObject({
      state: "leased",
      directResultOfferedAt: expect.any(Number),
      resultReadSource: undefined
    });
    const foreignCompletion = await client.callTool({
      name: "codex_ui_completion",
      arguments: {
        operation: "wait",
        jobId: origin!.jobId,
        presentationRef: renderAction.arguments.presentationRef,
        widgetInstanceId: randomUUID()
      },
      _meta: { "openai/session": "foreign-completion-contract-test" }
    });
    expect(foreignCompletion.isError).toBe(true);
    const acceptedCompletion = await client.callTool({
      name: "codex_ui_completion",
      arguments: {
        operation: "accepted",
        jobId: origin!.jobId,
        presentationRef: renderAction.arguments.presentationRef,
        widgetInstanceId,
        receipt: completionDelivery.receipt
      },
      _meta: metadata
    });
    expect(acceptedCompletion.isError, JSON.stringify(acceptedCompletion)).not.toBe(true);
    expect(acceptedCompletion.structuredContent).toMatchObject({
      state: "settled",
      deliveryState: "host-accepted"
    });
    const explicitScopeIsNotAuthority = await client.callTool({
      name: "codex_status",
      arguments: {
        scopeId: origin!.scopeId,
        query: { kind: "completion", receipt: completionDelivery.receipt }
      }
    });
    expect(explicitScopeIsNotAuthority.isError).toBe(true);
    const exactCompletion = await client.callTool({
      name: "codex_status",
      arguments: { query: { kind: "completion", receipt: completionDelivery.receipt } },
      _meta: metadata
    });
    expect(exactCompletion.isError, JSON.stringify(exactCompletion)).not.toBe(true);
    expect(exactCompletion.structuredContent).toMatchObject({
      kind: "job",
      items: [expect.objectContaining({ id: origin!.jobId, state: "completed" })]
    });
    expect(state.getJobCompletionDelivery(origin!.jobId, origin!.scopeId)).toMatchObject({
      state: "host-accepted",
      completionResultOfferedAt: expect.any(Number),
      resultReadSource: undefined
    });
    expect(state.listPendingCompletionOutbox(origin!.scopeId)).toEqual([]);

    const dashboard = await client.callTool({
      name: "codex_ui_read",
      arguments: {
        view: "dashboard",
        widgetInstanceId,
        scope: "conversation"
      },
      _meta: metadata
    });
    expect(dashboard.isError, JSON.stringify(dashboard)).not.toBe(true);
    expect((dashboard.structuredContent as any)).not.toHaveProperty("completionDelivery");
    expect(state.listPendingCompletionOutbox(origin!.scopeId)).toEqual([]);

    const leaseOwner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const nativeEvents = await server.applicationService.claimNativeCompletionNotifications!({
      leaseOwner,
      limit: 10
    });
    expect(nativeEvents).toEqual([]);
    expect(state.listPendingCompletionOutbox(origin!.scopeId)).toEqual([]);

    const settingsUpdate = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedSettingsRevision: settings.current.settingsRevision,
        operation: { kind: "patch", settings: { dashboardAutoOpen: false } }
      },
      _meta: metadata
    });
    expect(settingsUpdate.isError).toBe(true);

    const secondTask = await client.callTool({
      name: "codex_task",
      arguments: {
        scopeId: "99999999-9999-4999-8999-999999999999",
        requestId: randomUUID(),
        taskContractVersion: properties.taskContractVersion?.const,
        executionEnvelopeRef: properties.executionEnvelopeRef?.const,
        prompt: "Complete another background fixture work.",
        project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision },
        selection
      },
      _meta: metadata
    });
    expect(secondTask.isError, JSON.stringify(secondTask)).not.toBe(true);
    expect(secondTask._meta).not.toHaveProperty("openai/outputTemplate");
    expect(secondTask._meta).not.toHaveProperty("codex/dashboardOpen@1");
    const secondRenderAction = (secondTask.structuredContent as any).nextActions.find(
      (action: any) =>
        action.kind === "tool" &&
        action.tool === "codex_dashboard" &&
        action.arguments.jobId === (secondTask.structuredContent as any).jobId
    );
    expect(secondRenderAction).toMatchObject({
      kind: "tool",
      tool: "codex_dashboard",
      arguments: expect.objectContaining({
        scope: "conversation",
        jobId: (secondTask.structuredContent as any).jobId,
        presentationRef: expect.stringMatching(/^[a-f0-9]{64}$/)
      })
    });
    const secondJob = state.listJobs().find((job) =>
      job.jobId === (secondTask.structuredContent as any).jobId
    );
    expect(secondJob).toBeDefined();
    await eventually(() => state.listJobs().some((job) =>
      job.jobId === secondJob!.jobId && job.status === "completed"
    ));
    expect(state.getActivity(secondJob!.activityId)).toMatchObject({
      handoffPolicy: "none",
      completionTrigger: "manual"
    });
    expect(state.getJobCompletionDelivery(secondJob!.jobId, secondJob!.scopeId)).toMatchObject({
      state: "pending"
    });
    const explicitScopeRead = await client.callTool({
      name: "codex_status",
      arguments: {
        scopeId: secondJob!.scopeId,
        query: { kind: "job", id: secondJob!.jobId }
      }
    });
    expect(explicitScopeRead.isError, JSON.stringify(explicitScopeRead)).not.toBe(true);
    expect(state.getJobCompletionDelivery(secondJob!.jobId, secondJob!.scopeId)).toMatchObject({
      state: "pending",
      directResultOfferedAt: undefined,
      resultReadSource: undefined
    });
    const authenticatedDirectRead = await client.callTool({
      name: "codex_status",
      arguments: { query: { kind: "job", id: secondJob!.jobId } },
      _meta: metadata
    });
    expect(authenticatedDirectRead.isError, JSON.stringify(authenticatedDirectRead)).not.toBe(true);
    expect(state.getJobCompletionDelivery(secondJob!.jobId, secondJob!.scopeId)).toMatchObject({
      state: "pending",
      directResultOfferedAt: expect.any(Number),
      resultReadSource: undefined,
      attemptCount: 0
    });
    const claimedAfterDirectOffer = await client.callTool({
      name: "codex_ui_completion",
      arguments: {
        operation: "wait",
        jobId: secondJob!.jobId,
        presentationRef: secondRenderAction.arguments.presentationRef,
        widgetInstanceId: randomUUID()
      },
      _meta: metadata
    });
    expect(claimedAfterDirectOffer.isError, JSON.stringify(claimedAfterDirectOffer)).not.toBe(true);
    expect(claimedAfterDirectOffer.structuredContent).toMatchObject({
      state: "claimed",
      deliveryState: "leased",
      receipt: expect.stringMatching(/^completion-[0-9a-f]{64}$/)
    });
  });
});

async function eventually(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for asynchronous bridge state.");
}
