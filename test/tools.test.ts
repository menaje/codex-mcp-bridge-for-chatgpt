import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Progress } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { CodexModelCatalogProvider, CodexModelCatalogSnapshot } from "../src/modelCatalog.js";
import { createBridgeMcpServer } from "../src/server.js";
import { SCOPE_ID_PATTERN, SessionRegistry } from "../src/sessionRegistry.js";
import { SETTINGS_CARD_URI } from "../src/settingsCard.js";
import { CodexJobRegistry } from "../src/tools.js";
import type {
  CodexProgress,
  CodexUpstream,
  ToolResult,
  UpstreamWorkerAssignment
} from "../src/upstream.js";
import { UserSettingsStore } from "../src/userSettings.js";

const SCOPE_A = "11111111-1111-4111-8111-111111111111";
const SCOPE_B = "22222222-2222-4222-8222-222222222222";
const UPPERCASE_SCOPE = "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF";
let requestSequence = 0;

class FakeUpstream implements CodexUpstream {
  public calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  private nextThread = 1;

  async listTools(): Promise<unknown> {
    return { tools: [{ name: "codex" }, { name: "codex-reply" }] };
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    this.calls.push({ name, args });
    const threadId =
      name === "codex-reply" && typeof args.threadId === "string" ? args.threadId : `thread-${this.nextThread++}`;
    return fakeCodexResult(threadId);
  }

  async close(): Promise<void> {}
}

class DeferredUpstream extends FakeUpstream {
  public aborts = 0;
  private pending: Array<{
    resolve: (result: ToolResult) => void;
    reject: (error: Error) => void;
    onProgress?: (progress: CodexProgress) => void;
  }> = [];

  override async callTool(
    name: string,
    args: Record<string, unknown>,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult> {
    this.calls.push({ name, args });
    onAssigned?.({
      backendKind: "mcp-server",
      workerId: "fake-0",
      workerGeneration: 1,
      workerPid: 999_001,
      processGroupId: 999_001
    });
    return new Promise<ToolResult>((resolve, reject) => {
      this.pending.push({ resolve, reject, onProgress });
    });
  }

  async forceTerminateWorker() {
    this.aborts += 1;
    for (const pending of this.pending.splice(0)) pending.reject(new Error("worker force-stopped"));
    return {
      pid: 999_001,
      processGroupId: 999_001,
      exited: true,
      escalated: false,
      signal: "SIGTERM" as const,
      mode: "process-group" as const,
      workerExited: true
    };
  }

  progressNext(progress: Progress): void {
    const pending = this.pending[0];
    if (!pending) throw new Error("No pending upstream call.");
    pending.onProgress?.(progress);
  }

  resolveNext(result: ToolResult = fakeCodexResult("thread-1")): void {
    const pending = this.pending.shift();
    if (!pending) throw new Error("No pending upstream call.");
    pending.resolve(result);
  }

  rejectNext(error = new Error("upstream failed")): void {
    const pending = this.pending.shift();
    if (!pending) throw new Error("No pending upstream call.");
    pending.reject(error);
  }
}

class MultiTurnAppUpstream extends FakeUpstream {
  public forceCalls: UpstreamWorkerAssignment[] = [];
  private nextTurn = 1;

  override async callTool(
    name: string,
    args: Record<string, unknown>,
    _onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult> {
    this.calls.push({ name, args });
    const turn = this.nextTurn++;
    onAssigned?.({
      backendKind: "app-server",
      workerId: "app-shared-0",
      workerGeneration: 4,
      workerPid: 4400,
      processGroupId: 4400,
      upstreamRequestId: `app-turn-${turn}`,
      threadId: `app-thread-${turn}`
    });
    return new Promise<ToolResult>(() => undefined);
  }

  async forceTerminateWorker(assignment: UpstreamWorkerAssignment) {
    this.forceCalls.push(assignment);
    return {
      pid: 4400,
      processGroupId: 4400,
      exited: true,
      escalated: false,
      signal: "SIGTERM" as const,
      mode: "turn-interrupt" as const,
      workerExited: false
    };
  }
}

class LargeResultUpstream extends FakeUpstream {
  override async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    this.calls.push({ name, args });
    return {
      structuredContent: { threadId: "large-thread", content: "x".repeat(2000) },
      content: [{ type: "text", text: "x".repeat(2000) }]
    };
  }
}

class RestartAwareUpstream extends FakeUpstream {
  constructor(private readonly unavailableThreads: Set<string>) {
    super();
  }

  canResumeThread(threadId: string): boolean {
    return !this.unavailableThreads.has(threadId);
  }
}

class FakeModelCatalog implements CodexModelCatalogProvider {
  public calls: Array<{ refresh?: boolean }> = [];

  async getCatalog(options: { refresh?: boolean } = {}): Promise<CodexModelCatalogSnapshot> {
    this.calls.push(options);
    return {
      source: "codex-cli",
      fetchedAt: "2026-08-21T00:00:00.000Z",
      cached: this.calls.length > 1,
      stale: false,
      models: [
        model("gpt-5.6-sol", "max", ["low", "medium", "high", "xhigh", "max", "ultra"]),
        model("gpt-5.6-terra", "medium", ["low", "medium", "high", "xhigh", "max", "ultra"]),
        model("gpt-5.5", "medium", ["low", "medium", "high", "xhigh"])
      ]
    };
  }
}

describe("bridge tools", () => {
  it("publishes the consolidated Activity, settings, and Codex tools", async () => {
    const root = temporaryRoot();
    const { client, close } = await connectTestClient(configFor(root), new FakeUpstream());

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "codex_activity",
      "codex_activity_handoff",
      "codex_activity_update",
      "codex_cancel",
      "codex_models",
      "codex_settings",
      "codex_status",
      "codex_task",
      "codex_update_settings"
    ]);
    const byName = new Map(tools.tools.map((tool) => [tool.name, tool]));
    expect(byName.get("codex_status")?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true
    });
    expect(byName.get("codex_status")?.inputSchema).toMatchObject({
      properties: {
        waitFor: { enum: ["change", "terminal"] },
        waitMs: { maximum: 60000 }
      }
    });
    expect(byName.get("codex_task")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false
    });
    expect(byName.get("codex_task")?.inputSchema).toMatchObject({
      required: expect.arrayContaining(["requestId", "prompt"])
    });
    expect((byName.get("codex_task")?.inputSchema as { required?: string[] }).required)
      .not.toContain("scopeId");
    expect(byName.get("codex_task")?.inputSchema.properties).not.toHaveProperty("taskKey");
    expect(byName.get("codex_task")?.inputSchema.properties).toMatchObject({
      activityKind: { enum: ["discussion", "investigation", "review", "implementation", "other"] },
      executionMode: { enum: ["foreground", "background"] },
      handoffPolicy: { enum: ["none", "notify", "verify"] },
      completionTrigger: { enum: ["manual", "sealed-jobs-terminal"] }
    });
    expect(byName.get("codex_activity_update")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false
    });
    expect(byName.get("codex_settings")?._meta).toMatchObject({
      ui: { resourceUri: SETTINGS_CARD_URI, visibility: ["model", "app"] },
      "openai/outputTemplate": SETTINGS_CARD_URI
    });
    expect(byName.get("codex_update_settings")?._meta).toMatchObject({
      ui: { visibility: ["app"] },
      "openai/visibility": "private"
    });
    expect(byName.get("codex_update_settings")?.inputSchema.properties).toMatchObject({
      uiLocalePreference: {
        enum: ["auto", "en", "ko", "ja", "zh-Hans", "zh-Hant", "es", "fr", "de", "pt"]
      },
      activityCardVisibility: { enum: ["always", "background-only", "never"] },
      completionHandoff: { enum: ["off", "auto-handoff"] }
    });
    expect(byName.get("codex_update_settings")?.inputSchema.properties)
      .not.toHaveProperty("defaultSessionMode");
    expect(byName.get("codex_update_settings")?.inputSchema.properties)
      .not.toHaveProperty("autoResumeTtlMs");

    await close();
  });

  it("serves the self-contained MCP Apps settings card resource", async () => {
    const root = temporaryRoot();
    const { client, close } = await connectTestClient(configFor(root), new FakeUpstream());

    const resource = await client.readResource({ uri: SETTINGS_CARD_URI });
    const contents = resource.contents[0] as {
      mimeType?: string;
      text?: string;
      _meta?: Record<string, any>;
    };
    expect(contents.mimeType).toBe("text/html;profile=mcp-app");
    expect(contents.text).toContain("Codex Bridge 설정");
    expect(contents.text).toContain("window.openai.callTool");
    expect(contents.text).toContain("codex_update_settings");
    expect(contents.text).not.toContain("localStorage");
    expect(contents.text).toContain('id="ui-language"');
    expect(contents.text).toContain('ko:"한국어"');
    expect(contents.text).not.toContain('id="resume-hours"');
    expect(contents.text).not.toContain('id="timeout-minutes"');
    expect(contents.text).toContain('id="concurrency" type="number" min="1" step="1" required');
    expect(contents.text).toContain("const REQUEST_TIMEOUT_MS = 90000;");
    expect(contents.text).toContain("result&&result.isError");
    expect(contents.text).toContain("!elements.form.reportValidity()");
    expect(contents.text).toContain("Number.isSafeInteger(value)");
    expect(contents.text).not.toContain("view.settings.defaultReasoningEffort = null");
    expect(contents._meta).toMatchObject({
      ui: {
        csp: { connectDomains: [], resourceDomains: [] },
        domain: "https://web-sandbox.oaiusercontent.com"
      },
      "openai/widgetCSP": { connect_domains: [], resource_domains: [] },
      "openai/widgetDomain": "https://web-sandbox.oaiusercontent.com"
    });

    await close();
  });

  it("marks codex_task as stateful and filesystem-destructive only when write policy is enabled", async () => {
    const root = temporaryRoot();
    const config = configFor(root, {
      CODEX_MCP_BRIDGE_ALLOW_WRITE: "1",
      CODEX_MCP_BRIDGE_DEFAULT_SANDBOX: "workspace-write"
    });
    const { client, close } = await connectTestClient(config, new FakeUpstream());
    const tool = (await client.listTools()).tools.find((entry) => entry.name === "codex_task");

    expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    await close();
  });

  it("reports bridge policy, durable session policy, and default cwd", async () => {
    const root = temporaryRoot();
    const config = configFor(root, {
      CODEX_MCP_BRIDGE_DEFAULT_MODEL: "gpt-5.6-sol",
      CODEX_MCP_BRIDGE_DEFAULT_REASONING_EFFORT: "max"
    });
    const { client, close } = await connectTestClient(config, new FakeUpstream());

    const status = parseToolJson(await client.callTool({ name: "codex_status", arguments: {} }));
    expect(status).toMatchObject({
      defaultCwd: realpathSync(root),
      defaultModel: "gpt-5.6-sol",
      defaultReasoningEffort: "max",
      codexExecutionDeadline: "none",
      upstreamPoolSize: 4,
      maxRetainedJobs: 100,
      maxJobResultBytes: 1048576,
      maxConcurrentJobs: 30,
      stateStorage: { backend: "memory", persistencePath: null, transactional: false },
      concurrencyPolicy: {
        sameWorkingDirectory: {
          readOnly: "allowed",
          workspaceWrite: "allowed",
          dangerFullAccess: "allowed"
        },
        sameThread: "serialized",
        mutationCoordination: "caller-managed"
      },
      sessionPolicy: {
        persistent: false,
        selection: "activity-compatible-only-when-unambiguous",
        implicitNewActivityBehavior: "start-new-thread",
        exactActivityContinuationAgeLimit: "none"
      }
    });
    expect(status.sessions).toEqual([]);

    await close();
  });

  it("reports null default cwd when multiple roots are configured", async () => {
    const first = temporaryRoot();
    const second = temporaryRoot();
    const config = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ROOTS: `${first},${second}`
    });
    const { client, close } = await connectTestClient(config, new FakeUpstream());

    const status = parseToolJson(await client.callTool({ name: "codex_status", arguments: {} }));
    expect(status.defaultCwd).toBeNull();
    await close();
  });

  it("returns the dynamic model and effort catalog", async () => {
    const root = temporaryRoot();
    const catalog = new FakeModelCatalog();
    const { client, close } = await connectTestClient(configFor(root), new FakeUpstream(), undefined, catalog);

    const result = parseToolJson(
      await client.callTool({ name: "codex_models", arguments: { refresh: true } })
    );
    expect(result.models.map((entry: { id: string }) => entry.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.5"
    ]);
    expect(catalog.calls).toEqual([{ refresh: true }]);

    await close();
  });

  it("reads and saves validated defaults through the settings-card tools", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const config = configFor(root, {
      CODEX_MCP_BRIDGE_ALLOW_WRITE: "1",
      CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS: "1",
      CODEX_MCP_BRIDGE_APPROVAL_POLICY: "never",
      CODEX_MCP_BRIDGE_DEFAULT_MODEL: "gpt-5.6-sol",
      CODEX_MCP_BRIDGE_DEFAULT_REASONING_EFFORT: "max"
    });
    const settings = new UserSettingsStore(config);
    const { client, close } = await connectTestClient(
      config,
      upstream,
      undefined,
      new FakeModelCatalog(),
      settings
    );

    const opened = await client.callTool({ name: "codex_settings", arguments: {} });
    expect((opened as { structuredContent?: Record<string, any> }).structuredContent).toMatchObject({
      settings: {
        revision: 0,
        accessStrategy: "adaptive",
        defaultModel: "gpt-5.6-sol",
        defaultReasoningEffort: "max",
        defaultCwd: realpathSync(root),
        uiLocalePreference: "auto",
        maxConcurrentJobs: 30,
        activityCardVisibility: "always",
        completionHandoff: "off"
      },
      capabilities: {
        availableAccessStrategies: ["read-only", "adaptive", "always-full"],
        allowedRoots: [realpathSync(root)],
        availableUiLocalePreferences: ["auto", "en", "ko", "ja", "zh-Hans", "zh-Hant", "es", "fr", "de", "pt"],
        availableActivityCardVisibilities: ["always", "background-only", "never"],
        availableCompletionHandoffs: ["off", "auto-handoff"],
        maxConcurrentJobs: 30,
        allowDangerFullAccess: true
      }
    });

    const saved = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRevision: 0,
        accessStrategy: "always-full",
        defaultModel: "gpt-5.6-terra",
        defaultReasoningEffort: "high",
        defaultCwd: root,
        uiLocalePreference: "ko",
        maxConcurrentJobs: 12,
        activityCardVisibility: "background-only",
        completionHandoff: "auto-handoff"
      }
    });
    expect((saved as { structuredContent?: Record<string, any> }).structuredContent?.settings).toMatchObject({
      revision: 1,
      accessStrategy: "always-full",
      defaultModel: "gpt-5.6-terra",
      defaultReasoningEffort: "high",
      uiLocalePreference: "ko",
      maxConcurrentJobs: 12,
      activityCardVisibility: "background-only",
      completionHandoff: "auto-handoff"
    });

    const localizedSettings = await client.callTool({
      name: "codex_settings",
      arguments: {},
      _meta: { "openai/locale": "en-US" }
    });
    expect((localizedSettings as { _meta?: Record<string, any> })._meta).toMatchObject({
      "openai/locale": "ko",
      hostLocale: "en-US"
    });
    const localizedActivity = await client.callTool({
      name: "codex_activity",
      arguments: { scopeId: SCOPE_A },
      _meta: { "openai/locale": "en-US" }
    });
    expect((localizedActivity as { _meta?: Record<string, any> })._meta).toMatchObject({
      "openai/locale": "ko",
      hostLocale: "en-US"
    });

    await client.callTool({
      name: "codex_task",
      arguments: { prompt: "use saved defaults", sandbox: "read-only" }
    });
    expect(upstream.calls[0]).toMatchObject({
      name: "codex",
      args: {
        cwd: realpathSync(root),
        sandbox: "danger-full-access",
        model: "gpt-5.6-terra",
        config: { model_reasoning_effort: "high" },
        "approval-policy": "never"
      }
    });

    const status = parseToolJson(await client.callTool({ name: "codex_status", arguments: {} }));
    expect(status).toMatchObject({
      accessStrategy: "always-full",
      defaultSandbox: "danger-full-access",
      uiLocalePreference: "ko",
      codexExecutionDeadline: "none",
      maxConcurrentJobs: 12,
      settingsPolicy: { revision: 1, scope: "shared-bridge-instance" }
    });
    expect(status).not.toHaveProperty("fastReturnMs");
    await close();
  });

  it("rejects stale settings cards and unsupported saved model/effort pairs", async () => {
    const root = temporaryRoot();
    const config = configFor(root, { CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS: "1" });
    const { client, close } = await connectTestClient(config, new FakeUpstream());

    await client.callTool({
      name: "codex_update_settings",
      arguments: { expectedRevision: 0, uiLocalePreference: "ko" }
    });
    const stale = await client.callTool({
      name: "codex_update_settings",
      arguments: { expectedRevision: 0, accessStrategy: "always-full" }
    });
    expect(stale.isError).toBe(true);
    expect(JSON.stringify(stale)).toContain("SETTINGS_REVISION_CONFLICT");
    expect(JSON.stringify(stale)).not.toContain("expected revision");
    expect(JSON.stringify(stale)).not.toContain("current revision");

    const unsupported = await client.callTool({
      name: "codex_update_settings",
      arguments: {
        expectedRevision: 1,
        defaultModel: "gpt-5.5",
        defaultReasoningEffort: "max"
      }
    });
    expect(unsupported.isError).toBe(true);
    expect(JSON.stringify(unsupported)).toContain("does not support reasoning effort");
    await close();
  });

  it("keeps Activity card visibility independent from foreground/background execution", async () => {
    const root = temporaryRoot();
    const config = configFor(root);
    const { client, close } = await connectTestClient(config, new FakeUpstream());

    const alwaysForeground = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "discuss with a visible card",
        sessionMode: "new",
        activityKind: "discussion",
        executionMode: "foreground"
      }
    });
    expect((alwaysForeground as { structuredContent?: Record<string, any> }).structuredContent)
      .toMatchObject({
        bridgeActivity: {
          executionMode: "foreground",
          activityCardVisibility: "always",
          shouldRenderActivityCard: true,
          renderTiming: "after-result-or-existing-mounted-card"
        }
      });

    await client.callTool({
      name: "codex_update_settings",
      arguments: { expectedRevision: 0, activityCardVisibility: "background-only" }
    });
    const backgroundOnlyForeground = await client.callTool({
      name: "codex_task",
      arguments: { prompt: "foreground without automatic card", sessionMode: "new", executionMode: "foreground" }
    });
    expect((backgroundOnlyForeground as { structuredContent?: Record<string, any> }).structuredContent)
      .toMatchObject({ bridgeActivity: { shouldRenderActivityCard: false } });

    const backgroundOnlyBackground = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: { prompt: "background with automatic card", sessionMode: "new" }
    }));
    expect(backgroundOnlyBackground).toMatchObject({
      status: "running",
      executionMode: "background",
      bridgeActivity: {
        activityCardVisibility: "background-only",
        shouldRenderActivityCard: true,
        renderTiming: "immediate"
      }
    });

    await client.callTool({
      name: "codex_update_settings",
      arguments: { expectedRevision: 1, activityCardVisibility: "never", completionHandoff: "off" }
    });
    const neverBackground = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: { prompt: "background without automatic card", sessionMode: "new" }
    }));
    expect(neverBackground.bridgeActivity).toMatchObject({
      activityCardVisibility: "never",
      shouldRenderActivityCard: false,
      explicitRenderAllowed: true
    });
    const explicitCard = await client.callTool({
      name: "codex_activity",
      arguments: { scopeId: SCOPE_A }
    });
    expect((explicitCard as { structuredContent?: Record<string, any> }).structuredContent)
      .toMatchObject({ activityCardVisibility: "never", activities: expect.any(Array) });

    const impossible = await client.callTool({
      name: "codex_update_settings",
      arguments: { expectedRevision: 2, completionHandoff: "auto-handoff" }
    });
    expect(impossible.isError).toBe(true);
    expect(JSON.stringify(impossible)).toContain("requires the Activity card");
    await close();
  });

  it("exposes only policy-permitted sandbox values", async () => {
    const root = temporaryRoot();
    const readClient = await connectTestClient(configFor(root), new FakeUpstream());
    let schema = (await readClient.client.listTools()).tools.find((entry) => entry.name === "codex_task")
      ?.inputSchema as { properties?: { sandbox?: { enum?: string[] } } };
    expect(schema.properties?.sandbox?.enum).toEqual(["read-only"]);
    await readClient.close();

    const writeClient = await connectTestClient(
      configFor(root, { CODEX_MCP_BRIDGE_ALLOW_WRITE: "1" }),
      new FakeUpstream()
    );
    schema = (await writeClient.client.listTools()).tools.find((entry) => entry.name === "codex_task")
      ?.inputSchema as { properties?: { sandbox?: { enum?: string[] } } };
    expect(schema.properties?.sandbox?.enum).toEqual(["read-only", "workspace-write"]);
    await writeClient.close();

    const fullClient = await connectTestClient(
      configFor(root, {
        CODEX_MCP_BRIDGE_ALLOW_WRITE: "1",
        CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS: "1"
      }),
      new FakeUpstream()
    );
    schema = (await fullClient.client.listTools()).tools.find((entry) => entry.name === "codex_task")
      ?.inputSchema as { properties?: { sandbox?: { enum?: string[] } } };
    expect(schema.properties?.sandbox?.enum).toEqual([
      "read-only",
      "workspace-write",
      "danger-full-access"
    ]);
    await fullClient.close();
  });

  it("starts a sanitized read-only session by default", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, close } = await connectTestClient(configFor(root), upstream);

    await client.callTool({
      name: "codex_task",
      arguments: { prompt: "inspect", sessionMode: "new" }
    });
    expect(upstream.calls).toEqual([
      {
        name: "codex",
        args: {
          prompt: "inspect",
          cwd: realpathSync(root),
          sandbox: "read-only",
          "approval-policy": "on-request"
        }
      }
    ]);

    await close();
  });

  it("creates and reuses one explicit Activity across parallel background Codex jobs", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, jobs, close } = await connectTestClient(configFor(root), upstream);

    const first = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "parallel part one",
        sessionMode: "new",
        activityTitle: "Parallel investigation",
        activityKind: "investigation",
        executionMode: "background",
        handoffPolicy: "none",
        completionTrigger: "manual"
      }
    }));
    expect(first).toMatchObject({
      status: "running",
      async: true,
      executionMode: "background",
      activityTracking: {
        statusTool: "codex_status",
        plannedRenderTool: "codex_activity",
        renderToolAvailable: true
      }
    });
    expect(first.activityId).toMatch(SCOPE_ID_PATTERN);
    expect(jobs.getActivity(first.activityId)).toMatchObject({
      title: "Parallel investigation",
      kind: "investigation",
      executionMode: "background",
      handoffPolicy: "none",
      completionTrigger: "manual",
      lifecycle: "open",
      waitingOn: "codex",
      counts: { total: 1, running: 1 }
    });

    const second = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "parallel part two",
        sessionMode: "new",
        activityId: first.activityId,
        executionMode: "background"
      }
    }));
    expect(second.activityId).toBe(first.activityId);
    expect(second.jobId).not.toBe(first.jobId);
    expect(jobs.getActivity(first.activityId)).toMatchObject({ counts: { total: 2, running: 2 } });

    const policyInjection = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "must not mutate policy",
        sessionMode: "new",
        activityId: first.activityId,
        handoffPolicy: "notify"
      }
    });
    expect(policyInjection.isError).toBe(true);
    expect(JSON.stringify(policyInjection)).toContain("cannot be used with activityId");
    expect(upstream.calls).toHaveLength(2);

    upstream.resolveNext(fakeCodexResult("thread-1"));
    upstream.resolveNext(fakeCodexResult("thread-2"));
    await waitForJobStatus(client, first.jobId, "completed");
    await waitForJobStatus(client, second.jobId, "completed");
    expect(jobs.getActivity(first.activityId)).toMatchObject({
      lifecycle: "open",
      waitingOn: "orchestrator",
      handoffPolicy: "none",
      counts: { total: 2, completed: 2, terminal: 2 }
    });

    const stalePolicy = await client.callTool({
      name: "codex_activity_update",
      arguments: {
        activityId: first.activityId,
        expectedVersion: 1,
        action: "set-policy",
        handoffPolicy: "notify"
      }
    });
    expect(stalePolicy.isError).toBe(true);
    expect(JSON.stringify(stalePolicy)).toContain("Activity version changed");
    expect(jobs.getActivity(first.activityId)).toMatchObject({ handoffPolicy: "none" });

    const completed = parseToolJson(await client.callTool({
      name: "codex_activity_update",
      arguments: {
        activityId: first.activityId,
        action: "complete",
        reason: "The orchestrator accepted both investigation results"
      }
    }));
    expect(completed).toMatchObject({
      action: "complete",
      activity: { lifecycle: "completed", waitingOn: "none", completionVersion: 1 },
      policySource: "explicit-tool-input",
      codexOutputCanMutatePolicy: false
    });
    await close();
  });

  it("keeps foreground execution in the active call and returns Activity identifiers", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, jobs, close } = await connectTestClient(configFor(root), upstream);

    let settled = false;
    const pending = client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "discuss synchronously",
        sessionMode: "new",
        activityTitle: "Architecture discussion",
        activityKind: "discussion",
        executionMode: "foreground"
      }
    }).then((result) => {
      settled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    expect(upstream.calls).toHaveLength(1);

    upstream.resolveNext(fakeCodexResult("discussion-thread"));
    const result = await pending;
    expect((result as { structuredContent?: Record<string, any> }).structuredContent).toMatchObject({
      threadId: "discussion-thread",
      bridgeActivity: {
        activityId: expect.stringMatching(SCOPE_ID_PATTERN),
        jobId: expect.stringMatching(SCOPE_ID_PATTERN),
        executionMode: "foreground"
      }
    });
    const activityId = (result as { structuredContent?: Record<string, any> })
      .structuredContent?.bridgeActivity?.activityId;
    expect(jobs.getActivity(activityId)).toMatchObject({
      kind: "discussion",
      lifecycle: "open",
      waitingOn: "orchestrator",
      counts: { completed: 1 }
    });
    await close();
  });

  it("enforces verify lifecycle transitions and conversation-scope isolation", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, rawCallTool, jobs, close } = await connectTestClient(configFor(root), upstream);

    const started = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "implement and test",
        sessionMode: "new",
        activityTitle: "Verified implementation",
        activityKind: "implementation",
        handoffPolicy: "verify",
        completionTrigger: "sealed-jobs-terminal"
      }
    });
    const activityId = (started as { structuredContent?: Record<string, any> })
      .structuredContent?.bridgeActivity?.activityId;
    const jobId = (started as { structuredContent?: Record<string, any> })
      .structuredContent?.bridgeActivity?.jobId;
    expect(jobs.getActivity(activityId)).toMatchObject({ lifecycle: "open", verification: "not-required" });

    const crossScope = await rawCallTool({
      name: "codex_activity_update",
      arguments: { scopeId: SCOPE_B, activityId, action: "seal" }
    });
    expect(crossScope.isError).toBe(true);
    expect(JSON.stringify(crossScope)).toContain("another conversation scope");

    const sealed = parseToolJson(await client.callTool({
      name: "codex_activity_update",
      arguments: { activityId, action: "seal" }
    }));
    expect(sealed.activity).toMatchObject({
      lifecycle: "sealed",
      waitingOn: "verification",
      verification: "pending",
      completionVersion: 1
    });
    const illegalComplete = await client.callTool({
      name: "codex_activity_update",
      arguments: { activityId, action: "complete" }
    });
    expect(illegalComplete.isError).toBe(true);
    expect(JSON.stringify(illegalComplete)).toContain("Finish Activity verification");

    const verifying = parseToolJson(await client.callTool({
      name: "codex_activity_update",
      arguments: { activityId, action: "start-verification" }
    }));
    expect(verifying.activity).toMatchObject({ verification: "verifying" });
    const passed = parseToolJson(await client.callTool({
      name: "codex_activity_update",
      arguments: {
        activityId,
        action: "verification-passed",
        evidence: {
          summary: "Reviewed the diff and ran the test suite",
          jobIds: [jobId],
          tests: ["npm test: exit 0"]
        }
      }
    }));
    expect(passed.activity).toMatchObject({
      lifecycle: "completed",
      verification: "verified",
      waitingOn: "none"
    });
    await close();
  });

  it("cancels every running child job before cancelling its Activity", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, jobs, close } = await connectTestClient(configFor(root), upstream);
    const running = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "long delegated work",
        sessionMode: "new",
        activityTitle: "Cancelable work",
        executionMode: "background"
      }
    }));

    const cancelled = parseToolJson(await client.callTool({
      name: "codex_activity_update",
      arguments: {
        activityId: running.activityId,
        action: "cancel",
        reason: "The user stopped this Activity"
      }
    }));
    expect(cancelled).toMatchObject({
      action: "cancel",
      activity: {
        lifecycle: "cancelled",
        waitingOn: "none",
        counts: { running: 0, cancelled: 1, terminal: 1 }
      },
      cancelledJobIds: [running.jobId]
    });
    expect(cancelled.warning).toContain("not rolled back");
    expect(upstream.aborts).toBe(1);
    expect(jobs.get(running.jobId)).toMatchObject({ status: "cancelled" });

    const attach = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "must start a new Activity",
        sessionMode: "new",
        activityId: running.activityId
      }
    });
    expect(attach.isError).toBe(true);
    expect(JSON.stringify(attach)).toContain("only to an open Activity");
    await close();
  });

  it("interrupts every exact App Server turn in one Activity even when they share a worker", async () => {
    const root = temporaryRoot();
    const upstream = new MultiTurnAppUpstream();
    const { client, jobs, close } = await connectTestClient(
      configFor(root, {
        CODEX_MCP_BRIDGE_DEFAULT_BACKEND: "app-server",
        CODEX_MCP_BRIDGE_MAX_CONCURRENT_JOBS: "2",
        CODEX_MCP_BRIDGE_UPSTREAM_POOL_SIZE: "2"
      }),
      upstream
    );
    const first = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "first app turn",
        sessionMode: "new",
        executionMode: "background",
        activityTitle: "Parallel App turns"
      }
    }));
    const second = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "second app turn",
        sessionMode: "new",
        executionMode: "background",
        activityId: first.activityId
      }
    }));
    const affected = [first.jobId, second.jobId].sort();
    const turnDetail = parseToolJson(await client.callTool({
      name: "codex_status",
      arguments: { threadId: "app-thread-1" }
    }));
    expect(turnDetail).toMatchObject({
      session: null,
      turns: [expect.objectContaining({ jobId: first.jobId, turnId: "app-turn-1", status: "running" })]
    });

    const stopped = parseToolJson(await client.callTool({
      name: "codex_activity_update",
      arguments: {
        activityId: first.activityId,
        action: "cancel",
        acknowledgeAffectedJobIds: affected
      }
    }));

    expect(upstream.forceCalls.map((call) => call.upstreamRequestId).sort()).toEqual([
      "app-turn-1",
      "app-turn-2"
    ]);
    expect(jobs.get(first.jobId)).toMatchObject({ status: "cancelled" });
    expect(jobs.get(second.jobId)).toMatchObject({ status: "cancelled" });
    expect(stopped).toMatchObject({
      activity: { lifecycle: "cancelled", counts: { cancelled: 2, running: 0 } },
      cancelledJobIds: expect.arrayContaining(affected),
      collateralJobIds: []
    });
    await close();
  });

  it("permits an explicit workspace-write session only in an enabled profile", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, close } = await connectTestClient(
      configFor(root, { CODEX_MCP_BRIDGE_ALLOW_WRITE: "1" }),
      upstream
    );

    await client.callTool({
      name: "codex_task",
      arguments: { prompt: "implement", sessionMode: "new", sandbox: "workspace-write" }
    });
    expect(upstream.calls[0]).toMatchObject({ name: "codex", args: { sandbox: "workspace-write" } });

    await close();
  });

  it("permits danger-full-access while retaining read-only as the omitted default", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, close } = await connectTestClient(
      configFor(root, {
        CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS: "1",
        CODEX_MCP_BRIDGE_APPROVAL_POLICY: "never"
      }),
      upstream
    );

    await client.callTool({
      name: "codex_task",
      arguments: { prompt: "full task", sessionMode: "new", sandbox: "danger-full-access" }
    });
    expect(upstream.calls[0]).toMatchObject({
      name: "codex",
      args: { sandbox: "danger-full-access", "approval-policy": "never" }
    });

    await client.callTool({ name: "codex_task", arguments: { prompt: "inspect", sessionMode: "new" } });
    expect(upstream.calls[1]).toMatchObject({ args: { sandbox: "read-only" } });
    await close();
  });

  it("uses and validates configured or per-call model settings for new sessions", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const config = configFor(root, {
      CODEX_MCP_BRIDGE_DEFAULT_MODEL: "gpt-5.6-sol",
      CODEX_MCP_BRIDGE_DEFAULT_REASONING_EFFORT: "max"
    });
    const { client, close } = await connectTestClient(config, upstream);

    await client.callTool({
      name: "codex_task",
      arguments: { prompt: "default", sessionMode: "new" }
    });
    await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "override",
        sessionMode: "new",
        model: "gpt-5.6-terra",
        reasoningEffort: "medium"
      }
    });
    expect(upstream.calls[0]).toMatchObject({
      args: { model: "gpt-5.6-sol", config: { model_reasoning_effort: "max" } }
    });
    expect(upstream.calls[1]).toMatchObject({
      args: { model: "gpt-5.6-terra", config: { model_reasoning_effort: "medium" } }
    });

    const rejected = await client.callTool({
      name: "codex_task",
      arguments: { prompt: "invalid", sessionMode: "new", model: "gpt-5.5", reasoningEffort: "max" }
    });
    expect(rejected.isError).toBe(true);
    expect(JSON.stringify(rejected)).toContain("does not support reasoning effort");
    expect(upstream.calls).toHaveLength(2);

    await close();
  });

  it("auto mode continues the only compatible session attached to an Activity", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, close } = await connectTestClient(configFor(root), upstream);

    const first = await runTask(client, { prompt: "first" });
    const activityId = taskActivityId(first);
    await runTask(client, { prompt: "follow up", activityId });

    expect(upstream.calls[1]).toEqual({
      name: "codex-reply",
      args: { threadId: "thread-1", prompt: "follow up", _bridgeBackendKind: "mcp-server" }
    });
    expect(taskSession(first)).toMatchObject({ action: "start", reason: "activity-new" });
    await close();
  });

  it("starts a new thread for a new Activity even when the scope has a compatible thread", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, close } = await connectTestClient(configFor(root), upstream);

    await runTask(client, { prompt: "first Activity" });
    await runTask(client, { prompt: "separate Activity" });

    expect(upstream.calls.map((call) => call.name)).toEqual(["codex", "codex"]);
    await close();
  });

  it("does not auto-select a Codex thread from another conversation scope", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, close } = await connectTestClient(configFor(root), upstream);

    const scopeA = await runTask(client, { prompt: "scope A", scopeId: SCOPE_A });
    await runTask(client, { prompt: "scope B", scopeId: SCOPE_B });
    await runTask(client, {
      prompt: "scope A follow-up",
      scopeId: SCOPE_A,
      activityId: taskActivityId(scopeA)
    });

    expect(upstream.calls.map((call) => call.name)).toEqual(["codex", "codex", "codex-reply"]);
    expect(upstream.calls[2]).toMatchObject({
      args: { threadId: "thread-1", prompt: "scope A follow-up" }
    });
    await close();
  });

  it("derives and isolates ChatGPT scopes from host metadata without a model-provided scopeId", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { rawCallTool, close } = await connectTestClient(configFor(root), upstream);
    const metadataA = {
      "openai/organization": "anonymous-org",
      "openai/subject": "anonymous-user",
      "openai/session": "chat-session-a"
    };
    const metadataB = { ...metadataA, "openai/session": "chat-session-b" };

    const started = await rawCallTool({
      name: "codex_task",
      arguments: {
        requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        prompt: "start derived scope",
        sessionMode: "new",
        executionMode: "foreground"
      },
      _meta: metadataA
    });
    const derivedScope = (started as { structuredContent?: Record<string, any> })
      .structuredContent?.bridgeSession?.scopeId;
    expect(derivedScope).toMatch(SCOPE_ID_PATTERN);
    expect(derivedScope).not.toBe(SCOPE_A);

    const retriedWithIgnoredInput = await rawCallTool({
      name: "codex_task",
      arguments: {
        scopeId: SCOPE_B,
        requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        prompt: "start derived scope",
        sessionMode: "new",
        executionMode: "foreground"
      },
      _meta: metadataA
    });
    expect((retriedWithIgnoredInput as { structuredContent?: Record<string, any> }).structuredContent)
      .toEqual((started as { structuredContent?: Record<string, any> }).structuredContent);
    expect(upstream.calls).toHaveLength(1);

    const continued = await rawCallTool({
      name: "codex_task",
      arguments: {
        requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        prompt: "continue derived scope",
        executionMode: "foreground",
        activityId: (started as { structuredContent?: Record<string, any> }).structuredContent
          ?.bridgeActivity?.activityId
      },
      _meta: metadataA
    });
    expect((continued as { structuredContent?: Record<string, any> }).structuredContent)
      .toMatchObject({
        bridgeSession: {
          scopeId: derivedScope,
          action: "continue",
          threadId: "thread-1"
        }
      });

    const statusA = parseToolJson(
      await rawCallTool({ name: "codex_status", arguments: {}, _meta: metadataA })
    );
    const statusB = parseToolJson(
      await rawCallTool({ name: "codex_status", arguments: {}, _meta: metadataB })
    );
    const explicitIgnored = parseToolJson(
      await rawCallTool({
        name: "codex_status",
        arguments: { scopeId: SCOPE_B },
        _meta: metadataA
      })
    );
    const deniedAudit = await rawCallTool({
      name: "codex_status",
      arguments: { includeAllScopes: true },
      _meta: metadataA
    });

    expect(statusA.scopeView).toEqual({
      mode: "scoped",
      scopeId: derivedScope,
      source: "host-metadata",
      keyVersion: 1,
      explicitInputIgnored: false
    });
    expect(statusA.scopeCounts).toMatchObject({ sessions: 1, jobs: 2 });
    expect(statusB.scopeCounts).toMatchObject({ sessions: 0, jobs: 0 });
    expect(explicitIgnored.scopeView).toMatchObject({
      scopeId: derivedScope,
      source: "host-metadata",
      explicitInputIgnored: true
    });
    expect(deniedAudit.isError).toBe(true);
    expect(JSON.stringify(deniedAudit)).toContain("cannot request the bridge-wide audit view");
    expect(JSON.stringify(statusA)).not.toContain("chat-session-a");
    expect(JSON.stringify(statusA)).not.toContain("anonymous-user");
    expect(JSON.stringify(statusA)).not.toContain("anonymous-org");
    await close();
  });

  it("requires an explicit compatibility scope only when host metadata is absent", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { rawCallTool, close } = await connectTestClient(configFor(root), upstream);

    const missing = await rawCallTool({
      name: "codex_task",
      arguments: {
        requestId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        prompt: "missing scope"
      }
    });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing)).toContain("explicit compatibility scopeId");

    const compatible = await rawCallTool({
      name: "codex_task",
      arguments: {
        scopeId: SCOPE_A,
        requestId: "abababab-abab-4aba-8aba-abababababab",
        prompt: "compatibility scope",
        sessionMode: "new"
      }
    });
    expect((compatible as { structuredContent?: Record<string, any> }).structuredContent)
      .toMatchObject({ bridgeSession: { scopeId: SCOPE_A } });
    await close();
  });

  it("uses the same host-derived scope for job cancellation", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { rawCallTool, close } = await connectTestClient(
      configFor(root),
      upstream
    );
    const metadata = { "openai/session": "cancel-session" };
    const started = parseToolJson(
      await rawCallTool({
        name: "codex_task",
        arguments: {
          requestId: "acacacac-acac-4aca-8aca-acacacacacac",
          prompt: "cancel derived job",
          sessionMode: "new"
        },
        _meta: metadata
      })
    );

    const denied = await rawCallTool({
      name: "codex_cancel",
      arguments: { jobId: started.jobId },
      _meta: { "openai/session": "another-cancel-session" }
    });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).toContain("another conversation scope");

    const cancelled = parseToolJson(
      await rawCallTool({
        name: "codex_cancel",
        arguments: { jobId: started.jobId },
        _meta: metadata
      })
    );
    expect(cancelled.status).toBe("cancelled");
    await close();
  });

  it("normalizes UUID casing before routing sessions", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, close } = await connectTestClient(configFor(root), upstream);

    const started = await client.callTool({
      name: "codex_task",
      arguments: {
        scopeId: UPPERCASE_SCOPE,
        prompt: "start",
        sessionMode: "new"
      }
    });
    expect((started as { structuredContent?: Record<string, any> }).structuredContent).toMatchObject({
      bridgeSession: { scopeId: UPPERCASE_SCOPE.toLowerCase() }
    });
    const status = parseToolJson(
      await client.callTool({
        name: "codex_status",
        arguments: { scopeId: UPPERCASE_SCOPE.toLowerCase() }
      })
    );
    expect(status.sessions).toHaveLength(1);
    await close();
  });

  it("requires an exact thread after parallel work creates multiple compatible sessions", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, close } = await connectTestClient(configFor(root), upstream);

    const plan = await runTask(client, { prompt: "plan" });
    const activityId = taskActivityId(plan);
    await runTask(client, { prompt: "build", sessionMode: "new", activityId });
    const ambiguous = await client.callTool({
      name: "codex_task",
      arguments: { prompt: "which thread?", activityId }
    });
    expect(ambiguous.isError).toBe(true);
    expect(JSON.stringify(ambiguous)).toContain("Multiple compatible Codex threads");
    expect(JSON.stringify(ambiguous)).toContain("thread-1");
    expect(JSON.stringify(ambiguous)).toContain("thread-2");

    await runTask(client, {
      prompt: "refine plan",
      sessionMode: "continue",
      threadId: "thread-1",
      activityId
    });
    await runTask(client, {
      prompt: "continue build",
      sessionMode: "continue",
      threadId: "thread-2",
      activityId
    });

    expect(upstream.calls.slice(2)).toEqual([
      {
        name: "codex-reply",
        args: {
          threadId: "thread-1",
          prompt: "refine plan",
          _bridgeBackendKind: "mcp-server"
        }
      },
      {
        name: "codex-reply",
        args: {
          threadId: "thread-2",
          prompt: "continue build",
          _bridgeBackendKind: "mcp-server"
        }
      }
    ]);
    await close();
  });

  it("deduplicates request retries and rejects request-id reuse with changed arguments", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, close } = await connectTestClient(
      configFor(root),
      upstream
    );
    const requestId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const arguments_ = {
      scopeId: SCOPE_A,
      requestId,
      prompt: "one logical task",
      sessionMode: "new",
      activityTitle: "Deduplicated Activity",
      activityKind: "investigation" as const,
      executionMode: "background" as const
    };

    const first = parseToolJson(
      await client.callTool({ name: "codex_task", arguments: arguments_ })
    );
    const retry = parseToolJson(
      await client.callTool({ name: "codex_task", arguments: arguments_ })
    );
    expect(retry.jobId).toBe(first.jobId);
    expect(retry.activityId).toBe(first.activityId);
    expect(upstream.calls).toHaveLength(1);

    const changed = await client.callTool({
      name: "codex_task",
      arguments: { ...arguments_, prompt: "changed task" }
    });
    expect(changed.isError).toBe(true);
    expect(JSON.stringify(changed)).toContain("already used for a different Codex task");
    const changedActivity = await client.callTool({
      name: "codex_task",
      arguments: { ...arguments_, activityTitle: "Different Activity" }
    });
    expect(changedActivity.isError).toBe(true);
    expect(JSON.stringify(changedActivity)).toContain("already used for a different Codex task");

    upstream.resolveNext(fakeCodexResult("deduped-thread"));
    await waitForJobStatus(client, first.jobId, "completed");
    const completedRetry = await client.callTool({ name: "codex_task", arguments: arguments_ });
    expect(
      (completedRetry as { structuredContent?: Record<string, any> }).structuredContent
    ).toMatchObject({
      threadId: "deduped-thread",
      bridgeSession: { scopeId: SCOPE_A, requestId },
      bridgeActivity: {
        activityId: first.activityId,
        jobId: first.jobId,
        executionMode: "background",
        shouldRenderActivityCard: true
      }
    });
    expect(upstream.calls).toHaveLength(1);
    await close();
  });

  it("keeps an omitted-session-mode retry stable after saved settings change", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const config = configFor(root);
    const settings = new UserSettingsStore(config);
    const { rawCallTool, close } = await connectTestClient(
      config,
      upstream,
      undefined,
      new FakeModelCatalog(),
      settings
    );
    const arguments_ = {
      scopeId: SCOPE_A,
      requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      prompt: "same raw request with an omitted mode"
    };

    const first = await rawCallTool({ name: "codex_task", arguments: arguments_ });
    settings.update({ uiLocalePreference: "ko" }, 0);
    const retry = await rawCallTool({ name: "codex_task", arguments: arguments_ });

    const firstStructured = (first as { structuredContent?: Record<string, any> }).structuredContent!;
    const retryStructured = (retry as { structuredContent?: Record<string, any> }).structuredContent!;
    expect(retryStructured.bridgeActivity).toMatchObject({
      activityId: firstStructured.bridgeActivity.activityId,
      jobId: firstStructured.bridgeActivity.jobId,
      executionMode: "background"
    });
    expect(retryStructured.bridgeSession).toMatchObject({
      scopeId: SCOPE_A,
      requestId: arguments_.requestId
    });
    expect(upstream.calls).toHaveLength(1);
    await close();
  });

  it("requires explicit adoption before moving a thread across scopes", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, close } = await connectTestClient(configFor(root), upstream);
    await runTask(client, { prompt: "start", sessionMode: "new", scopeId: SCOPE_A });

    const denied = await client.callTool({
      name: "codex_task",
      arguments: {
        scopeId: SCOPE_B,
        prompt: "take over",
        sessionMode: "continue",
        threadId: "thread-1"
      }
    });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).toContain("another conversation scope");

    await client.callTool({
      name: "codex_task",
      arguments: {
        scopeId: SCOPE_B,
        prompt: "take over",
        sessionMode: "continue",
        threadId: "thread-1",
        adoptThread: true
      }
    });
    const statusA = parseToolJson(
      await client.callTool({ name: "codex_status", arguments: { scopeId: SCOPE_A } })
    );
    const statusB = parseToolJson(
      await client.callTool({ name: "codex_status", arguments: { scopeId: SCOPE_B } })
    );
    expect(statusA.sessions).toEqual([]);
    expect(statusB.sessions).toEqual([
      expect.objectContaining({ threadId: "thread-1", scopeId: SCOPE_B })
    ]);
    await close();
  });

  it("filters status details by scope and exposes all scopes only on explicit audit", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, rawCallTool, close } = await connectTestClient(configFor(root), upstream);
    await runTask(client, { prompt: "A", sessionMode: "new", scopeId: SCOPE_A });
    await runTask(client, { prompt: "B", sessionMode: "new", scopeId: SCOPE_B });

    const statusA = parseToolJson(
      await client.callTool({ name: "codex_status", arguments: { scopeId: SCOPE_A } })
    );
    const statusB = parseToolJson(
      await client.callTool({ name: "codex_status", arguments: { scopeId: SCOPE_B } })
    );
    const policyOnly = parseToolJson(
      await rawCallTool({ name: "codex_status", arguments: {} })
    );
    const audit = parseToolJson(
      await rawCallTool({ name: "codex_status", arguments: { includeAllScopes: true } })
    );

    expect(statusA.sessions.map((session: { threadId: string }) => session.threadId)).toEqual([
      "thread-1"
    ]);
    expect(statusB.sessions.map((session: { threadId: string }) => session.threadId)).toEqual([
      "thread-2"
    ]);
    expect(policyOnly).toMatchObject({
      scopeView: {
        mode: "policy-only",
        hostMetadataOrCompatibilityScopeRequiredForDetails: true
      },
      sessions: [],
      jobs: []
    });
    expect(audit.sessions).toHaveLength(2);
    expect(audit.jobs).toHaveLength(2);
    await close();
  });

  it("reports scoped totals independently from paginated session and job pages", async () => {
    const root = temporaryRoot();
    const sessions = new SessionRegistry();
    const now = Date.now();
    for (let index = 0; index < 11; index += 1) {
      sessions.record({
        threadId: `scope-a-thread-${index}`,
        scopeId: SCOPE_A,
        cwd: realpathSync(root),
        sandbox: "read-only",
        createdAt: now + index,
        lastUsedAt: now + index
      });
    }
    sessions.record({
      threadId: "scope-b-thread",
      scopeId: SCOPE_B,
      cwd: realpathSync(root),
      sandbox: "read-only",
      createdAt: now + 20,
      lastUsedAt: now + 20
    });
    const upstream = new FakeUpstream();
    const { client, close } = await connectTestClient(configFor(root), upstream, sessions);
    await runTask(client, { prompt: "job one", sessionMode: "new", scopeId: SCOPE_A });
    await runTask(client, { prompt: "job two", sessionMode: "new", scopeId: SCOPE_A });
    await runTask(client, { prompt: "job three", sessionMode: "new", scopeId: SCOPE_A });
    await runTask(client, { prompt: "other job", sessionMode: "new", scopeId: SCOPE_B });

    const firstPage = parseToolJson(
      await client.callTool({
        name: "codex_status",
        arguments: { scopeId: SCOPE_A, sessionLimit: 10, jobLimit: 2 }
      })
    );
    expect(firstPage.pagination.sessions.nextCursor).toEqual(expect.any(String));
    expect(firstPage.pagination.jobs.nextCursor).toEqual(expect.any(String));
    const secondPage = parseToolJson(
      await client.callTool({
        name: "codex_status",
        arguments: {
          scopeId: SCOPE_A,
          sessionLimit: 10,
          sessionCursor: firstPage.pagination.sessions.nextCursor,
          jobLimit: 2,
          jobCursor: firstPage.pagination.jobs.nextCursor
        }
      })
    );

    expect(firstPage.scopeCounts).toEqual({ sessions: 14, activities: 3, jobs: 3, runningJobs: 0 });
    expect(firstPage.sessions).toHaveLength(10);
    expect(firstPage.jobs).toHaveLength(2);
    expect(firstPage.pagination).toMatchObject({
      sessions: { offset: 0, returned: 10, total: 14, hasMore: true, nextOffset: 10 },
      jobs: { offset: 0, returned: 2, total: 3, hasMore: true, nextOffset: 2 }
    });
    expect(secondPage.sessions).toHaveLength(4);
    expect(secondPage.jobs).toHaveLength(1);
    expect(secondPage.pagination).toMatchObject({
      sessions: { offset: 10, returned: 4, total: 14, hasMore: false, nextOffset: null },
      jobs: { offset: 2, returned: 1, total: 3, hasMore: false, nextOffset: null }
    });
    const malformed = await client.callTool({
      name: "codex_status",
      arguments: { scopeId: SCOPE_A, sessionCursor: "not-a-valid-cursor" }
    });
    expect(malformed.isError).toBe(true);
    expect(JSON.stringify(malformed)).toContain("Invalid or mismatched sessions pagination cursor");
    await close();
  });

  it("reuses one thread across separate Activities and returns exact thread turns", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, close } = await connectTestClient(configFor(root), upstream);
    const firstResult = await client.callTool({
      name: "codex_task",
      arguments: { prompt: "first intent", sessionMode: "new", activityTitle: "First Activity" }
    });
    const first = (firstResult as { structuredContent?: Record<string, any> }).structuredContent
      ?.bridgeActivity;
    const secondResult = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "reuse the thread for a separate intent",
        sessionMode: "continue",
        threadId: "thread-1",
        activityTitle: "Second Activity"
      }
    });
    const second = (secondResult as { structuredContent?: Record<string, any> }).structuredContent
      ?.bridgeActivity;
    expect(first.activityId).not.toBe(second.activityId);

    const detail = parseToolJson(await client.callTool({
      name: "codex_status",
      arguments: { threadId: "thread-1" }
    }));
    expect(detail.activities.map((activity: { activityId: string }) => activity.activityId).sort()).toEqual(
      [first.activityId, second.activityId].sort()
    );
    expect(detail.jobs).toHaveLength(2);
    const firstJobDetail = parseToolJson(await client.callTool({
      name: "codex_status",
      arguments: { jobId: first.jobId }
    }));
    expect(firstJobDetail).toMatchObject({
      jobId: first.jobId,
      threadId: "thread-1",
      session: { threadId: "thread-1" }
    });
    expect(detail.turns).toEqual([
      expect.objectContaining({ jobId: first.jobId, turnId: null, status: "completed" }),
      expect.objectContaining({ jobId: second.jobId, turnId: null, status: "completed" })
    ]);
    await close();
  });

  it("uses codex_status as the card data/watch API and keeps private paths relative", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, close } = await connectTestClient(
      configFor(root),
      upstream
    );
    const started = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "watch this Activity",
        sessionMode: "new",
        executionMode: "background",
        activityTitle: "Watched Activity"
      }
    }));
    const rendered = await client.callTool({
      name: "codex_activity",
      arguments: { scopeId: SCOPE_A },
      _meta: { "openai/locale": "ko-KR", "openai/widgetSessionId": "widget-render" }
    });
    const initial = (rendered as { structuredContent?: Record<string, any> }).structuredContent!;
    expect(initial.activities).toEqual([
      expect.objectContaining({ activityId: started.activityId, lifecycle: "open" })
    ]);
    expect((rendered as { _meta?: Record<string, any> })._meta).toMatchObject({
      "openai/locale": "ko",
      hostLocale: "ko-KR"
    });
    const privateJson = JSON.stringify((rendered as { _meta?: Record<string, any> })._meta?.activityDetails);
    expect(privateJson).not.toContain(root);
    expect(privateJson).toContain(path.basename(root));

    const watchPromise = client.callTool({
      name: "codex_status",
      arguments: {
        scopeId: SCOPE_A,
        activityView: true,
        afterVersion: initial.scopeVersion,
        waitFor: "change",
        waitMs: 1_000
      },
      _meta: { "openai/widgetSessionId": "widget-watch" }
    });
    await Promise.resolve();
    upstream.progressNext({
      progress: 1,
      total: 2,
      message: "public progress",
      event: {
        eventId: "public-progress-1",
        type: "turn",
        phase: "updated",
        createdAt: Date.now(),
        summary: "Public progress"
      }
    } as Progress);
    const watched = await watchPromise;
    const next = (watched as { structuredContent?: Record<string, any> }).structuredContent!;
    expect(next.scopeVersion).toBeGreaterThan(initial.scopeVersion);
    expect(next.wait).toMatchObject({ changed: true, timedOut: false });
    expect(next.activities[0].jobs[0]).toMatchObject({ status: "running", progressObserved: true });

    upstream.resolveNext(fakeCodexResult("watched-thread"));
    await waitForJobStatus(client, started.jobId, "completed");
    await close();
  });

  it("leases one Activity completion batch to only one mounted card", async () => {
    const root = temporaryRoot();
    const config = configFor(root);
    const settings = new UserSettingsStore(config);
    settings.update({ completionHandoff: "auto-handoff" });
    const { client, rawCallTool, close } = await connectTestClient(
      config,
      new FakeUpstream(),
      undefined,
      new FakeModelCatalog(),
      settings
    );
    const createNotifyActivity = async (prompt: string, title: string) => {
      const result = await client.callTool({
        name: "codex_task",
        arguments: {
          prompt,
          sessionMode: "new",
          activityTitle: title,
          handoffPolicy: "notify",
          completionTrigger: "sealed-jobs-terminal"
        }
      });
      const activity = (result as { structuredContent?: Record<string, any> }).structuredContent
        ?.bridgeActivity;
      await client.callTool({
        name: "codex_activity_update",
        arguments: { activityId: activity.activityId, action: "seal" }
      });
      return activity;
    };
    const started = await createNotifyActivity(
      "notification payload must not be copied",
      "Notify once"
    );
    const secondActivity = await createNotifyActivity("second private payload", "Notify twice");
    const view = await client.callTool({
      name: "codex_activity",
      arguments: { scopeId: SCOPE_A }
    });
    const pending = (view as { structuredContent?: Record<string, any> }).structuredContent?.pendingHandoffs;
    expect(pending).toEqual(expect.arrayContaining([
      expect.objectContaining({ activityId: started.activityId, channel: "notify" }),
      expect.objectContaining({ activityId: secondActivity.activityId, channel: "notify" })
    ]));
    const outboxIds = pending.map((event: Record<string, any>) => event.outboxId);

    const first = parseToolJson(await rawCallTool({
      name: "codex_activity_handoff",
      arguments: { scopeId: SCOPE_A, action: "claim-batch", outboxIds },
      _meta: { "openai/widgetSessionId": "widget-one" }
    }));
    const second = parseToolJson(await rawCallTool({
      name: "codex_activity_handoff",
      arguments: { scopeId: SCOPE_A, action: "claim-batch", outboxIds },
      _meta: { "openai/widgetSessionId": "widget-two" }
    }));
    expect(first).toMatchObject({
      claimed: true,
      origin: "activity-handoff",
      handoffDepth: 1,
      handoffBatchId: expect.stringMatching(/^handoff-/),
      events: expect.arrayContaining([
        expect.objectContaining({ outboxId: outboxIds[0] }),
        expect.objectContaining({ outboxId: outboxIds[1] })
      ])
    });
    expect(second).toMatchObject({ claimed: false, handoffDepth: 0, events: [] });
    expect(JSON.stringify(first)).not.toContain("notification payload must not be copied");

    const failedBatch = await rawCallTool({
      name: "codex_activity_handoff",
      arguments: {
        scopeId: SCOPE_A,
        action: "delivered-batch",
        outboxIds: [outboxIds[0], 999_999_999]
      },
      _meta: { "openai/widgetSessionId": "widget-one" }
    });
    expect(failedBatch.isError).toBe(true);
    await rawCallTool({
      name: "codex_activity_handoff",
      arguments: { scopeId: SCOPE_A, action: "release-batch", outboxIds },
      _meta: { "openai/widgetSessionId": "widget-one" }
    });
    const reclaimed = parseToolJson(await rawCallTool({
      name: "codex_activity_handoff",
      arguments: { scopeId: SCOPE_A, action: "claim-batch", outboxIds },
      _meta: { "openai/widgetSessionId": "widget-two" }
    }));
    expect(reclaimed.events).toHaveLength(2);
    await rawCallTool({
      name: "codex_activity_handoff",
      arguments: { scopeId: SCOPE_A, action: "delivered-batch", outboxIds },
      _meta: { "openai/widgetSessionId": "widget-two" }
    });
    const after = await client.callTool({ name: "codex_activity", arguments: { scopeId: SCOPE_A } });
    expect((after as { structuredContent?: Record<string, any> }).structuredContent?.pendingHandoffs).toEqual([]);
    await close();
  });

  it("auto mode starts new when cwd, sandbox, or model is incompatible", async () => {
    const first = temporaryRoot();
    const second = temporaryRoot();
    const upstream = new FakeUpstream();
    const config = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ROOTS: `${first},${second}`,
      CODEX_MCP_BRIDGE_ALLOW_WRITE: "1",
      CODEX_MCP_BRIDGE_DEFAULT_MODEL: "gpt-5.6-sol"
    });
    const { client, close } = await connectTestClient(config, upstream);

    await runTask(client, { prompt: "first", sessionMode: "new", cwd: first });
    await runTask(client, { prompt: "other cwd", cwd: second });
    await runTask(client, { prompt: "write", cwd: first, sandbox: "workspace-write" });
    await runTask(client, { prompt: "other model", cwd: first, model: "gpt-5.6-terra" });

    expect(upstream.calls.map((call) => call.name)).toEqual(["codex", "codex", "codex", "codex"]);
    await close();
  });

  it("sessionMode=new always starts fresh even when a compatible session exists", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, close } = await connectTestClient(configFor(root), upstream);

    await runTask(client, { prompt: "first", sessionMode: "new" });
    await runTask(client, { prompt: "fresh", sessionMode: "new" });
    expect(upstream.calls.map((call) => call.name)).toEqual(["codex", "codex"]);

    await close();
  });

  it("continues an exact tracked thread and rejects unknown or conflicting continuation inputs", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, close } = await connectTestClient(configFor(root), upstream);
    await runTask(client, { prompt: "first", sessionMode: "new" });

    await runTask(client, {
      prompt: "continue",
      sessionMode: "continue",
      threadId: "thread-1"
    });
    expect(upstream.calls[1]).toEqual({
      name: "codex-reply",
      args: { threadId: "thread-1", prompt: "continue", _bridgeBackendKind: "mcp-server" }
    });

    const unknown = await client.callTool({
      name: "codex_task",
      arguments: { prompt: "continue", sessionMode: "continue", threadId: "missing" }
    });
    expect(unknown.isError).toBe(true);

    const modelChange = await client.callTool({
      name: "codex_task",
      arguments: {
        prompt: "switch",
        sessionMode: "continue",
        threadId: "thread-1",
        model: "gpt-5.6-terra"
      }
    });
    expect(modelChange.isError).toBe(true);
    expect(JSON.stringify(modelChange)).toContain("cannot change");

    await close();
  });

  it("requires an explicit write sandbox when continuing a write thread", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, close } = await connectTestClient(
      configFor(root, { CODEX_MCP_BRIDGE_ALLOW_WRITE: "1" }),
      upstream
    );
    await runTask(client, {
      prompt: "write",
      sessionMode: "new",
      sandbox: "workspace-write"
    });

    const denied = await client.callTool({
      name: "codex_task",
      arguments: { prompt: "more", sessionMode: "continue", threadId: "thread-1" }
    });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).toContain("requires sandbox='workspace-write'");

    await runTask(client, {
      prompt: "more",
      sessionMode: "continue",
      threadId: "thread-1",
      sandbox: "workspace-write"
    });
    expect(upstream.calls[1]?.name).toBe("codex-reply");

    await close();
  });

  it("requires an explicit danger sandbox when continuing a full-access thread", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, close } = await connectTestClient(
      configFor(root, { CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS: "1" }),
      upstream
    );
    await runTask(client, {
      prompt: "full task",
      sessionMode: "new",
      sandbox: "danger-full-access"
    });

    const denied = await client.callTool({
      name: "codex_task",
      arguments: { prompt: "more", sessionMode: "continue", threadId: "thread-1" }
    });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).toContain("requires sandbox='danger-full-access'");

    await runTask(client, {
      prompt: "more",
      sessionMode: "continue",
      threadId: "thread-1",
      sandbox: "danger-full-access"
    });
    expect(upstream.calls[1]?.name).toBe("codex-reply");

    await close();
  });

  it("returns session summaries from codex_status", async () => {
    const root = temporaryRoot();
    const { client, close } = await connectTestClient(configFor(root), new FakeUpstream());
    await runTask(client, { prompt: "first", sessionMode: "new" });

    const status = parseToolJson(await client.callTool({ name: "codex_status", arguments: {} }));
    expect(status.sessions).toHaveLength(1);
    expect(status.sessions[0]).toMatchObject({
      threadId: "thread-1",
      cwd: realpathSync(root),
      sandbox: "read-only",
      resumeAvailability: "unknown"
    });

    await close();
  });

  it("returns a background task immediately and retrieves completion through codex_status", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, close } = await connectTestClient(
      configFor(root),
      upstream
    );

    const started = parseToolJson(
      await Promise.race([
        client.callTool({
        name: "codex_task",
        arguments: { prompt: "slow", sessionMode: "new" }
        }),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("Background codex_task did not return immediately.")), 500)
        )
      ])
    );
    expect(started).toMatchObject({
      status: "running",
      operation: "start",
      executionMode: "background",
      nextAction: { tool: "codex_activity", callOnce: true },
      bridgeActivity: { shouldRenderActivityCard: true }
    });
    upstream.resolveNext();

    const completed = await waitForJobStatus(client, started.jobId, "completed");
    expect(completed.operation).toBe("start");
    expect(JSON.stringify(completed.result)).toContain("thread-1");
    await close();
  });

  it("long-polls one existing status call until the job becomes terminal", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, close } = await connectTestClient(
      configFor(root),
      upstream
    );
    const started = parseToolJson(
      await client.callTool({ name: "codex_task", arguments: { prompt: "slow", sessionMode: "new" } })
    );

    const waiting = client.callTool({
      name: "codex_status",
      arguments: { jobId: started.jobId, waitFor: "terminal", waitMs: 1000 }
    });
    setTimeout(() => upstream.resolveNext(), 10);
    const completed = parseToolJson(await waiting);

    expect(completed).toMatchObject({
      status: "completed",
      terminal: true,
      wait: { waitFor: "terminal", timedOut: false, changed: true }
    });
    await close();
  });

  it("long-polls until an upstream progress notification changes the job", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, close } = await connectTestClient(
      configFor(root),
      upstream
    );
    const started = parseToolJson(
      await client.callTool({ name: "codex_task", arguments: { prompt: "slow", sessionMode: "new" } })
    );

    const waiting = client.callTool({
      name: "codex_status",
      arguments: { jobId: started.jobId, waitFor: "change", waitMs: 1000 }
    });
    setTimeout(
      () => upstream.progressNext({ progress: 3, total: 10, message: "editing files" }),
      10
    );
    const changed = parseToolJson(await waiting);

    expect(changed).toMatchObject({
      status: "running",
      terminal: false,
      version: 3,
      progressObserved: true,
      lastProgress: { progress: 3, total: 10, message: "editing files" },
      wait: { waitFor: "change", timedOut: false, changed: true }
    });
    upstream.resolveNext();
    await waitForJobStatus(client, started.jobId, "completed");
    await close();
  });

  it("returns a bounded timeout without changing a still-running job", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, close } = await connectTestClient(
      configFor(root, {
        CODEX_MCP_BRIDGE_JOB_STALE_AFTER_MS: "1"
      }),
      upstream
    );
    const started = parseToolJson(
      await client.callTool({ name: "codex_task", arguments: { prompt: "slow", sessionMode: "new" } })
    );
    const status = parseToolJson(
      await client.callTool({
        name: "codex_status",
        arguments: { jobId: started.jobId, waitFor: "terminal", waitMs: 10 }
      })
    );

    expect(status).toMatchObject({
      status: "running",
      health: "no-progress-observed",
      wait: { waitFor: "terminal", timedOut: true, changed: false }
    });
    upstream.resolveNext();
    await waitForJobStatus(client, started.jobId, "completed");
    await close();
  });

  it("cancels only a job owned by the supplied scope and forwards an abort signal", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, close } = await connectTestClient(
      configFor(root),
      upstream
    );
    const started = parseToolJson(
      await client.callTool({ name: "codex_task", arguments: { prompt: "cancel me", sessionMode: "new" } })
    );

    const denied = await client.callTool({
      name: "codex_cancel",
      arguments: { scopeId: SCOPE_B, jobId: started.jobId }
    });
    expect(denied.isError).toBe(true);
    expect(upstream.aborts).toBe(0);

    const cancelled = parseToolJson(
      await client.callTool({
        name: "codex_cancel",
        arguments: { scopeId: SCOPE_A, jobId: started.jobId }
      })
    );
    expect(cancelled).toMatchObject({ status: "cancelled", terminal: true });
    expect(cancelled.error).toContain("Partial filesystem changes may remain");
    expect(upstream.aborts).toBe(1);

    const repeated = parseToolJson(
      await client.callTool({
        name: "codex_cancel",
        arguments: { scopeId: SCOPE_A, jobId: started.jobId }
      })
    );
    expect(repeated.status).toBe("cancelled");
    expect(upstream.aborts).toBe(1);
    await close();
  });

  it("requires stale-version and shared-worker confirmation before atomic force-stop reconcile", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, jobs, close } = await connectTestClient(
      configFor(root, {
        CODEX_MCP_BRIDGE_MAX_CONCURRENT_JOBS: "2",
        CODEX_MCP_BRIDGE_UPSTREAM_POOL_SIZE: "2"
      }),
      upstream
    );
    const first = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: { prompt: "target", sessionMode: "new", executionMode: "background" }
    }));
    const second = parseToolJson(await client.callTool({
      name: "codex_task",
      arguments: { prompt: "collateral", sessionMode: "new", executionMode: "background" }
    }));
    await Promise.resolve();
    const current = jobs.get(first.jobId)!;

    const stale = await client.callTool({
      name: "codex_cancel",
      arguments: { scopeId: SCOPE_A, jobId: first.jobId, expectedVersion: current.version - 1 }
    });
    expect(stale.isError).toBe(true);
    expect(JSON.stringify(stale)).toContain("version changed");
    expect(upstream.aborts).toBe(0);

    const unconfirmed = await client.callTool({
      name: "codex_cancel",
      arguments: { scopeId: SCOPE_A, jobId: first.jobId, expectedVersion: current.version }
    });
    expect(unconfirmed.isError).toBe(true);
    expect(JSON.stringify(unconfirmed)).toContain("acknowledgeAffectedJobIds");
    expect(upstream.aborts).toBe(0);

    const affected = [first.jobId, second.jobId].sort();
    const stopped = parseToolJson(await client.callTool({
      name: "codex_cancel",
      arguments: {
        scopeId: SCOPE_A,
        jobId: first.jobId,
        expectedVersion: current.version,
        acknowledgeAffectedJobIds: affected
      }
    }));
    expect(stopped).toMatchObject({ status: "cancelled", processLiveness: "worker-lost" });
    expect(jobs.get(first.jobId)).toMatchObject({ status: "cancelled", trackingState: "worker-lost" });
    expect(jobs.get(second.jobId)).toMatchObject({
      status: "interrupted",
      trackingState: "worker-lost",
      error: expect.stringContaining(`force-stopped job ${first.jobId}`)
    });
    expect(upstream.aborts).toBe(1);
    await close();
  });

  it("requires wait options to target a specific job", async () => {
    const root = temporaryRoot();
    const { client, close } = await connectTestClient(configFor(root), new FakeUpstream());

    const missingJob = await client.callTool({
      name: "codex_status",
      arguments: { waitFor: "terminal", waitMs: 10 }
    });
    const missingMode = await client.callTool({
      name: "codex_status",
      arguments: { jobId: "missing", waitMs: 10 }
    });

    expect(JSON.stringify(missingJob)).toContain("require a jobId");
    expect(JSON.stringify(missingMode)).toContain("waitMs requires waitFor");
    await close();
  });

  it("reports a failed slow task through codex_status", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, close } = await connectTestClient(
      configFor(root),
      upstream
    );
    const started = parseToolJson(
      await client.callTool({ name: "codex_task", arguments: { prompt: "slow", sessionMode: "new" } })
    );
    upstream.rejectNext(new Error("boom"));

    const failed = await waitForJobStatus(client, started.jobId, "failed");
    expect(failed.error).toContain("boom");
    await close();
  });

  it("bounds retained job results without losing the completed session", async () => {
    const root = temporaryRoot();
    const { client, close } = await connectTestClient(
      configFor(root, { CODEX_MCP_BRIDGE_MAX_JOB_RESULT_BYTES: "200" }),
      new LargeResultUpstream()
    );

    const result = parseToolJson(
      await client.callTool({
        name: "codex_task",
        arguments: { prompt: "large", sessionMode: "new", executionMode: "foreground" }
      })
    );
    expect(result).toMatchObject({
      status: "completed",
      resultOmitted: true,
      maxRetainedBytes: 200,
      threadId: "large-thread"
    });

    const status = parseToolJson(await client.callTool({ name: "codex_status", arguments: {} }));
    expect(status.sessions[0]).toMatchObject({ threadId: "large-thread" });
    expect(status.jobs[0]).toMatchObject({ status: "completed", resultOmitted: true });
    await close();
  });

  it("does not auto-resume a persisted thread from an unavailable worker generation", async () => {
    const root = temporaryRoot();
    const sessions = new SessionRegistry();
    const now = Date.now();
    sessions.record({
      threadId: "stale-thread",
      scopeId: SCOPE_A,
      cwd: realpathSync(root),
      sandbox: "read-only",
      createdAt: now,
      lastUsedAt: now
    });
    const upstream = new RestartAwareUpstream(new Set(["stale-thread"]));
    const { client, close } = await connectTestClient(configFor(root), upstream, sessions);

    const before = parseToolJson(await client.callTool({ name: "codex_status", arguments: {} }));
    expect(before.sessions[0]).toMatchObject({
      threadId: "stale-thread",
      resumeAvailability: "unavailable-after-worker-restart"
    });

    const explicit = await client.callTool({
      name: "codex_task",
      arguments: { prompt: "continue stale", sessionMode: "continue", threadId: "stale-thread" }
    });
    expect(explicit.isError).toBe(true);
    expect(JSON.stringify(explicit)).toContain("earlier MCP worker generation");
    expect(upstream.calls).toHaveLength(0);

    const restarted = await client.callTool({
      name: "codex_task",
      arguments: { prompt: "start after restart", executionMode: "foreground" }
    });
    expect(restarted.isError).not.toBe(true);
    expect((restarted as { structuredContent?: Record<string, any> }).structuredContent?.bridgeSession)
      .toMatchObject({ action: "start", reason: "activity-new", threadId: "thread-1" });
    expect(upstream.calls.map((call) => call.name)).toEqual(["codex"]);
    await close();
  });

  it("requires cwd for multiple roots and rejects paths outside allowed roots", async () => {
    const first = temporaryRoot();
    const second = temporaryRoot();
    const outside = temporaryRoot();
    const config = loadConfig({
      CODEX_MCP_BRIDGE_NO_AUTH: "1",
      CODEX_MCP_BRIDGE_ROOTS: `${first},${second}`
    });
    const { client, close } = await connectTestClient(config, new FakeUpstream());

    const missing = await client.callTool({
      name: "codex_task",
      arguments: { prompt: "inspect", sessionMode: "new" }
    });
    expect(JSON.stringify(missing)).toContain("cwd is required");
    const denied = await client.callTool({
      name: "codex_task",
      arguments: { prompt: "inspect", sessionMode: "new", cwd: outside }
    });
    expect(JSON.stringify(denied)).toContain("outside allowed roots");
    await close();
  });

  it("blocks sensitive files on start and rechecks before continuation", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, close } = await connectTestClient(configFor(root), upstream);
    await runTask(client, { prompt: "first", sessionMode: "new" });
    writeFileSync(path.join(root, ".env"), "TOKEN=secret\n");

    const continued = await client.callTool({
      name: "codex_task",
      arguments: { prompt: "continue", sessionMode: "continue", threadId: "thread-1" }
    });
    expect(continued.isError).toBe(true);
    expect(upstream.calls).toHaveLength(1);
    await close();
  });

  it("can explicitly disable the sensitive-file preflight", async () => {
    const root = temporaryRoot();
    writeFileSync(path.join(root, ".env"), "TOKEN=secret\n");
    const upstream = new FakeUpstream();
    const { client, close } = await connectTestClient(
      configFor(root, { CODEX_MCP_BRIDGE_DISABLE_SECRET_SCAN: "1" }),
      upstream
    );

    await runTask(client, { prompt: "inspect", sessionMode: "new" });
    expect(upstream.calls).toHaveLength(1);
    await close();
  });

  it("rejects oversized prompts", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, close } = await connectTestClient(
      configFor(root, { CODEX_MCP_BRIDGE_MAX_PROMPT_CHARS: "5" }),
      upstream
    );

    const result = await client.callTool({ name: "codex_task", arguments: { prompt: "123456" } });
    expect(result.isError).toBe(true);
    expect(upstream.calls).toHaveLength(0);
    await close();
  });

  it("does not expose or apply a Codex execution timeout", async () => {
    const root = temporaryRoot();
    const upstream = new FakeUpstream();
    const { client, close } = await connectTestClient(configFor(root), upstream);

    const result = await client.callTool({
      name: "codex_task",
      arguments: { prompt: "inspect", timeoutMs: 10800001 }
    });
    expect(result.isError).not.toBe(true);
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]?.args).not.toHaveProperty("timeoutMs");
    await close();
  });

  it("limits total concurrent jobs", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, close } = await connectTestClient(
      configFor(root, {
        CODEX_MCP_BRIDGE_MAX_CONCURRENT_JOBS: "1"
      }),
      upstream
    );

    const first = parseToolJson(
      await client.callTool({ name: "codex_task", arguments: { prompt: "slow", sessionMode: "new" } })
    );
    const second = await client.callTool({
      name: "codex_task",
      arguments: { prompt: "second", sessionMode: "new" }
    });
    expect(second.isError).toBe(true);
    expect(upstream.calls).toHaveLength(1);
    upstream.resolveNext();
    await waitForJobStatus(client, first.jobId, "completed");
    await close();
  });

  it("applies the saved concurrency limit below the owner maximum", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const config = configFor(root, {
      CODEX_MCP_BRIDGE_MAX_CONCURRENT_JOBS: "2",
      CODEX_MCP_BRIDGE_UPSTREAM_POOL_SIZE: "2"
    });
    const settings = new UserSettingsStore(config);
    settings.update({ maxConcurrentJobs: 1 });
    const { client, close } = await connectTestClient(
      config,
      upstream,
      undefined,
      new FakeModelCatalog(),
      settings
    );

    const first = parseToolJson(
      await client.callTool({ name: "codex_task", arguments: { prompt: "slow", sessionMode: "new" } })
    );
    const second = await client.callTool({
      name: "codex_task",
      arguments: { prompt: "second", sessionMode: "new" }
    });
    expect(second.isError).toBe(true);
    expect(JSON.stringify(second)).toContain("configured limit is 1");
    upstream.resolveNext();
    await waitForJobStatus(client, first.jobId, "completed");
    await close();
  });

  it("allows thirty concurrent jobs and rejects the thirty-first by default", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, close } = await connectTestClient(
      configFor(root),
      upstream
    );

    const started = await Promise.all(
      Array.from({ length: 30 }, async (_, index) =>
        parseToolJson(
          await client.callTool({
            name: "codex_task",
            arguments: {
              prompt: `parallel-${index + 1}`,
              sessionMode: "new"
            }
          })
        )
      )
    );
    expect(started.every((job) => job.status === "running")).toBe(true);
    expect(upstream.calls).toHaveLength(30);
    const status = parseToolJson(await client.callTool({ name: "codex_status", arguments: {} }));
    expect(status.jobs).toHaveLength(30);

    const overflow = await client.callTool({
      name: "codex_task",
      arguments: { prompt: "parallel-31", sessionMode: "new" }
    });
    expect(overflow.isError).toBe(true);
    expect(JSON.stringify(overflow)).toContain("configured limit is 30");
    expect(upstream.calls).toHaveLength(30);

    for (let index = 0; index < 30; index += 1) {
      upstream.resolveNext(fakeCodexResult(`thread-${index + 1}`));
    }
    await Promise.all(started.map((job) => waitForJobStatus(client, job.jobId, "completed")));
    await close();
  });

  it("runs new sessions concurrently in the same working directory", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, close } = await connectTestClient(
      configFor(root, {
        CODEX_MCP_BRIDGE_MAX_CONCURRENT_JOBS: "2"
      }),
      upstream
    );

    const first = parseToolJson(
      await client.callTool({
        name: "codex_task",
        arguments: { prompt: "first", sessionMode: "new" }
      })
    );
    const second = parseToolJson(
      await client.callTool({
        name: "codex_task",
        arguments: { prompt: "second", sessionMode: "new" }
      })
    );

    expect(first.status).toBe("running");
    expect(second.status).toBe("running");
    expect(upstream.calls).toHaveLength(2);
    upstream.resolveNext(fakeCodexResult("thread-1"));
    upstream.resolveNext(fakeCodexResult("thread-2"));
    await Promise.all([
      waitForJobStatus(client, first.jobId, "completed"),
      waitForJobStatus(client, second.jobId, "completed")
    ]);
    await close();
  });

  it("allows workspace-write jobs in the same working directory", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, close } = await connectTestClient(
      configFor(root, {
        CODEX_MCP_BRIDGE_ALLOW_WRITE: "1",
        CODEX_MCP_BRIDGE_MAX_CONCURRENT_JOBS: "2"
      }),
      upstream
    );

    const first = parseToolJson(
      await client.callTool({
        name: "codex_task",
        arguments: {
          prompt: "first write",
          sessionMode: "new",
          sandbox: "workspace-write"
        }
      })
    );
    const second = parseToolJson(
      await client.callTool({
        name: "codex_task",
        arguments: {
          prompt: "second write",
          sessionMode: "new",
          sandbox: "workspace-write"
        }
      })
    );

    expect(first.status).toBe("running");
    expect(second.status).toBe("running");
    expect(upstream.calls).toHaveLength(2);
    upstream.resolveNext(fakeCodexResult("write-thread-1"));
    upstream.resolveNext(fakeCodexResult("write-thread-2"));
    await Promise.all([
      waitForJobStatus(client, first.jobId, "completed"),
      waitForJobStatus(client, second.jobId, "completed")
    ]);
    await close();
  });

  it("allows danger-full-access jobs in the same working directory", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, close } = await connectTestClient(
      configFor(root, {
        CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS: "1",
        CODEX_MCP_BRIDGE_MAX_CONCURRENT_JOBS: "2"
      }),
      upstream
    );

    const first = parseToolJson(
      await client.callTool({
        name: "codex_task",
        arguments: {
          prompt: "first full",
          sessionMode: "new",
          sandbox: "danger-full-access"
        }
      })
    );
    const second = parseToolJson(
      await client.callTool({
        name: "codex_task",
        arguments: {
          prompt: "second full",
          sessionMode: "new",
          sandbox: "danger-full-access"
        }
      })
    );

    expect(first.status).toBe("running");
    expect(second.status).toBe("running");
    expect(upstream.calls).toHaveLength(2);
    upstream.resolveNext(fakeCodexResult("full-thread-1"));
    upstream.resolveNext(fakeCodexResult("full-thread-2"));
    await Promise.all([
      waitForJobStatus(client, first.jobId, "completed"),
      waitForJobStatus(client, second.jobId, "completed")
    ]);
    await close();
  });

  it("can add a parallel thread dynamically when the existing scope thread is busy", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, close } = await connectTestClient(
      configFor(root, {
        CODEX_MCP_BRIDGE_MAX_CONCURRENT_JOBS: "2"
      }),
      upstream
    );

    const seeded = parseToolJson(
      await client.callTool({ name: "codex_task", arguments: { prompt: "seed Activity" } })
    );
    upstream.resolveNext(fakeCodexResult("thread-1"));
    await waitForJobStatus(client, seeded.jobId, "completed");

    const first = parseToolJson(
      await client.callTool({
        name: "codex_task",
        arguments: { prompt: "continue Activity", activityId: seeded.activityId }
      })
    );
    const second = await client.callTool({
      name: "codex_task",
      arguments: { prompt: "same thread automatically", activityId: seeded.activityId }
    });
    expect(second.isError).toBe(true);
    expect(JSON.stringify(second)).toContain("Activity is busy");

    const parallel = parseToolJson(
      await client.callTool({
        name: "codex_task",
        arguments: { prompt: "parallel work", sessionMode: "new", activityId: seeded.activityId }
      })
    );

    expect(upstream.calls.map((call) => call.name)).toEqual(["codex", "codex-reply", "codex"]);
    expect(parallel.session).toMatchObject({ action: "start", reason: "explicit-new" });
    upstream.resolveNext(fakeCodexResult("thread-1"));
    upstream.resolveNext(fakeCodexResult("thread-2"));
    await Promise.all([
      waitForJobStatus(client, first.jobId, "completed"),
      waitForJobStatus(client, parallel.jobId, "completed")
    ]);
    await close();
  });

  it("does not start a second implicit auto session while the first one has no thread id yet", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const { client, close } = await connectTestClient(
      configFor(root, {
        CODEX_MCP_BRIDGE_MAX_CONCURRENT_JOBS: "2"
      }),
      upstream
    );

    const first = parseToolJson(
      await client.callTool({ name: "codex_task", arguments: { prompt: "first implicit auto" } })
    );
    const second = await client.callTool({
      name: "codex_task",
      arguments: { prompt: "second implicit auto", activityId: first.activityId }
    });

    expect(first.status).toBe("running");
    expect(second.isError).toBe(true);
    expect(JSON.stringify(second)).toContain("session is still starting or running");
    expect(upstream.calls).toHaveLength(1);
    upstream.resolveNext(fakeCodexResult("auto-thread"));
    await waitForJobStatus(client, first.jobId, "completed");
    await close();
  });

  it("continues an Activity thread without an age limit and does not bypass it while busy", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const sessions = new SessionRegistry();
    const { client, close } = await connectTestClient(
      configFor(root, {
        CODEX_MCP_BRIDGE_MAX_CONCURRENT_JOBS: "2"
      }),
      upstream,
      sessions
    );

    const seeded = parseToolJson(
      await client.callTool({ name: "codex_task", arguments: { prompt: "seed old Activity thread" } })
    );
    upstream.resolveNext(fakeCodexResult("expiring-thread"));
    await waitForJobStatus(client, seeded.jobId, "completed");
    const old = Date.now() - 365 * 24 * 60 * 60 * 1000;
    sessions.record({
      ...(sessions.get("expiring-thread") as NonNullable<ReturnType<SessionRegistry["get"]>>),
      lastUsedAt: old
    });

    const continuing = parseToolJson(
      await client.callTool({
        name: "codex_task",
        arguments: {
          prompt: "implicitly continue the old Activity thread",
          activityId: seeded.activityId
        }
      })
    );
    const auto = await client.callTool({
      name: "codex_task",
      arguments: { prompt: "auto must not create a duplicate", activityId: seeded.activityId }
    });

    expect(continuing.status).toBe("running");
    expect(auto.isError).toBe(true);
    expect(JSON.stringify(auto)).toContain("Activity is busy");
    expect(upstream.calls.map((call) => call.name)).toEqual(["codex", "codex-reply"]);
    upstream.resolveNext(fakeCodexResult("expiring-thread"));
    await waitForJobStatus(client, continuing.jobId, "completed");
    await close();
  });

  it("serializes concurrent turns on the same Codex thread", async () => {
    const root = temporaryRoot();
    const upstream = new DeferredUpstream();
    const sessions = new SessionRegistry();
    const now = Date.now();
    sessions.record({
      threadId: "thread-1",
      scopeId: SCOPE_A,
      cwd: realpathSync(root),
      sandbox: "read-only",
      createdAt: now,
      lastUsedAt: now
    });
    const { client, close } = await connectTestClient(
      configFor(root),
      upstream,
      sessions
    );

    const first = parseToolJson(
      await client.callTool({
        name: "codex_task",
        arguments: { prompt: "first", sessionMode: "continue", threadId: "thread-1" }
      })
    );
    const second = await client.callTool({
      name: "codex_task",
      arguments: { prompt: "second", sessionMode: "continue", threadId: "thread-1" }
    });

    expect(second.isError).toBe(true);
    expect(JSON.stringify(second)).toContain("already running for this Codex thread");
    expect(upstream.calls).toHaveLength(1);
    upstream.resolveNext(fakeCodexResult("thread-1"));
    await waitForJobStatus(client, first.jobId, "completed");
    await close();
  });
});

function temporaryRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "bridge-root-"));
}

function configFor(root: string, extra: NodeJS.ProcessEnv = {}) {
  return loadConfig({
    CODEX_MCP_BRIDGE_NO_AUTH: "1",
    CODEX_MCP_BRIDGE_ROOTS: root,
    ...extra
  });
}

async function connectTestClient(
  config: ReturnType<typeof loadConfig>,
  upstream: CodexUpstream,
  sessions?: SessionRegistry,
  modelCatalog: CodexModelCatalogProvider = new FakeModelCatalog(),
  userSettings: UserSettingsStore = new UserSettingsStore(config),
  jobs?: CodexJobRegistry
) {
  const jobRegistry = jobs || new CodexJobRegistry({
    maxConcurrentJobs: config.maxConcurrentJobs,
    ttlMs: config.jobTtlMs,
    maxJobs: config.maxRetainedJobs,
    maxResultBytes: config.maxJobResultBytes,
    staleAfterMs: config.jobStaleAfterMs,
    allowedRoots: config.allowedRoots
  });
  const server = createBridgeMcpServer(
    config,
    upstream,
    sessions,
    jobRegistry,
    modelCatalog,
    userSettings
  );
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const rawCallTool = client.callTool.bind(client);
  Object.defineProperty(client, "callTool", {
    value: (
      request: {
        name: string;
        arguments?: Record<string, unknown>;
        _meta?: Record<string, unknown>;
      },
      ...rest: unknown[]
    ) => {
      const arguments_ = request.arguments || {};
      if (request.name === "codex_task") {
        return rawCallTool(
          {
            ...request,
            arguments: {
              scopeId: SCOPE_A,
              requestId: nextRequestId(),
              ...arguments_
            }
          },
          ...(rest as [])
        );
      }
      if (
        (request.name === "codex_status" || request.name === "codex_activity_update") &&
        !arguments_.scopeId &&
        !arguments_.includeAllScopes
      ) {
        return rawCallTool(
          { ...request, arguments: { scopeId: SCOPE_A, ...arguments_ } },
          ...(rest as [])
        );
      }
      return rawCallTool(request, ...(rest as []));
    }
  });
  return {
    client,
    rawCallTool,
    jobs: jobRegistry,
    close: async () => {
      await client.close();
      await server.close();
    }
  };
}

async function runTask(client: Client, arguments_: Record<string, unknown>): Promise<unknown> {
  return client.callTool({
    name: "codex_task",
    arguments: { executionMode: "foreground", ...arguments_ }
  });
}

function taskActivityId(result: unknown): string {
  const activityId = (result as { structuredContent?: Record<string, any> }).structuredContent
    ?.bridgeActivity?.activityId;
  if (typeof activityId !== "string") throw new Error("Task result did not include an Activity id.");
  return activityId;
}

function taskSession(result: unknown): Record<string, unknown> {
  return (result as { structuredContent?: Record<string, any> }).structuredContent?.bridgeSession || {};
}

function nextRequestId(): string {
  requestSequence += 1;
  return `aaaaaaaa-aaaa-4aaa-8aaa-${requestSequence.toString(16).padStart(12, "0")}`;
}

function fakeCodexResult(threadId: string): ToolResult {
  return {
    structuredContent: { threadId, content: "done" },
    content: [{ type: "text", text: JSON.stringify({ threadId, content: "done" }) }]
  };
}

function model(id: string, defaultEffort: string, efforts: string[]) {
  return {
    id,
    displayName: id,
    defaultReasoningEffort: defaultEffort,
    supportedReasoningEfforts: efforts.map((effort) => ({ effort })),
    supportedInApi: true
  };
}

function parseToolJson(result: unknown): Record<string, any> {
  const content = (result as { content?: Array<{ text?: string }> }).content;
  return JSON.parse(content?.[0]?.text || "{}");
}

async function waitForJobStatus(client: Client, jobId: string, expected: string): Promise<Record<string, any>> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const status = parseToolJson(
      await client.callTool({ name: "codex_status", arguments: { jobId } })
    );
    if (status.status === expected) return status;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for job status ${expected}.`);
}
