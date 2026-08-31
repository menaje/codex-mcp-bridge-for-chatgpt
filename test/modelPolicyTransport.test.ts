import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  McpServer,
  type RegisteredTool
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import * as z from "zod/v4";
import {
  SdkModelPolicyProjectionAdapter,
  SdkToolDescriptorCoordinator,
  descriptorSignature,
  type SdkToolDescriptorSnapshotInput
} from "../src/modelPolicyTransport.js";

describe("SdkToolDescriptorCoordinator", () => {
  it("installs complete snapshots on every binding before one coalesced notification", () => {
    const initial = descriptor("initial", false);
    const coordinator = new SdkToolDescriptorCoordinator(initial);
    const first = fakeBinding();
    const second = fakeBinding();

    coordinator.attach(first.server, first.tool);
    coordinator.attach(second.server, second.tool);
    expect(completeToolView(first.tool)).toMatchObject({
      title: "initial title",
      description: "initial description",
      enabled: true,
      annotations: { destructiveHint: false },
      execution: { taskSupport: "forbidden" },
      _meta: { generation: "initial" }
    });
    expect(first.sendToolListChanged).not.toHaveBeenCalled();
    expect(second.sendToolListChanged).not.toHaveBeenCalled();

    const middle = coordinator.publish(descriptor("middle", true));
    const latestDescriptor = descriptor("latest", false, false);
    const latest = coordinator.publish(latestDescriptor);

    expect(middle).toMatchObject({
      descriptorProjectionUpdated: true,
      descriptorEpoch: 2,
      notificationQueued: true,
      bindingCount: 2
    });
    expect(latest).toMatchObject({
      descriptorProjectionUpdated: true,
      descriptorEpoch: 3,
      notificationQueued: true,
      bindingCount: 2
    });
    for (const binding of [first, second]) {
      expect(completeToolView(binding.tool)).toMatchObject({
        title: "latest title",
        description: "latest description",
        enabled: false,
        annotations: { destructiveHint: false },
        execution: { taskSupport: "forbidden" },
        _meta: { generation: "latest" }
      });
      expect(binding.tool.inputSchema).toBe(latestDescriptor.inputSchema);
      expect(binding.tool.outputSchema).toBe(latestDescriptor.outputSchema);
      expect(binding.sendToolListChanged).not.toHaveBeenCalled();
      expect(Object.isFrozen(binding.tool._meta)).toBe(true);
    }

    coordinator.flushNotifications();
    expect(first.sendToolListChanged).toHaveBeenCalledTimes(1);
    expect(second.sendToolListChanged).toHaveBeenCalledTimes(1);
    expect(coordinator.status).toMatchObject({
      descriptorEpoch: 3,
      bindingCount: 2,
      notificationQueued: false,
      notificationAttemptCount: 2,
      notificationErrorCount: 0,
      lastNotificationEpoch: 3,
      disposed: false
    });

    const equivalent = coordinator.publish({
      ...latestDescriptor,
      _meta: { generation: "latest" }
    });
    expect(equivalent).toMatchObject({
      descriptorProjectionUpdated: false,
      descriptorEpoch: 3,
      notificationQueued: false
    });
  });

  it("attaches late sessions at the latest epoch and detaches without stale updates", () => {
    const coordinator = new SdkToolDescriptorCoordinator(descriptor("one", false));
    const first = fakeBinding();
    const firstBinding = coordinator.attach(first.server, first.tool);
    coordinator.publish(descriptor("two", true));
    coordinator.flushNotifications();

    const late = fakeBinding();
    const lateBinding = coordinator.attach(late.server, late.tool);
    expect(completeToolView(late.tool)).toMatchObject({
      title: "two title",
      annotations: { destructiveHint: true }
    });
    expect(late.sendToolListChanged).not.toHaveBeenCalled();

    expect(lateBinding.detach()).toBe(true);
    expect(lateBinding.detach()).toBe(false);
    coordinator.publish(descriptor("three", false));
    coordinator.flushNotifications();
    expect(first.tool.title).toBe("three title");
    expect(late.tool.title).toBe("two title");
    expect(first.sendToolListChanged).toHaveBeenCalledTimes(2);
    expect(late.sendToolListChanged).not.toHaveBeenCalled();

    coordinator.dispose();
    expect(coordinator.status).toMatchObject({ bindingCount: 0, disposed: true });
    expect(firstBinding.detach()).toBe(false);
    expect(() => coordinator.publish(descriptor("four", false))).toThrow(/disposed/);
  });

  it("fingerprints reversible tool presence separately from enablement", () => {
    const initial = descriptor("one", false);
    const coordinator = new SdkToolDescriptorCoordinator(initial);
    const binding = fakeBinding();
    coordinator.attach(binding.server, binding.tool);

    const absent = coordinator.publish({
      ...initial,
      present: false,
      enabled: true
    });
    expect(absent).toMatchObject({
      descriptorProjectionUpdated: true,
      descriptorEpoch: 2
    });
    expect(binding.tool.enabled).toBe(false);
    expect(binding.tool.remove).not.toHaveBeenCalled();

    const presentButDisabled = coordinator.publish({
      ...initial,
      present: true,
      enabled: false
    });
    expect(presentButDisabled.descriptorEpoch).toBe(3);
    expect(binding.tool.enabled).toBe(false);

    const restored = coordinator.publish({
      ...initial,
      present: true,
      enabled: true
    });
    expect(restored.descriptorEpoch).toBe(4);
    expect(binding.tool.enabled).toBe(true);
    expect(binding.tool.remove).not.toHaveBeenCalled();
  });

  it("installs snapshots before initialize but notifies only eligible bindings", () => {
    const coordinator = new SdkToolDescriptorCoordinator(descriptor("one", false));
    const ready = fakeBinding();
    const initializing = fakeBinding();
    coordinator.attach(ready.server, ready.tool);
    const initializingBinding = coordinator.attach(
      initializing.server,
      initializing.tool,
      undefined,
      { notificationEligible: false }
    );

    coordinator.publish(descriptor("two", true));
    coordinator.flushNotifications();
    expect(ready.sendToolListChanged).toHaveBeenCalledTimes(1);
    expect(initializing.sendToolListChanged).not.toHaveBeenCalled();
    expect(initializing.tool.title).toBe("two title");
    expect(coordinator.status).toMatchObject({
      bindingCount: 2,
      notificationEligibleBindingCount: 1
    });

    expect(initializingBinding.setNotificationEligible()).toBe(true);
    coordinator.flushNotifications();
    expect(initializing.sendToolListChanged).toHaveBeenCalledTimes(1);
    coordinator.publish(descriptor("three", false));
    coordinator.flushNotifications();
    expect(ready.sendToolListChanged).toHaveBeenCalledTimes(2);
    expect(initializing.sendToolListChanged).toHaveBeenCalledTimes(2);
  });

  it("observes asynchronous notification failures and retries them once", async () => {
    let sends = 0;
    const coordinator = new SdkToolDescriptorCoordinator(
      descriptor("one", false),
      { notificationRetryDelayMs: 0, maxNotificationRetries: 1 }
    );
    const binding = fakeBinding(async () => {
      sends += 1;
      if (sends === 1) throw new Error("transport disconnected");
    });
    const attached = coordinator.attach(binding.server, binding.tool);

    coordinator.publish(descriptor("two", true));
    coordinator.flushNotifications();

    await vi.waitFor(() => {
      expect(binding.sendToolListChanged).toHaveBeenCalledTimes(2);
      expect(coordinator.status).toMatchObject({
        notificationAttemptCount: 2,
        notificationErrorCount: 1,
        lastNotificationEpoch: 2
      });
    });
    await Promise.resolve();
    expect(attached.setNotificationEligible(false)).toBe(true);
    expect(attached.setNotificationEligible(true)).toBe(true);
    coordinator.flushNotifications();
    expect(binding.sendToolListChanged).toHaveBeenCalledTimes(2);
    coordinator.dispose();
  });

  it("reconciles from a replaceable descriptor source", () => {
    let desired = descriptor("one", false);
    const coordinator = new SdkToolDescriptorCoordinator(desired, {
      reconcile: () => desired
    });
    const binding = fakeBinding();
    coordinator.attach(binding.server, binding.tool);

    expect(coordinator.reconcile()).toMatchObject({ descriptorProjectionUpdated: false });
    desired = descriptor("two", true);
    expect(coordinator.reconcile()).toMatchObject({
      descriptorProjectionUpdated: true,
      descriptorEpoch: 2
    });
    expect(binding.tool.title).toBe("two title");

    coordinator.setReconcileHook(() => descriptor("three", false));
    expect(coordinator.reconcile()).toMatchObject({ descriptorEpoch: 3 });
    expect(binding.tool.title).toBe("three title");
  });

  it("retains the current descriptor until an out-of-band candidate is stable", () => {
    let desired = descriptor("one", false);
    const coordinator = new SdkToolDescriptorCoordinator(desired, {
      reconcile: () => desired
    });
    const binding = fakeBinding();
    coordinator.attach(binding.server, binding.tool);

    desired = descriptor("transient", true);
    expect(coordinator.reconcileStable(2)).toMatchObject({
      descriptorProjectionUpdated: false,
      descriptorEpoch: 1
    });
    expect(binding.tool.title).toBe("one title");
    expect(coordinator.status).toMatchObject({ pendingReconcileObservationCount: 1 });

    desired = descriptor("one", false);
    coordinator.reconcileStable(2);
    expect(coordinator.status).toMatchObject({ pendingReconcileObservationCount: 0 });

    desired = descriptor("stable", true);
    coordinator.reconcileStable(2);
    expect(coordinator.reconcileStable(2)).toMatchObject({
      descriptorProjectionUpdated: true,
      descriptorEpoch: 2
    });
    expect(binding.tool.title).toBe("stable title");
  });

  it("counts client re-lists only for the current descriptor epoch", () => {
    const coordinator = new SdkToolDescriptorCoordinator(descriptor("one", false));
    coordinator.noteClientRelisted("first");
    coordinator.noteClientRelisted("second");
    expect(coordinator.status).toMatchObject({
      descriptorEpoch: 1,
      clientRelistObservationCount: 2,
      clientRelistedSessionCount: 2,
      lastClientRelistedEpoch: 1
    });

    coordinator.publish(descriptor("two", true));
    expect(coordinator.status).toMatchObject({
      descriptorEpoch: 2,
      clientRelistObservationCount: 2,
      clientRelistedSessionCount: 0,
      lastClientRelistedEpoch: 1
    });

    coordinator.noteClientRelisted("first", 1);
    expect(coordinator.status).toMatchObject({
      clientRelistObservationCount: 3,
      clientRelistedSessionCount: 0,
      lastClientRelistedEpoch: 1
    });
    coordinator.noteClientRelisted("first");
    expect(coordinator.status).toMatchObject({
      clientRelistObservationCount: 4,
      clientRelistedSessionCount: 1,
      lastClientRelistedEpoch: 2
    });
  });

  it("measures notification-to-re-list observations without claiming adoption", () => {
    let now = Date.parse("2026-08-31T00:00:00.000Z");
    const coordinator = new SdkToolDescriptorCoordinator(
      descriptor("one", false),
      { now: () => now }
    );
    const binding = fakeBinding();
    coordinator.attach(binding.server, binding.tool);

    coordinator.publish(descriptor("two", true));
    now += 20;
    coordinator.flushNotifications();
    now += 137;
    coordinator.noteClientRelisted("first");

    expect(coordinator.status).toMatchObject({
      lastNotificationEpoch: 2,
      lastNotificationAttemptAt: "2026-08-31T00:00:00.020Z",
      lastClientRelistedEpoch: 2,
      lastClientRelistedAt: "2026-08-31T00:00:00.157Z",
      lastObservedNotificationToRelistMs: 137
    });
  });

  it("records stateless re-lists without inventing a durable adopted session", () => {
    const coordinator = new SdkToolDescriptorCoordinator(descriptor("one", false));
    coordinator.noteClientRelisted(undefined);
    coordinator.noteClientRelisted(undefined);
    expect(coordinator.status).toMatchObject({
      clientRelistObservationCount: 2,
      clientRelistedSessionCount: 0,
      lastClientRelistedEpoch: 1
    });
  });

  it("re-signals only a known stateful session that has not re-listed the current epoch", async () => {
    const coordinator = new SdkToolDescriptorCoordinator(descriptor("one", false));
    const first = fakeBinding();
    const second = fakeBinding();
    coordinator.attach(first.server, first.tool);
    coordinator.attach(second.server, second.tool);

    expect(coordinator.resignalUnrelistedSession("unknown", first.server)).toBe(false);
    coordinator.noteClientRelisted("first");
    coordinator.noteClientRelisted("second");
    coordinator.publish(descriptor("two", true));
    coordinator.flushNotifications();
    expect(first.sendToolListChanged).toHaveBeenCalledTimes(1);
    expect(second.sendToolListChanged).toHaveBeenCalledTimes(1);
    await Promise.resolve();

    expect(coordinator.resignalUnrelistedSession("first", first.server)).toBe(true);
    expect(first.sendToolListChanged).toHaveBeenCalledTimes(2);
    expect(second.sendToolListChanged).toHaveBeenCalledTimes(1);
    coordinator.noteClientRelisted("first");
    expect(coordinator.resignalUnrelistedSession("first", first.server)).toBe(false);
    expect(coordinator.resignalUnrelistedSession("second", {} as McpServer)).toBe(false);
    expect(coordinator.status.clientRelistedSessionCount).toBe(1);
  });

  it("signs every mutable descriptor field with stable object-key ordering", () => {
    const baseline = descriptor("one", false);
    const reordered = {
      ...baseline,
      _meta: { nested: { z: 2, a: 1 }, generation: "one" }
    };
    const sameReordered = {
      ...baseline,
      _meta: { generation: "one", nested: { a: 1, z: 2 } }
    };
    expect(descriptorSignature(reordered)).toBe(descriptorSignature(sameReordered));

    const mutations: SdkToolDescriptorSnapshotInput[] = [
      { ...baseline, title: "changed" },
      { ...baseline, description: "changed" },
      { ...baseline, inputSchema: z.strictObject({ changed: z.string() }) },
      { ...baseline, outputSchema: z.strictObject({ changed: z.boolean() }) },
      { ...baseline, annotations: { ...baseline.annotations, destructiveHint: true } },
      { ...baseline, execution: { taskSupport: "optional" } },
      { ...baseline, _meta: { generation: "changed" } },
      { ...baseline, admissionRef: "changed" },
      { ...baseline, admissionCatalogFingerprint: "a".repeat(64) },
      { ...baseline, present: false },
      { ...baseline, enabled: false }
    ];
    const signature = descriptorSignature(baseline);
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    for (const mutation of mutations) {
      expect(descriptorSignature(mutation)).not.toBe(signature);
    }
  });

  it("requires reinitialization instead of mutating an output validator on a live binding", () => {
    const initial = descriptor("one", false);
    const coordinator = new SdkToolDescriptorCoordinator(initial);
    const binding = fakeBinding();
    const attached = coordinator.attach(binding.server, binding.tool);
    const oldOutput = binding.tool.outputSchema;
    const changed = {
      ...descriptor("two", true),
      outputSchema: z.strictObject({ nextContract: z.string() })
    };

    expect(() => coordinator.publish(changed)).toThrow(
      /OUTPUT_SCHEMA_CHANGE_REQUIRES_VERSIONED_CONTRACT/
    );
    expect(coordinator.status.descriptorEpoch).toBe(1);
    expect(binding.tool.outputSchema).toBe(oldOutput);
    expect(binding.sendToolListChanged).not.toHaveBeenCalled();

    attached.detach();
    expect(coordinator.publish(changed)).toMatchObject({
      descriptorProjectionUpdated: true,
      descriptorEpoch: 2
    });
    const reinitialized = fakeBinding();
    coordinator.attach(reinitialized.server, reinitialized.tool);
    expect(reinitialized.tool.outputSchema).toBe(changed.outputSchema);
  });

  it("keeps the admitted output contract for an in-flight call when a transition is attempted", async () => {
    let markStarted!: () => void;
    let releaseHandler!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseHandler = resolve; });
    const oldOutput = z.strictObject({ contract: z.literal("old") });
    const newOutput = z.strictObject({ contract: z.literal("new") });
    const server = new McpServer({ name: "output-race-test", version: "0.0.0" });
    const tool = server.registerTool(
      "versioned_output",
      {
        inputSchema: z.strictObject({}),
        outputSchema: oldOutput
      },
      async () => {
        markStarted();
        await release;
        return {
          structuredContent: { contract: "old" },
          content: [{ type: "text", text: "old contract" }]
        };
      }
    );
    const initial: SdkToolDescriptorSnapshotInput = {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema as z.ZodType,
      outputSchema: tool.outputSchema as z.ZodType,
      annotations: tool.annotations,
      execution: tool.execution,
      _meta: tool._meta,
      present: true,
      enabled: true
    };
    const coordinator = new SdkToolDescriptorCoordinator(initial);
    const binding = coordinator.attach(server, tool);
    const client = new Client({ name: "output-race-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const call = client.callTool({ name: "versioned_output", arguments: {} });
      await started;
      expect(() => coordinator.publish({
        ...initial,
        outputSchema: newOutput
      })).toThrow(/OUTPUT_SCHEMA_CHANGE_REQUIRES_VERSIONED_CONTRACT/);
      expect(tool.outputSchema).toBe(oldOutput);

      releaseHandler();
      await expect(call).resolves.toMatchObject({
        structuredContent: { contract: "old" }
      });
      expect(coordinator.status.descriptorEpoch).toBe(1);
    } finally {
      releaseHandler();
      binding.detach();
      await client.close();
      await server.close();
    }
  });

  it("rejects a different live output validator even when its JSON Schema is unchanged", () => {
    const initial = descriptor("one", false);
    const coordinator = new SdkToolDescriptorCoordinator(initial);
    const binding = fakeBinding();
    coordinator.attach(binding.server, binding.tool);
    const refinedOutput = z.strictObject({
      result: z.boolean().refine((value) => value, "must be true")
    });

    expect(() => coordinator.publish({
      ...descriptor("two", true),
      outputSchema: refinedOutput
    })).toThrow(/OUTPUT_SCHEMA_CHANGE_REQUIRES_VERSIONED_CONTRACT/);
    expect(binding.tool.outputSchema).toBe(initial.outputSchema);
    expect(binding.tool.description).toBe(initial.description);
    expect(coordinator.status.descriptorEpoch).toBe(1);
  });

  it("keeps the existing model-policy adapter behavior on the complete snapshot core", () => {
    const binding = fakeBinding();
    binding.tool.outputSchema = z.strictObject({ ok: z.boolean() });
    binding.tool.execution = { taskSupport: "forbidden" };
    binding.tool._meta = { previous: true };
    const adapter = new SdkModelPolicyProjectionAdapter(binding.server);
    adapter.attach(binding.tool, {
      schema: z.strictObject({ first: z.string() }),
      annotations: { destructiveHint: false },
      metadata: { current: true },
      description: "first"
    });

    const outputSchema = binding.tool.outputSchema;
    expect(adapter.publish({
      schema: z.strictObject({ second: z.string() }),
      annotations: { destructiveHint: true },
      metadata: undefined,
      description: "second"
    })).toEqual({
      descriptorProjectionUpdated: true,
      developerModeRefreshRequired: true
    });
    expect(binding.tool).toMatchObject({
      description: "second",
      annotations: { destructiveHint: true },
      execution: { taskSupport: "forbidden" },
      enabled: true
    });
    expect(binding.tool._meta).toBeUndefined();
    expect(binding.tool.outputSchema).toBe(outputSchema);
    adapter.dispose();
  });
});

function descriptor(
  generation: string,
  destructive: boolean,
  enabled = true
): SdkToolDescriptorSnapshotInput {
  return {
    title: `${generation} title`,
    description: `${generation} description`,
    inputSchema: z.strictObject({ [`${generation}Input`]: z.string() }),
    outputSchema: TEST_OUTPUT_SCHEMA,
    annotations: {
      readOnlyHint: !destructive,
      destructiveHint: destructive,
      idempotentHint: false,
      openWorldHint: destructive
    },
    execution: { taskSupport: "forbidden" },
    _meta: { generation },
    enabled
  };
}

const TEST_OUTPUT_SCHEMA = z.strictObject({ result: z.boolean() });

function fakeBinding(
  sendImplementation: () => Promise<void> = async () => undefined
): {
  server: McpServer;
  tool: RegisteredTool;
  sendToolListChanged: ReturnType<typeof vi.fn>;
} {
  const sendToolListChanged = vi.fn(sendImplementation);
  const server = {
    server: { sendToolListChanged }
  } as unknown as McpServer;
  const tool = {
    title: "stale title",
    description: "stale description",
    inputSchema: z.strictObject({ stale: z.string() }),
    outputSchema: z.strictObject({ stale: z.boolean() }),
    annotations: { destructiveHint: false },
    execution: { taskSupport: "forbidden" },
    _meta: { stale: true },
    handler: vi.fn(),
    enabled: true,
    enable: vi.fn(),
    disable: vi.fn(),
    update: vi.fn(),
    remove: vi.fn()
  } as unknown as RegisteredTool;
  return { server, tool, sendToolListChanged };
}

function completeToolView(tool: RegisteredTool): Record<string, unknown> {
  return {
    title: tool.title,
    description: tool.description,
    annotations: tool.annotations,
    execution: tool.execution,
    _meta: tool._meta,
    enabled: tool.enabled
  };
}
