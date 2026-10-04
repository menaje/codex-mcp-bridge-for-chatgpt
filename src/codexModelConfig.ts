import { parse } from "smol-toml";

/** Model choices do not belong to a different account when Codex records project trust. */
export function codexModelConfigInput(config: string): string {
  try {
    const parsed = parse(config, { integersAsBigInt: true });
    if (isTable(parsed.projects)) {
      for (const [project, settings] of Object.entries(parsed.projects)) {
        // Ignore only the native trust-only records. Preserve unknown project
        // settings, providers, authentication policy and all other config.
        if (isTable(settings) && Object.keys(settings).length === 1 &&
            (settings.trust_level === "trusted" || settings.trust_level === "untrusted")) {
          delete parsed.projects[project];
        }
      }
      if (Object.keys(parsed.projects).length === 0) delete parsed.projects;
    }
    return JSON.stringify(["toml", canonicalValue(parsed)]);
  } catch {
    // Unknown or malformed input must still invalidate the model cache when
    // its bytes change. This projection never grants execution admission.
    return JSON.stringify(["raw", config]);
  }
}

function isTable(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalValue(value: unknown): unknown {
  if (isTable(value)) {
    return ["table", Object.keys(value).sort().map(key => [key, canonicalValue(value[key])])];
  }
  if (Array.isArray(value)) return ["array", value.map(canonicalValue)];
  if (typeof value === "number") return ["number", Object.is(value, -0) ? "-0" : String(value)];
  if (typeof value === "bigint") return ["integer", String(value)];
  if (typeof value === "string" || typeof value === "boolean") return [typeof value, value];
  // Dates and future parser types keep the original bytes rather than losing
  // precision or accidentally merging distinct configuration values.
  throw new Error("Unsupported model configuration value.");
}
