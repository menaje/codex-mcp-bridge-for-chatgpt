import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { loadConfig } from "../src/config.js";
import { startBridgeCompanionServer } from "../src/companionServer.js";
import { createIsolatedHttpServer } from "../src/runtimeProcess.js";
import type { BridgeApplicationService, DashboardView } from "../src/tools.js";

const protocol = "2026-07-28";
const root = await mkdtemp(path.join(tmpdir(), "bridge-issue-196-measurement-"));
const environment = {
  ...process.env,
  CODEX_MCP_BRIDGE_NO_AUTH: "1",
  CODEX_MCP_BRIDGE_HOST: "127.0.0.1",
  CODEX_MCP_BRIDGE_CODEX: "/usr/bin/false",
  CODEX_MCP_BRIDGE_RUNTIME_HOME: path.join(root, "runtime"),
  CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: path.join(root, "state.sqlite"),
  CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE: path.join(root, "models.json"),
  CODEX_MCP_BRIDGE_SKILLS_DIRECTORY: path.join(root, "skills")
};
const server = await createIsolatedHttpServer(loadConfig(environment), {
  childEnvironment: environment
});
const sockets: Socket[] = [];
try {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test address.");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  for (let index = 0; index < 112; index += 1) {
    sockets.push(await new Promise<Socket>((resolve, reject) => {
      const socket = createConnection(address.port, "127.0.0.1");
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.off("error", reject);
        socket.on("error", () => {});
        socket.write(`POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\n` +
          "Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n" +
          "Connection: keep-alive\r\n\r\n1\r\n{\r\n");
        resolve(socket);
      });
    }));
  }
  const deadline = Date.now() + 8_000;
  let inFlight = 0;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/readyz`);
    const body = await response.json() as { stateService?: { inFlight?: number } };
    inFlight = body.stateService?.inFlight || 0;
    if (inFlight === 112) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (inFlight !== 112) throw new Error(`Expected 112 reservations, observed ${inFlight}.`);

  const exactStatus: Array<{ status: number; durationMs: number; bodyBytes: number }> = [];
  for (let index = 0; index < 20; index += 1) {
    const body = JSON.stringify({
      jsonrpc: "2.0", id: `measurement-${index}`, method: "tools/call",
      params: {
        name: "codex_status",
        arguments: { scopeId: randomUUID(), query: { kind: "job", id: randomUUID() } },
        _meta: {
          "io.modelcontextprotocol/protocolVersion": protocol,
          "io.modelcontextprotocol/clientInfo": { name: "issue-196-measurement", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {}
        }
      }
    });
    const started = performance.now();
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json",
        "mcp-protocol-version": protocol, "mcp-method": "tools/call", "mcp-name": "codex_status" },
      body
    });
    await response.arrayBuffer();
    exactStatus.push({ status: response.status, durationMs: performance.now() - started,
      bodyBytes: Buffer.byteLength(body) });
  }
  const native: number[] = [];
  const liveness: number[] = [];
  for (let index = 0; index < 20; index += 1) {
    let started = performance.now();
    await server.applicationService.settingsSnapshot();
    native.push(performance.now() - started);
    started = performance.now();
    const response = await fetch(`${baseUrl}/healthz`);
    await response.arrayBuffer();
    liveness.push(performance.now() - started);
  }
  const latest = await fetch(`${baseUrl}/readyz`);
  const latestBody = await latest.json() as { stateService?: { inFlight?: number } };
  const nativeControl = await measureNativeControl(server.applicationService, root);
  const summary = (values: number[]) => {
    const sorted = [...values].sort((left, right) => left - right);
    return { medianMs: Number(sorted[9]!.toFixed(2)), p95Ms: Number(sorted[18]!.toFixed(2)) };
  };
  process.stdout.write(JSON.stringify({
    variant: process.env.ISSUE_196_VARIANT || "unspecified",
    load: { incompleteMcpRequests: 112, exactStatusRequests: 20,
      exactStatusBodyBytes: exactStatus[0]?.bodyBytes },
    reservations: { before: inFlight, after: latestBody.stateService?.inFlight },
    fixedInputBytes: { proxyBodiesAtSteadyState: 112,
      idCaptureAllocationAtSteadyState: 112 * 1_024,
      idCaptureAllocationWithOneProbe: 113 * 1_024 },
    exactStatus: { statuses: [...new Set(exactStatus.map(row => row.status))],
      ...summary(exactStatus.map(row => row.durationMs)) },
    nativeSettings: summary(native),
    nativeControl,
    healthz: summary(liveness)
  }) + "\n");
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}

async function measureNativeControl(
  applicationService: BridgeApplicationService,
  directory: string
): Promise<{ outcome: string; durationMs: number }> {
  const snapshot = await applicationService.dashboardSnapshot();
  const releases: Array<() => void> = [];
  const companion = await startBridgeCompanionServer({
    socketPath: path.join(directory, "native.sock"),
    applicationService: {
      ...applicationService,
      dashboardSnapshot: () => new Promise<DashboardView>(resolve => {
        releases.push(() => resolve(snapshot));
      }),
      markNativeCompletionNotificationsDelivered: async () => {}
    }
  });
  const call = (id: string, method: string, params: unknown) => new Promise<unknown>((resolve, reject) => {
    const socket = createConnection(companion.socketPath);
    let response = "";
    const timer = setTimeout(() => socket.destroy(new Error("observation-timeout")), 500);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"));
    socket.on("data", (chunk: string) => {
      response += chunk;
      const newline = response.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      socket.end();
      resolve(JSON.parse(response.slice(0, newline)));
    });
    socket.once("end", () => {
      if (!response.includes("\n")) { clearTimeout(timer); reject(new Error("no-response")); }
    });
    socket.once("error", error => { clearTimeout(timer); reject(error); });
  });
  const ordinary = Array.from({ length: 8 }, (_, index) =>
    call(`held-${index}`, "dashboard.snapshot", {}).catch(() => undefined)
  );
  try {
    const deadline = Date.now() + 2_000;
    while (releases.length < 8 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    if (releases.length !== 8) throw new Error(`Expected eight held native requests, saw ${releases.length}.`);
    const started = performance.now();
    let outcome: string;
    try {
      const response = await call("delivery", "completion.delivered", {
        leaseOwner: randomUUID(), outboxIds: [7]
      }) as { result?: { ok?: boolean } };
      outcome = response.result?.ok === true ? "delivered" : "error-response";
    } catch {
      outcome = "no-response";
    }
    return { outcome, durationMs: Number((performance.now() - started).toFixed(2)) };
  } finally {
    for (const release of releases) release();
    await Promise.allSettled(ordinary);
    await companion.close();
  }
}
