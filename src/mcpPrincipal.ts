import { createHash } from "node:crypto";
import type { ServerContext } from "@modelcontextprotocol/server";

export function mcpBearerPrincipal(token: string): string {
  return "bridge-bearer-" + createHash("sha256").update("mcp-events/principal/v1\0" + token).digest("hex");
}

export function authenticatedMcpPrincipal(context: Pick<ServerContext, "http">): string | undefined {
  const auth = context.http?.authInfo;
  if (!auth?.scopes.includes("bridge") || (auth.expiresAt !== undefined && auth.expiresAt * 1_000 <= Date.now())) return undefined;
  return typeof auth.extra?.bridgeMcpPrincipal === "string" ? auth.extra.bridgeMcpPrincipal : undefined;
}
