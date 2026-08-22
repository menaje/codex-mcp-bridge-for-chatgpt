import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type BridgeBuildInfo = {
  version: string;
  commit: string;
  dirty: boolean;
  sourceHash: string;
  builtAt: string | null;
  id: string;
};

export const BRIDGE_BUILD_INFO: BridgeBuildInfo = loadBuildInfo();

function loadBuildInfo(): BridgeBuildInfo {
  try {
    const file = fileURLToPath(new URL("./build-info.json", import.meta.url));
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<BridgeBuildInfo>;
    if (
      typeof parsed.version === "string" &&
      typeof parsed.commit === "string" &&
      typeof parsed.dirty === "boolean" &&
      typeof parsed.sourceHash === "string" &&
      (parsed.builtAt === null || typeof parsed.builtAt === "string") &&
      typeof parsed.id === "string"
    ) {
      return parsed as BridgeBuildInfo;
    }
  } catch {
    // Development mode runs directly from src without a generated build record.
  }
  return {
    version: "0.2.0",
    commit: "development",
    dirty: true,
    sourceHash: "development",
    builtAt: null,
    id: "development"
  };
}
