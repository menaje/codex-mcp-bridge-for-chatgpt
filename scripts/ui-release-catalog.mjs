import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

export const UI_RELEASE_CATALOG_FILENAME = "ui-release-catalog.json";
export const UI_RESOURCE_NAMES = Object.freeze(["settings", "dashboard"]);
export const UI_ACTIVE_RESOURCE_NAMES = Object.freeze(["settings", "dashboard"]);
export const UI_COMPATIBILITY_RESOURCE_NAMES = Object.freeze([]);

const TOOL_PATTERN = /^codex_[a-z0-9_]+$/;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function loadUiReleaseCatalog(repoRoot) {
  const file = path.join(repoRoot, UI_RELEASE_CATALOG_FILENAME);
  let value;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${UI_RELEASE_CATALOG_FILENAME}: ${errorMessage(error)}`);
  }
  return validateUiReleaseCatalog(value);
}

export function validateUiReleaseCatalog(value) {
  const root = record(value, "UI release catalog");
  exactKeys(
    root,
    [
      "catalogVersion",
      "activeResources",
      "compatibilityResources",
      "currentContracts",
      "publishedBaselines",
      "temporaryExceptions",
      "retirement"
    ],
    "UI release catalog"
  );
  if (root.catalogVersion !== 4) fail("catalogVersion must be 4");
  exactResourceList(root.activeResources, UI_ACTIVE_RESOURCE_NAMES, "activeResources");
  exactResourceList(
    root.compatibilityResources,
    UI_COMPATIBILITY_RESOURCE_NAMES,
    "compatibilityResources"
  );
  const combined = [...root.activeResources, ...root.compatibilityResources];
  if (combined.length !== UI_RESOURCE_NAMES.length ||
      UI_RESOURCE_NAMES.some((name) => !combined.includes(name)) ||
      new Set(combined).size !== combined.length) {
    fail("activeResources plus compatibilityResources must classify every UI resource exactly once");
  }

  const currentContracts = record(root.currentContracts, "currentContracts");
  exactKeys(currentContracts, UI_ACTIVE_RESOURCE_NAMES, "currentContracts");
  for (const name of UI_ACTIVE_RESOURCE_NAMES) {
    validateToolContract(currentContracts[name], `currentContracts.${name}`);
  }

  if (!Array.isArray(root.publishedBaselines) || root.publishedBaselines.length !== 0) {
    fail("publishedBaselines must be empty in the current-only catalog");
  }
  if (!Array.isArray(root.temporaryExceptions) || root.temporaryExceptions.length !== 0) {
    fail("temporaryExceptions must be empty in the current-only catalog");
  }

  const retirement = record(root.retirement, "retirement");
  exactKeys(retirement, ["activity", "question"], "retirement");
  for (const [name, expectedReplacement, preserved] of [
    ["activity", "dashboard", ["activities", "agents", "jobs", "results", "idempotency"]],
    ["question", "host-conversation", ["questions", "idempotency"]]
  ]) {
    const entry = record(retirement[name], `retirement.${name}`);
    exactKeys(entry, ["lifecycle", "newPresentations", "replacement", "firstStableWithReplacement", "minimumSupportRule", "statePreserved"], `retirement.${name}`);
    if (entry.lifecycle !== "historical-revisions-retired") fail(`retirement.${name}.lifecycle must be historical-revisions-retired`);
    if (entry.newPresentations !== false) fail(`retirement.${name}.newPresentations must be false`);
    if (entry.replacement !== expectedReplacement) fail(`retirement.${name}.replacement must be ${expectedReplacement}`);
    stringMatching(entry.firstStableWithReplacement, SEMVER_PATTERN, `retirement.${name}.firstStableWithReplacement`, 32);
    if (entry.minimumSupportRule !== "none") fail(`retirement.${name}.minimumSupportRule must be none`);
    exactResourceList(entry.statePreserved, preserved, `retirement.${name}.statePreserved`);
  }

  return value;
}

export function uiReleaseCatalogSha256(value) {
  return createHash("sha256").update(`${JSON.stringify(value, null, 2)}\n`).digest("hex");
}

function validateToolContract(value, label) {
  const contract = record(value, label);
  exactKeys(contract, ["uriVersion", "presenterTool", "requiredTools"], label);
  if (!Number.isInteger(contract.uriVersion) || contract.uriVersion < 1 || contract.uriVersion > 9999) {
    fail(`${label}.uriVersion must be an integer between 1 and 9999`);
  }
  stringMatching(contract.presenterTool, TOOL_PATTERN, `${label}.presenterTool`, 100);
  if (!Array.isArray(contract.requiredTools) || contract.requiredTools.length < 1 || contract.requiredTools.length > 30) {
    fail(`${label}.requiredTools must contain 1 to 30 tools`);
  }
  const tools = contract.requiredTools.map((tool, toolIndex) =>
    stringMatching(tool, TOOL_PATTERN, `${label}.requiredTools[${toolIndex}]`, 100)
  );
  if (!tools.includes(contract.presenterTool)) fail(`${label}.requiredTools must include presenterTool`);
  if (new Set(tools).size !== tools.length) fail(`${label}.requiredTools must be unique`);
}

function exactResourceList(value, expected, label) {
  if (!Array.isArray(value) || value.length !== expected.length ||
      value.some((entry, index) => entry !== expected[index])) {
    fail(`${label} must be ${expected.join(", ")} in that order`);
  }
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.join("\0") !== wanted.join("\0")) fail(`${label} keys must be exactly ${wanted.join(", ")}`);
}

function boundedString(value, label, maxLength) {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength || /[\r\n\0]/.test(value)) {
    fail(`${label} must be a single-line string of at most ${maxLength} characters`);
  }
  return value;
}

function stringMatching(value, pattern, label, maxLength) {
  const string = boundedString(value, label, maxLength);
  if (!pattern.test(string)) fail(`${label} has an invalid format`);
  return string;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function fail(message) {
  throw new Error(`Invalid ${UI_RELEASE_CATALOG_FILENAME}: ${message}.`);
}
