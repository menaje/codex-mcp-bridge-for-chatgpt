import * as z from "zod/v4";
import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

type Extra = Parameters<ToolCallback<z.ZodObject>>[1];
type Definition<Input extends z.ZodType> = {
  inputSchema: Input; outputSchema: z.ZodType; [key: string]: unknown;
};
export type LegacyToolCompatibility = ReturnType<typeof installLegacyToolCompatibility>;

/** Protocol compatibility for already cached tool calls, without advertising
 * retired descriptors in tools/list. Each alias retains its original strict
 * schema, output validation, scope and widget checks. Remove with the retained
 * pre-consolidation UI contracts after the documented migration window.
 *
 * The SDK has no alias API. Intercept its public handler installation once;
 * never access private handler maps or alter ordinary SDK tool dispatch. */
export function installLegacyToolCompatibility(server: McpServer) {
  const aliases = new Map<string, (input: unknown, extra: Extra) => Promise<CallToolResult>>();
  const original = server.server.setRequestHandler;
  const install = original.bind(server.server);
  server.server.setRequestHandler = (schema, handler) => {
    if (!Object.is(schema, CallToolRequestSchema)) { install(schema, handler); return; }
    install(schema, async (request, extra) => {
      const call = CallToolRequestSchema.parse(request), alias = aliases.get(call.params.name);
      if (!alias) return handler(request, extra);
      try {
        if (call.params.task) throw new Error("Retained UI calls do not support task augmentation.");
        return await alias(call.params.arguments || {}, extra);
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
      }
    });
    server.server.setRequestHandler = original;
  };
  return {
    registerTool<Input extends z.ZodType>(name: string, definition: Definition<Input>, callback: ToolCallback<Input>): void {
      if (aliases.has(name)) throw new Error(`Duplicate retained tool alias: ${name}`);
      aliases.set(name, async (input, extra) => {
        const args = await definition.inputSchema.parseAsync(input);
        const result = await callback(args, extra);
        if (!result.isError) definition.outputSchema.parse(result.structuredContent);
        return result;
      });
    },
    names: () => [...aliases.keys()].sort()
  };
}
