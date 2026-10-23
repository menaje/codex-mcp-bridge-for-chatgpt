// Synthetic English examples shared by the documentation's native and web captures.
// No operational settings, credentials, account reads, or Codex execution are used.
export function documentationSnapshots(now = Date.now()) {
  const iso = (minutes = 0) => new Date(now + minutes * 60_000).toISOString();
  const policyRevision = "c".repeat(64);
  const settings = {
    schemaVersion: 8, settingsRevision: 1, registryRevision: 1, revision: 1,
    accessStrategy: "read-only", uiLocalePreference: "en", maxConcurrentJobs: 4,
    processingSpeed: "standard", usePriorityServiceTier: false,
    historyRetentionDays: 30, bridgeThreadPersistence: "persistent",
    showBridgeThreadsInCodexApp: true, experimentalDirectResultDelivery: false,
    modelPolicy: { mode: "automatic", allowedSelections: { kind: "catalog-visible" }, constraints: { allowDelegation: true } },
    modelDescriptionOverrides: {},
    projects: [{
      id: "11111111-1111-4111-8111-111111111111", projectRef: "project-demo", projectRevision: 1,
      name: "Bridge Demo", nameKey: "bridge demo", cwd: "/Users/demo/Projects/bridge-demo",
      sortOrder: 0, createdAt: now - 86_400_000, updatedAt: now,
      archiveState: "active", archiveRevision: 0, archiveReasons: [], archivedAt: null
    }]
  };
  const models = [
    ["gpt-6.1-sol", "GPT-6.1 Sol", "General project work and everyday coding."],
    ["gpt-6-astra", "GPT-6 Astra", "Complex analysis and demanding engineering work."]
  ].map(([id, displayName, description]) => ({
    id, displayName, description, defaultReasoningEffort: "medium", hidden: false,
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"].map(effort => ({ effort })),
    serviceTiers: [{ id: "fast", name: "Fast" }], inputModalities: ["text"]
  }));
  const settingsSnapshot = {
    settings, operatorDefaults: settings,
    capabilities: {
      availableProcessingSpeeds: ["standard", "fast"],
      availableAccessStrategies: ["read-only", "adaptive", "always-full"],
      availableUiLocalePreferences: ["auto", "en", "ko", "ja", "zh-Hans", "zh-Hant", "es", "fr", "de", "pt"],
      projectAvailability: [{ projectId: settings.projects[0].id, name: "Bridge Demo", available: true, archived: false }],
      maxConcurrentJobs: 100, defaultBackend: "app-server", allowWorkspaceWrite: true,
      allowDangerFullAccess: true, persistent: true
    },
    catalog: { source: "documentation-fixture", cached: true, stale: false, lastKnownGood: true,
      validation: "valid", translationCoverage: { missingEffortIds: [] }, models },
    historyPolicy: { retentionDays: 30, issueAttentionDays: 7, automaticRecovery: true, lastCleanupCount: 0, totalRemoved: 0 },
    warnings: [], scopeNotice: "Settings apply to this Bridge server.",
    policyActivation: { policyRevision: 1, executionPolicyActive: true, descriptorProjectionUpdated: false, developerModeRefreshRequired: false }
  };
  function row(index: number, status: string, title: string, agentName: string, minutes: number) {
    const active = ["running", "input-required"].includes(status);
    const execution = { model: "gpt-6.1-sol", modelDisplayName: "GPT-6.1 Sol", reasoningEffort: "high",
      isCurrent: false, processingSpeed: index === 1 ? "fast" : "standard", serviceTierScope: "turn", requestState: "accepted" };
    const jobId = `documentation-job-${index}`;
    const turn = {
      jobId, scopeId: "documentation-conversation", activityId: `activity-${title}`, agentId: `agent-${agentName}`,
      activityKey: `activity-${title}`, activityTitle: title, executionRevision: "e".repeat(64),
      executionKey: String(index).padStart(32, "0"), execution, status,
      startedAt: iso(minutes - 4), updatedAt: iso(active ? 0 : minutes), endedAt: active ? null : iso(minutes),
      durationMs: active ? null : 240_000,
      error: status === "failed" ? "The preview server was unavailable. Check the local service before trying again." : null,
      ...(status === "cancelled" ? { cancellation: { targetKind: "job", status: "succeeded", reason: "Stopped at the user's request.", requestedAt: iso(minutes) } } : {})
    };
    return {
      jobId, scopeId: turn.scopeId, agentId: turn.agentId, activityId: turn.activityId,
      rowKey: String(index).padStart(32, "0"), activityKey: turn.activityKey,
      conversationKey: turn.scopeId, sessionAlias: "documentation", bucket: active ? "active" : "recent",
      projectKey: "project-demo", projectName: "Bridge Demo", agentName, activityTitle: title,
      status, execution, createdAt: turn.startedAt, updatedAt: turn.updatedAt,
      elapsedMs: active ? 240_000 : turn.durationMs, backgroundProcessCount: 0,
      latestTurn: turn, history: [], historyCount: 0, policyRevision,
      executionRevision: turn.executionRevision, tokenUsage: { inputTokens: 2400, cachedInputTokens: 1200, outputTokens: 650, totalTokens: 3050 }
    };
  }
  const activeRows = [row(1, "running", "Review the demo project", "Code Review", 0), row(2, "input-required", "Prepare the next release", "Release Assistant", 0)];
  const terminalRows = [row(3, "completed", "Review the demo project", "Code Review", -12), row(4, "completed", "Review the demo project", "Code Review", -35), row(5, "failed", "Check the preview", "Preview Check", -55), row(6, "cancelled", "Prepare the next release", "Release Assistant", -80)];
  const page = (total: number) => ({ offset: 0, limit: 12, returned: total, total, returnedConversations: 1, conversationTotal: 1, hasPrevious: false, hasNext: false });
  const problemRows = terminalRows.slice(2).map(r => ({
    problemKey: `problem-${r.jobId}`, revision: "documentation", jobId: r.jobId, agentId: r.agentId,
    source: "execution", kind: r.status, review: "pending", executionAvailability: "retained",
    observedAt: r.updatedAt, reason: r.latestTurn.error, canAcknowledge: false, canUnacknowledge: false,
    canRecheck: false, canRetryStop: false, row: r
  }));
  const dashboard = {
    kind: "dashboard", generatedAt: iso(), uiLocalePreference: "en", scope: "bridge-wide",
    statusSource: "codex-runtime-only", coverage: "bridge-known-retained",
    executionContractVersion: 2, historyModeApplied: "jobs", historyIncluded: true,
    executionHistoryRevision: "documentation", filter: { mode: "all", conversationAvailable: true },
    counts: { trackedProjects: 1, trackedConversations: 1, retainedJobs: 6, active: 2, running: 1,
      inputRequired: 1, approvalRequired: 0, terminating: 0, needsAttention: 1, responseRequired: 1,
      problems: 2, progressJobCount: 2, executionCount: 4, backgroundProcesses: 0,
      backgroundProcessAgents: 0, runtimeUnknownAgents: 0, runtimeProbeSkippedAgents: 0,
      completed: 2, failed: 1, interrupted: 0, cancelled: 1, idleAgents: 0, orphanedAgents: 0 },
    activeRows, terminalRows, idleRows: [], statusRows: activeRows, statusPagination: page(2),
    pagination: { active: page(2), terminal: page(4), idle: page(0) },
    weeklyUsage: { source: "documentation-fixture", limitId: "codex", usedPercent: 25, remainingPercent: 75,
      resetsAt: iso(2880), windowDurationMins: 10080, observedAt: iso() },
    historyPolicy: { retentionDays: 30, issueAttentionDays: 7, policyRevision, automaticRecovery: true, lastCleanupCount: 0, totalRemoved: 0 },
    problems: { query: { kind: "all", review: "pending", offset: 0, view: "history" }, revision: "documentation",
      affectedExecutionCount: 2, pendingCount: 0, acknowledgedCount: 0, reviewableCount: 0,
      historyCount: 2, rows: problemRows, page: page(2) }
  };
  const selection = { id: "demo-codex", source: "terminal", command: "/usr/local/bin/codex",
    physicalPath: "/usr/local/bin/codex", version: "0.160.0", available: true, compatible: true };
  const runtime = {
    selection, candidates: [selection], selectionRequired: false, installedVersion: selection.version,
    runningVersions: [], reclaimableBytes: 0, preferences: { notifications: false },
    actions: { install: false, update: false, remove: false, reinstall: false, rollback: false, cleanup: false, retry: false, applyPending: false, skip: false },
    account: { authMode: "chatgpt", authenticated: true, planType: "plus", billing: { kind: "chatgpt-plan" }, windows: [], observedAt: now },
    authSelection: { revision: 1, applied: { kind: "shared" }, effective: { kind: "shared" }, overrideActive: false,
      appliedAccountEmail: "demo@example.invalid", appliedWorkspaceName: "Demo workspace", appliedBillingTarget: "chatgpt-plan",
      knownHomes: [{ id: "22222222-2222-4222-8222-222222222222", home: "/Users/demo/.codex", canonicalHome: "/Users/demo/.codex" }] }
  };
  const skill = { skillId: "documentation-code-review", source: "bridge", version: "3", name: "Code Review",
    description: "Review changes, verify behavior, and report actionable findings.", contentDigest: "d".repeat(64), enabled: true, availability: "available" };
  return {
    settings: settingsSnapshot, dashboard, runtime,
    auth: { installed: true, authenticated: true, summary: "Ready" },
    helper: { kind: "helper-status", generatedAt: iso(), phase: "running", restartAttempt: 0,
      configuration: { path: "/Users/demo/.config/codex-mcp-bridge/.env", exists: true, valid: true, hasApiKey: true, hasTunnelId: true },
      bridge: { socketPath: "/private/documentation/bridge.sock", connected: true },
      tunnel: { phase: "connected", doctorPassed: true, processRunning: true, connected: true } },
    remote: { enabled: true, listening: true, endpoint: "https://bridge-demo.local:8877", displayName: "Bridge Demo Server",
      serverId: "documentation-server", certificateSha256: "a".repeat(64), devices: [] },
    skills: { skills: [skill] },
    skill: { skill, content: "# Code Review\n\nReview the requested changes and explain findings with evidence.\n\n## Procedure\n\n1. Confirm the scope and read the project instructions.\n2. Inspect the changes and their callers.\n3. Check behavior against the [review checklist](references/checklist.md).\n4. Report actionable findings with file references.\n\n## Report\n\n- Lead with the most important finding.\n- Explain the trigger and impact.\n- Describe the checks performed and any remaining uncertainty.\n",
      files: [{ path: "references/checklist.md", format: "markdown", bytes: 120, contentDigest: "f".repeat(64) }],
      format: "markdown", legacy: false, sourceSnapshot: "versioned-bridge-record", warnings: [] },
    versions: { skillId: skill.skillId, source: "bridge", currentVersion: "3", enabled: true,
      versions: [3, 2, 1].map(version => ({ ...skill, version: String(version), createdAt: iso(-1440 * version), format: "markdown", legacy: false })) }
  };
}
