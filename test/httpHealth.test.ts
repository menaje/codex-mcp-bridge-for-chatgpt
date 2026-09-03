import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { probeHttpHealth } from "../scripts/http-health.mjs";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("built-in HTTP health probe", () => {
  it("accepts a successful local endpoint without an external curl process", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP listener.");

    await expect(probeHttpHealth(`http://127.0.0.1:${address.port}/healthz`)).resolves.toBe(true);
  });

  it("returns false for errors and bounded timeouts", async () => {
    await expect(probeHttpHealth("http://127.0.0.1:1/healthz", { timeoutMs: 50 })).resolves.toBe(false);
    await expect(probeHttpHealth("http://health.invalid", {
      timeoutMs: 10,
      fetchImpl: (_url: string | URL | Request, options?: RequestInit) => new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })
    })).resolves.toBe(false);
  });

  it("rejects unsafe timeout configuration before attempting a request", async () => {
    await expect(probeHttpHealth("http://127.0.0.1", { timeoutMs: 0 })).rejects.toThrow(
      "integer from 1 to 60000"
    );
  });
});
