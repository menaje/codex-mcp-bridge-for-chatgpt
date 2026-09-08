import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { CodexInteractionInput, CodexInteractionResponse } from "./upstream.js";

export function readElicitationInput(params: Record<string, unknown>): CodexInteractionInput {
  if (params.mode === "url") {
    if (typeof params.url !== "string" || params.url.length > 8_192 || typeof params.elicitationId !== "string") {
      throw new Error("Invalid MCP URL elicitation.");
    }
    const url = new URL(params.url);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("MCP elicitation URL must use HTTP or HTTPS without embedded credentials.");
    }
    return { url: url.href };
  }
  if (params.mode !== "form" || !record(params.requestedSchema)) {
    throw new Error("Unsupported MCP elicitation form mode.");
  }
  const schema = JSON.parse(JSON.stringify(params.requestedSchema, (key, value) =>
    value === null && ["required", "title", "description", "default", "format", "minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems"].includes(key)
      ? undefined : value));
  if (JSON.stringify(schema).length > 48_000 || schema.type !== "object" || !record(schema.properties) ||
      Object.keys(schema.properties).length > 32) throw new Error("Unsupported MCP elicitation form schema.");
  for (const [id, field] of Object.entries(schema.properties)) {
    if (!id || id.length > 200 || !record(field) ||
        !["string", "number", "integer", "boolean", "array"].includes(String(field.type)) ||
        (field.type === "array" && !stringItems(field.items))) {
      throw new Error("Unsupported MCP elicitation form field.");
    }
  }
  // Compile before presenting an answerable form. No response values or defaults
  // are logged or persisted; validation never fills defaults on the user's behalf.
  new AjvJsonSchemaValidator().getValidator(schema);
  return { requestedSchema: structuredClone(schema) };
}

export function elicitationResponse(
  input: CodexInteractionInput, response: CodexInteractionResponse
): { action: "accept" | "decline" | "cancel"; content: unknown } {
  const reply = response.elicitation;
  if (!reply || !["accept", "decline", "cancel"].includes(reply.action) || response.answers || response.decision) {
    throw new Error("MCP elicitation requires an accept, decline, or cancel response.");
  }
  if (reply.action !== "accept" || input.url) {
    if (reply.content != null) throw new Error("This MCP elicitation response does not accept form content.");
    return { action: reply.action, content: null };
  }
  if (!input.requestedSchema || !record(reply.content) || JSON.stringify(reply.content).length > 48_000) {
    throw new Error("MCP form acceptance requires valid form content.");
  }
  const properties = input.requestedSchema.properties as Record<string, unknown>;
  if (Object.keys(reply.content).some(key => !Object.hasOwn(properties, key)) ||
      !new AjvJsonSchemaValidator().getValidator(input.requestedSchema)(reply.content).valid) {
    throw new Error("MCP form content does not match the requested schema.");
  }
  return { action: "accept", content: reply.content };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringItems(value: unknown): boolean {
  if (!record(value)) return false;
  if (value.type === "string") return true;
  const options = value.anyOf || value.oneOf;
  return Array.isArray(options) && options.length > 0 && options.every(option => record(option) && typeof option.const === "string");
}
