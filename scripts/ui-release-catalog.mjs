import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

export const UI_RELEASE_CATALOG_FILENAME = "ui-release-catalog.json";
export const UI_RESOURCE_NAMES = Object.freeze(["settings", "activity", "dashboard", "question"]);
export const UI_ACTIVE_RESOURCE_NAMES = Object.freeze(["settings", "dashboard", "question"]);
export const UI_COMPATIBILITY_RESOURCE_NAMES = Object.freeze(["activity"]);

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const TOOL_PATTERN = /^codex_[a-z0-9_]+$/;

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
  if (root.catalogVersion !== 1) fail("catalogVersion must be 1");
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

  if (!Array.isArray(root.publishedBaselines) || root.publishedBaselines.length < 1 || root.publishedBaselines.length > 20) {
    fail("publishedBaselines must contain 1 to 20 releases");
  }
  const sourceIds = new Set();
  for (const [index, candidate] of root.publishedBaselines.entries()) {
    const baseline = record(candidate, `publishedBaselines[${index}]`);
    exactKeys(
      baseline,
      [
        "id",
        "version",
        "tag",
        "commit",
        "artifact",
        "supportStatus",
        "exitCondition",
        "resources"
      ],
      `publishedBaselines[${index}]`
    );
    uniqueIdentifier(baseline.id, sourceIds, `publishedBaselines[${index}].id`);
    stringMatching(baseline.version, SEMVER_PATTERN, `publishedBaselines[${index}].version`, 32);
    if (baseline.tag !== `v${baseline.version}`) fail(`publishedBaselines[${index}].tag must be v${baseline.version}`);
    stringMatching(baseline.commit, COMMIT_PATTERN, `publishedBaselines[${index}].commit`, 40);
    const artifact = record(baseline.artifact, `publishedBaselines[${index}].artifact`);
    exactKeys(artifact, ["filename", "sha256"], `publishedBaselines[${index}].artifact`);
    boundedString(artifact.filename, `publishedBaselines[${index}].artifact.filename`, 180);
    stringMatching(artifact.sha256, SHA256_PATTERN, `publishedBaselines[${index}].artifact.sha256`, 64);
    if (baseline.supportStatus !== "supported") fail(`publishedBaselines[${index}].supportStatus must be supported`);
    boundedString(baseline.exitCondition, `publishedBaselines[${index}].exitCondition`, 500);
    validateRevisionList(baseline.resources, `publishedBaselines[${index}].resources`);
  }

  if (!Array.isArray(root.temporaryExceptions) || root.temporaryExceptions.length > 50) {
    fail("temporaryExceptions must be an array with at most 50 entries");
  }
  for (const [index, candidate] of root.temporaryExceptions.entries()) {
    const exception = record(candidate, `temporaryExceptions[${index}]`);
    exactKeys(
      exception,
      [
        "id",
        "kind",
        "commit",
        "buildId",
        "sourceHash",
        "observedAt",
        "owner",
        "exitCondition",
        "resources"
      ],
      `temporaryExceptions[${index}]`
    );
    uniqueIdentifier(exception.id, sourceIds, `temporaryExceptions[${index}].id`);
    if (!new Set(["deployed-development", "published-candidate"]).has(exception.kind)) {
      fail(`temporaryExceptions[${index}].kind must be deployed-development or published-candidate`);
    }
    stringMatching(exception.commit, COMMIT_PATTERN, `temporaryExceptions[${index}].commit`, 40);
    boundedString(exception.buildId, `temporaryExceptions[${index}].buildId`, 160);
    stringMatching(exception.sourceHash, SHA256_PATTERN, `temporaryExceptions[${index}].sourceHash`, 64);
    const observedAt = boundedString(exception.observedAt, `temporaryExceptions[${index}].observedAt`, 40);
    if (!Number.isFinite(Date.parse(observedAt))) fail(`temporaryExceptions[${index}].observedAt must be an ISO timestamp`);
    boundedString(exception.owner, `temporaryExceptions[${index}].owner`, 120);
    boundedString(exception.exitCondition, `temporaryExceptions[${index}].exitCondition`, 500);
    validateRevisionList(exception.resources, `temporaryExceptions[${index}].resources`);
  }

  const retirement = record(root.retirement, "retirement");
  exactKeys(retirement, ["activity"], "retirement");
  const activity = record(retirement.activity, "retirement.activity");
  exactKeys(
    activity,
    [
      "lifecycle",
      "newPresentations",
      "replacement",
      "firstStableWithReplacement",
      "minimumSupportRule",
      "statePreserved"
    ],
    "retirement.activity"
  );
  if (activity.lifecycle !== "compatibility-only") fail("retirement.activity.lifecycle must be compatibility-only");
  if (activity.newPresentations !== false) fail("retirement.activity.newPresentations must be false");
  if (activity.replacement !== "dashboard-and-question") fail("retirement.activity.replacement must be dashboard-and-question");
  stringMatching(activity.firstStableWithReplacement, SEMVER_PATTERN, "retirement.activity.firstStableWithReplacement", 32);
  if (activity.minimumSupportRule !== "60-days-and-two-later-stable-releases") {
    fail("retirement.activity.minimumSupportRule must preserve the accepted compatibility window");
  }
  const preserved = ["activities", "agents", "jobs", "questions", "results", "idempotency"];
  exactResourceList(activity.statePreserved, preserved, "retirement.activity.statePreserved");

  const selected = catalogCompatibilityRevisions(root);
  for (const name of UI_COMPATIBILITY_RESOURCE_NAMES) {
    if (!selected.some((entry) => entry.revision.name === name)) {
      fail(`compatibility resource ${name} has no selected published or deployed revision`);
    }
  }
  return value;
}

export function uiReleaseCatalogSha256(value) {
  return createHash("sha256").update(`${JSON.stringify(value, null, 2)}\n`).digest("hex");
}

export function catalogCompatibilityRevisions(catalog) {
  const selected = [];
  for (const source of [...catalog.temporaryExceptions].reverse()) {
    for (const revision of source.resources) {
      selected.push({
        revision,
        inventory: "temporary-exception",
        sourceId: source.id,
        sourceKind: source.kind
      });
    }
  }
  for (const source of [...catalog.publishedBaselines].reverse()) {
    for (const revision of source.resources) {
      selected.push({
        revision,
        inventory: "published-baseline",
        sourceId: source.id,
        sourceKind: source.tag
      });
    }
  }
  return selected;
}

function validateRevisionList(value, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > UI_RESOURCE_NAMES.length) {
    fail(`${label} must contain 1 to ${UI_RESOURCE_NAMES.length} revisions`);
  }
  const names = new Set();
  for (const [index, candidate] of value.entries()) {
    const revision = record(candidate, `${label}[${index}]`);
    exactKeys(
      revision,
      ["name", "digest", "uri", "metadata", "presenterTool", "requiredTools"],
      `${label}[${index}]`
    );
    if (!UI_RESOURCE_NAMES.includes(revision.name)) fail(`${label}[${index}].name is unsupported`);
    if (names.has(revision.name)) fail(`${label} contains duplicate ${revision.name} revisions`);
    names.add(revision.name);
    stringMatching(revision.digest, SHA256_PATTERN, `${label}[${index}].digest`, 64);
    const uri = boundedString(revision.uri, `${label}[${index}].uri`, 240);
    if (!uri.startsWith("ui://codex-mcp-bridge/")) fail(`${label}[${index}].uri must use the product UI authority`);
    const metadata = record(revision.metadata, `${label}[${index}].metadata`);
    exactKeys(metadata, ["descriptor", "content"], `${label}[${index}].metadata`);
    const descriptor = record(metadata.descriptor, `${label}[${index}].metadata.descriptor`);
    for (const field of ["title", "description", "mimeType"]) {
      boundedString(descriptor[field], `${label}[${index}].metadata.descriptor.${field}`, 500);
    }
    if (descriptor.mimeType !== "text/html;profile=mcp-app") {
      fail(`${label}[${index}].metadata.descriptor.mimeType is unsupported`);
    }
    record(metadata.content, `${label}[${index}].metadata.content`);
    validateToolContract(
      { presenterTool: revision.presenterTool, requiredTools: revision.requiredTools },
      `${label}[${index}]`
    );
  }
}

function validateToolContract(value, label) {
  const contract = record(value, label);
  exactKeys(contract, ["presenterTool", "requiredTools"], label);
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

function uniqueIdentifier(value, seen, label) {
  const identifier = stringMatching(value, /^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/, label, 100);
  if (seen.has(identifier)) fail(`${label} must be unique`);
  seen.add(identifier);
  return identifier;
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
