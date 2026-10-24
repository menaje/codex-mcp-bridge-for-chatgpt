import { Client } from "@modelcontextprotocol/client";
import type { JSONRPCMessage, McpServer, Transport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

export const CURRENT_MCP_PROTOCOL = "2026-07-28";

type ClientIdentity = {
  name: string;
  version: string;
};

export type CurrentMcpConnection = {
  client: Client;
  close(): Promise<void>;
};

/**
 * Connect an isolated bridge instance through the current stdio entry point.
 *
 * The v2 server deliberately owns the opening negotiation through serveStdio;
 * calling McpServer.connect directly would bypass that current-only boundary.
 */
export async function connectCurrentMcpServer(
  server: McpServer,
  identity: ClientIdentity
): Promise<CurrentMcpConnection> {
  const [clientTransport, serverTransport] = linkedTransportPair();
  const stdio = serveStdio(() => server, {
    legacy: "reject",
    transport: serverTransport
  });
  const client = new Client(identity, {
    versionNegotiation: { mode: { pin: CURRENT_MCP_PROTOCOL } }
  });
  try {
    await client.connect(clientTransport);
  } catch (error) {
    await stdio.close().catch(() => {});
    throw error;
  }
  return {
    client,
    async close(): Promise<void> {
      await client.close().catch(() => {});
      await stdio.close().catch(() => {});
    }
  };
}

function linkedTransportPair(): [LinkedTransport, LinkedTransport] {
  const left = new LinkedTransport();
  const right = new LinkedTransport();
  left.link(right);
  right.link(left);
  return [left, right];
}

class LinkedTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private peer?: LinkedTransport;
  private started = false;
  private closed = false;

  link(peer: LinkedTransport): void {
    this.peer = peer;
  }

  async start(): Promise<void> {
    if (this.started) throw new Error("Current MCP test transport is already started.");
    this.started = true;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.started || this.closed) throw new Error("Current MCP test transport is closed.");
    const peer = this.peer;
    if (!peer || peer.closed) throw new Error("Current MCP test transport peer is closed.");
    await new Promise<void>((resolve) => {
      queueMicrotask(() => {
        peer.onmessage?.(structuredClone(message));
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}
