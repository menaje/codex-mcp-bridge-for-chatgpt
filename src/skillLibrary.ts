import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import {
  assertJsonTextIntegrity,
  canonicalHumanText,
  decodeUtf8Strict,
  searchKey,
  utf8ByteLength,
  verbatimText
} from "./textIntegrity.js";

/** Every bridge skill is private, versioned, and owned by this Bridge. */
export const BRIDGE_SKILL_SOURCE = "bridge" as const;
export const SKILL_SOURCES = [BRIDGE_SKILL_SOURCE] as const;

export type SkillSource = (typeof SKILL_SOURCES)[number];

export const SKILL_EXECUTION_MODES = ["conversation", "codex", "conversation-or-codex"] as const;
export type SkillExecutionMode = (typeof SKILL_EXECUTION_MODES)[number];

export const SKILL_REQUIREMENT_KINDS = ["bridge-capability", "environment"] as const;
export type SkillRequirementKind = (typeof SKILL_REQUIREMENT_KINDS)[number];

/**
 * Shared transport-facing bounds for bridge-owned skills. The canonical
 * normalizers below remain the final authority because they select the shared
 * text-integrity policy for every persisted field.
 */
export const BRIDGE_SKILL_LIMITS = Object.freeze({
  nameMaxCharacters: 120,
  descriptionMaxCharacters: 2_000,
  instructionsMaxBytes: 512 * 1_024,
  referenceMaxBytes: 512 * 1_024,
  referenceTotalMaxBytes: 2 * 1_024 * 1_024,
  referenceMaxCount: 64,
  mediaTypeMaxCharacters: 200,
  requirementMaxCount: 32,
  requirementIdMaxCharacters: 120,
  requirementDescriptionMaxCharacters: 500,
  searchQueryMaxBytes: 1_000,
  // A delivery can include the maximum 512 KiB instruction body and 2 MiB of
  // materials plus its immutable metadata and declared conditions.
  executionBundleMaxBytes: 3 * 1_024 * 1_024,
  // A legal mutation can contain 512 KiB of instructions plus 2 MiB of
  // materials. JSON escaping can nearly double text payloads, so leave room
  // for the complete valid request instead of making the transport a smaller
  // hidden limit than the persisted skill contract.
  mutationWireMaxBytes: 6 * 1_024 * 1_024
});

/**
 * Requirements describe prerequisites; they never grant a tool, filesystem,
 * network, or execution permission. Environment requirements are deliberately
 * surfaced as external because the library cannot prove them available.
 */
export type BridgeSkillRequirementInput = {
  kind: SkillRequirementKind;
  id: string;
  description?: string;
};

export type SkillRequirement = {
  kind: SkillRequirementKind;
  id: string;
  description: string | null;
  availability: "available" | "external-environment" | "unsupported";
};

export type SkillReference = {
  skillId: string;
  source: SkillSource;
  /** A bridge version is immutable. */
  version: string;
};

export type SkillReferenceMaterial = {
  referenceId: string;
  name: string;
  mediaType: string;
  contentDigest: string;
  bytes: number;
};

export type SkillSummary = SkillReference & {
  name: string;
  description: string;
  contentDigest: string | null;
  enabled: boolean;
  availability: "available" | "metadata-only" | "disabled";
  /** This is deliberately a capability statement, not an authorization grant. */
  execution: {
    mode: SkillExecutionMode;
    note: string;
    requirements: SkillRequirement[];
  };
};

export type SkillDocument = {
  skill: SkillSummary;
  instructions: string;
  references: SkillReferenceMaterial[];
  sourceSnapshot: "versioned-bridge-record";
  warnings: string[];
};

export type SkillReferenceDocument = {
  skill: SkillReference;
  /** Declared conditions for the exact version that owns this material. */
  execution: SkillSummary["execution"];
  reference: SkillReferenceMaterial;
  content: string;
  sourceSnapshot: "versioned-bridge-record";
  warnings: string[];
};

export type SkillSearchResult = {
  skills: SkillSummary[];
};

export type SkillVersionSummary = SkillReference & {
  name: string;
  description: string;
  contentDigest: string;
  createdAt: string;
  referenceCount: number;
  execution: SkillSummary["execution"];
};

export type SkillVersionList = {
  skillId: string;
  source: SkillSource;
  currentVersion: string;
  enabled: boolean;
  versions: SkillVersionSummary[];
};

export type BridgeSkillReferenceInput = {
  name: string;
  content: string;
  mediaType?: string;
};

export type CreateBridgeSkillInput = {
  /** Reuse exactly for a transport retry of this logical mutation. */
  requestId: string;
  name: string;
  description: string;
  instructions: string;
  references?: readonly BridgeSkillReferenceInput[];
  executionMode?: SkillExecutionMode;
  requirements?: readonly BridgeSkillRequirementInput[];
};

export type UpdateBridgeSkillInput = {
  /** Reuse exactly for a transport retry of this logical mutation. */
  requestId: string;
  skillId: string;
  expectedVersion: string;
  name?: string;
  description?: string;
  instructions?: string;
  /** When supplied, replaces the complete material list for the new version. */
  references?: readonly BridgeSkillReferenceInput[];
  executionMode?: SkillExecutionMode;
  requirements?: readonly BridgeSkillRequirementInput[];
};

export type RestoreBridgeSkillInput = {
  requestId: string;
  skillId: string;
  /** Current version observed immediately before restoring. */
  expectedVersion: string;
  /** Historical immutable version to copy into a new current version. */
  sourceVersion: string;
};

export type SetBridgeSkillEnabledInput = {
  requestId: string;
  skillId: string;
  expectedVersion: string;
  enabled: boolean;
};

export type PreparedSkillDelivery = {
  /** Public/auditable exact selections; this does not claim validation of the completed work. */
  requiredSkills: Array<SkillReference & {
    name: string;
    contentDigest: string | null;
    delivery: "bridge-instruction-bundle";
  }>;
  /** Bridge-owned, versioned instructions and materials scoped to one execution only. */
  promptPreamble: string;
};

type BridgeSkillVersionRecord = {
  version: string;
  createdAt: string;
  /** Preserve metadata with the immutable instructions and materials. */
  name: string;
  description: string;
  contentDigest: string;
  /** v1 covered name, description, instructions, and materials only. */
  contentDigestVersion: 1 | 2;
  references: Array<SkillReferenceMaterial & { file: string }>;
  executionMode: SkillExecutionMode;
  requirements: NormalizedRequirementInput[];
};

type BridgeSkillRecord = {
  skillId: string;
  name: string;
  nameKey: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  currentVersion: string;
  /** Lifecycle is intentionally outside an immutable content version. */
  enabled: boolean;
  versions: BridgeSkillVersionRecord[];
};

type BridgeSkillMutationReceipt = {
  requestId: string;
  actionHash: string;
  skill: SkillSummary;
  createdAt: string;
};

type BridgeSkillMutationLockOwner = {
  token: string;
  pid: number;
  host: string;
};

type BridgeSkillIndex = {
  schemaVersion: 2;
  skills: BridgeSkillRecord[];
  mutationReceipts: BridgeSkillMutationReceipt[];
};

type LoadedBridgeVersion = {
  record: BridgeSkillRecord;
  version: BridgeSkillVersionRecord;
  instructions: string;
  references: Array<SkillReferenceMaterial & { file: string; content: string }>;
};

type SkillLibraryOptions = {
  directory: string;
  now?: () => number;
};

const SKILL_NAME_MAX_LENGTH = BRIDGE_SKILL_LIMITS.nameMaxCharacters;
const SKILL_DESCRIPTION_MAX_LENGTH = BRIDGE_SKILL_LIMITS.descriptionMaxCharacters;
const SKILL_INSTRUCTIONS_MAX_BYTES = BRIDGE_SKILL_LIMITS.instructionsMaxBytes;
const SKILL_REFERENCE_MAX_BYTES = BRIDGE_SKILL_LIMITS.referenceMaxBytes;
const SKILL_REFERENCE_TOTAL_MAX_BYTES = BRIDGE_SKILL_LIMITS.referenceTotalMaxBytes;
const SKILL_REFERENCE_MAX_COUNT = BRIDGE_SKILL_LIMITS.referenceMaxCount;
const SKILL_REQUIREMENT_MAX_COUNT = BRIDGE_SKILL_LIMITS.requirementMaxCount;
const SKILL_REQUIREMENT_ID_MAX_LENGTH = BRIDGE_SKILL_LIMITS.requirementIdMaxCharacters;
const SKILL_REQUIREMENT_DESCRIPTION_MAX_LENGTH = BRIDGE_SKILL_LIMITS.requirementDescriptionMaxCharacters;
const EXECUTION_BUNDLE_MAX_BYTES = BRIDGE_SKILL_LIMITS.executionBundleMaxBytes;
const BRIDGE_SKILL_ID = /^bridge_[a-f0-9]{32}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const BRIDGE_SKILL_INDEX = "index.json";
const BRIDGE_SKILL_MUTATION_LOCK = ".mutation.lock";
const BRIDGE_SKILL_MUTATION_LOCK_OWNER = "owner.json";
const BRIDGE_SKILL_MUTATION_LOCK_RECOVERY = ".recovery";
const MUTATION_LOCK_STALE_MS = 120_000;
const MUTATION_LOCK_RETRY_LIMIT = 80;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUPPORTED_BRIDGE_CAPABILITIES = new Set(["conversation", "codex-task", "reference-text"]);

/**
 * One process can receive several HTTP MCP requests concurrently. Lock the
 * small index mutation rather than relying on each fresh McpServer instance.
 */
const mutationQueues = new Map<string, Promise<void>>();

/** Shared source-of-truth for model lookup and bridge-owned authoring. */
export class SkillLibrary {
  private readonly store: BridgeSkillStore;

  constructor(options: SkillLibraryOptions) {
    if (!path.isAbsolute(options.directory)) {
      throw new Error("SKILL_LIBRARY_DIRECTORY_INVALID: Bridge skills directory must be absolute.");
    }
    this.store = new BridgeSkillStore(path.normalize(options.directory), options.now || Date.now);
  }

  async search(input: { query?: string; limit?: number; includeDisabled?: boolean }): Promise<SkillSearchResult> {
    const query = normalizeSearchQuery(input.query);
    const limit = normalizeSearchLimit(input.limit);
    const bridge = await this.store.list();
    return {
      skills: bridge.map((record) => bridgeSummary(record))
        .filter((skill) => input.includeDisabled || skill.enabled)
        .filter((skill) => matchesSearch(skill, query))
        .sort(compareSkillSummaries)
        .slice(0, limit)
    };
  }

  async read(input: { reference: SkillReference }): Promise<SkillDocument> {
    return bridgeDocument(await this.store.readVersion(input.reference));
  }

  async readReference(input: {
    reference: SkillReference;
    referenceId: string;
  }): Promise<SkillReferenceDocument> {
    const loaded = await this.store.readVersion(input.reference);
    const reference = loaded.references.find((candidate) => candidate.referenceId === input.referenceId);
    if (!reference) throw new Error("SKILL_REFERENCE_NOT_FOUND: The selected version has no matching reference material.");
    return {
      skill: input.reference,
      execution: bridgeSummary(loaded.record, loaded.version.version).execution,
      reference: publicReference(reference),
      content: reference.content,
      sourceSnapshot: "versioned-bridge-record",
      warnings: skillWarnings(loaded.record, loaded.version)
    };
  }

  createBridgeSkill(input: CreateBridgeSkillInput): Promise<SkillSummary> {
    return this.store.create(input);
  }

  updateBridgeSkill(input: UpdateBridgeSkillInput): Promise<SkillSummary> {
    return this.store.update(input);
  }

  restoreBridgeSkill(input: RestoreBridgeSkillInput): Promise<SkillSummary> {
    return this.store.restore(input);
  }

  setBridgeSkillEnabled(input: SetBridgeSkillEnabledInput): Promise<SkillSummary> {
    return this.store.setEnabled(input);
  }

  async listBridgeSkillVersions(input: { skillId: string }): Promise<SkillVersionList> {
    return this.store.listVersions(input.skillId);
  }

  /** Resolve bridge-owned skills immediately before one Codex turn. */
  async prepareForExecution(input: {
    references: readonly SkillReference[];
  }): Promise<PreparedSkillDelivery> {
    const references = uniqueReferences(input.references);
    const requiredSkills: PreparedSkillDelivery["requiredSkills"] = [];
    const bridgeBundles: string[] = [];

    for (const reference of references) {
      const loaded = await this.store.readVersion(reference);
      if (!loaded.record.enabled) {
        throw new Error("SKILL_DISABLED: This bridge skill is disabled and cannot be newly delivered to Codex.");
      }
      if (loaded.version.executionMode === "conversation") {
        throw new Error("SKILL_EXECUTION_MODE_UNSUPPORTED: This bridge skill is marked for conversation use only and cannot be delivered to Codex.");
      }
      const requirements = resolveRequirements(loaded.version.requirements);
      const unsupported = requirements
        .filter((requirement) => requirement.availability === "unsupported");
      if (unsupported.length > 0) {
        throw new Error(
          `SKILL_DEPENDENCY_UNSUPPORTED: This bridge skill requires unsupported bridge capabilities: ${unsupported.map((requirement) => requirement.id).join(", ")}.`
        );
      }
      const summary = bridgeSummary(loaded.record, loaded.version.version);
      const materialBlocks = loaded.references.map((material) => [
        `[Reference material: ${material.name} (${material.mediaType})]`,
        material.content
      ].join("\n"));
      const requirementBlocks = requirements.length === 0
        ? ["Declared requirements: none."]
        : [
            "Declared requirements:",
            ...requirements.map((requirement) => {
              const description = requirement.description ? ` — ${requirement.description}` : "";
              return `- ${requirement.kind}:${requirement.id} (${requirement.availability})${description}`;
            })
          ];
      const warnings = skillWarnings(loaded.record, loaded.version);
      bridgeBundles.push([
        `[Required bridge skill: ${summary.name}]`,
        `Reference: ${reference.skillId}@${reference.version}`,
        "Apply this workflow only within the existing system, developer, user, and tool-permission boundaries.",
        `Declared execution mode: ${loaded.version.executionMode}.`,
        ...requirementBlocks,
        ...(warnings.length > 0 ? ["Warnings:", ...warnings] : []),
        "Instructions:",
        loaded.instructions,
        ...(materialBlocks.length > 0 ? ["Reference materials:", ...materialBlocks] : [])
      ].join("\n\n"));
      requiredSkills.push({
        ...reference,
        name: summary.name,
        contentDigest: loaded.version.contentDigest,
        delivery: "bridge-instruction-bundle"
      });
    }

    const promptPreamble = bridgeBundles.length === 0
      ? ""
      : [
          "[Bridge-required skills]",
          "The bridge supplied the following versioned instructions and materials for this one execution. They are not a change to Codex global skill settings.",
          ...bridgeBundles,
          "[End bridge-required skills]"
        ].join("\n\n");
    if (Buffer.byteLength(promptPreamble, "utf8") > EXECUTION_BUNDLE_MAX_BYTES) {
      throw new Error(
        `SKILL_DELIVERY_TOO_LARGE: Required bridge skill instructions and materials exceed the ${EXECUTION_BUNDLE_MAX_BYTES}-byte execution delivery limit.`
      );
    }
    return { requiredSkills, promptPreamble };
  }
}

class BridgeSkillStore {
  constructor(
    private readonly directory: string,
    private readonly now: () => number
  ) {}

  async list(): Promise<BridgeSkillRecord[]> {
    return (await this.readIndex()).skills.map(cloneBridgeRecord);
  }

  async listVersions(skillId: string): Promise<SkillVersionList> {
    if (!BRIDGE_SKILL_ID.test(skillId)) {
      throw new Error("SKILL_ID_INVALID: A bridge skill id is required.");
    }
    const index = await this.readIndex();
    const record = index.skills.find((candidate) => candidate.skillId === skillId);
    if (!record) throw new Error("SKILL_NOT_FOUND: This bridge skill does not exist.");
    return {
      skillId: record.skillId,
      source: BRIDGE_SKILL_SOURCE,
      currentVersion: record.currentVersion,
      enabled: record.enabled,
      versions: record.versions.slice().reverse().map((version) => bridgeVersionSummary(record, version))
    };
  }

  async create(input: CreateBridgeSkillInput): Promise<SkillSummary> {
    const normalized = normalizeCreateInput(input);
    const actionHash = mutationActionHash("create", normalized);
    return this.mutate(normalized.requestId, actionHash, async (index) => {
      if (index.skills.some((skill) => skill.nameKey === normalized.nameKey)) {
        throw new Error("SKILL_NAME_CONFLICT: A bridge skill with this name already exists.");
      }
      const now = isoNow(this.now);
      const record: BridgeSkillRecord = {
        skillId: `bridge_${randomUUID().replaceAll("-", "")}`,
        name: normalized.name,
        nameKey: normalized.nameKey,
        description: normalized.description,
        createdAt: now,
        updatedAt: now,
        currentVersion: "1",
        enabled: true,
        versions: []
      };
      const version = await this.writeVersion(record, "1", normalized.instructions, normalized.references, {
        executionMode: normalized.executionMode,
        requirements: normalized.requirements,
        createdAt: now
      });
      record.versions.push(version);
      index.skills.push(record);
      return bridgeSummary(record);
    });
  }

  async update(input: UpdateBridgeSkillInput): Promise<SkillSummary> {
    const normalized = normalizeUpdateInput(input);
    const actionHash = mutationActionHash("update", normalized);
    return this.mutate(normalized.requestId, actionHash, async (index) => {
      const record = index.skills.find((candidate) => candidate.skillId === normalized.skillId);
      if (!record) throw new Error("SKILL_NOT_FOUND: This bridge skill does not exist.");
      if (record.currentVersion !== normalized.expectedVersion) {
        throw new Error("SKILL_VERSION_CHANGED: Read the current bridge skill and retry with its exact current version.");
      }
      const current = await this.loadVersion(record, record.currentVersion);
      const name = normalized.name || record.name;
      const nameKey = normalized.name ? normalized.nameKey! : record.nameKey;
      if (index.skills.some((candidate) => candidate.skillId !== record.skillId && candidate.nameKey === nameKey)) {
        throw new Error("SKILL_NAME_CONFLICT: A bridge skill with this name already exists.");
      }
      const description = normalized.description ?? record.description;
      const instructions = normalized.instructions ?? current.instructions;
      const references = normalized.references ?? current.references.map((reference) => ({
        name: reference.name,
        content: reference.content,
        mediaType: reference.mediaType
      }));
      const executionMode = normalized.executionMode ?? current.version.executionMode;
      const requirements = normalized.requirements ?? current.version.requirements;
      const nextVersion = String(Number.parseInt(record.currentVersion, 10) + 1);
      if (!/^[1-9]\d*$/.test(nextVersion)) {
        throw new Error("SKILL_VERSION_INVALID: The bridge skill version counter is invalid.");
      }
      const now = isoNow(this.now);
      const version = await this.writeVersion({ ...record, name, description }, nextVersion, instructions, references, {
        executionMode,
        requirements,
        createdAt: now
      });
      record.name = name;
      record.nameKey = nameKey;
      record.description = description;
      record.currentVersion = nextVersion;
      record.updatedAt = now;
      record.versions.push(version);
      return bridgeSummary(record);
    });
  }

  async restore(input: RestoreBridgeSkillInput): Promise<SkillSummary> {
    const normalized = normalizeRestoreInput(input);
    const actionHash = mutationActionHash("restore", normalized);
    return this.mutate(normalized.requestId, actionHash, async (index) => {
      const record = index.skills.find((candidate) => candidate.skillId === normalized.skillId);
      if (!record) throw new Error("SKILL_NOT_FOUND: This bridge skill does not exist.");
      if (record.currentVersion !== normalized.expectedVersion) {
        throw new Error("SKILL_VERSION_CHANGED: Read the current bridge skill and retry with its exact current version.");
      }
      const source = await this.loadVersion(record, normalized.sourceVersion);
      const sourceNameKey = skillNameKey(source.version.name);
      if (index.skills.some((candidate) => candidate.skillId !== record.skillId && candidate.nameKey === sourceNameKey)) {
        throw new Error("SKILL_NAME_CONFLICT: A bridge skill with this name already exists.");
      }
      const nextVersion = nextBridgeVersion(record.currentVersion);
      const now = isoNow(this.now);
      const version = await this.writeVersion(
        { ...record, name: source.version.name, description: source.version.description },
        nextVersion,
        source.instructions,
        source.references.map((reference) => ({
          name: reference.name,
          content: reference.content,
          mediaType: reference.mediaType
        })),
        {
          executionMode: source.version.executionMode,
          requirements: source.version.requirements,
          createdAt: now
        }
      );
      record.name = source.version.name;
      record.nameKey = sourceNameKey;
      record.description = source.version.description;
      record.currentVersion = nextVersion;
      record.updatedAt = now;
      record.versions.push(version);
      return bridgeSummary(record);
    });
  }

  async setEnabled(input: SetBridgeSkillEnabledInput): Promise<SkillSummary> {
    const normalized = normalizeSetEnabledInput(input);
    const actionHash = mutationActionHash("set-enabled", normalized);
    return this.mutate(normalized.requestId, actionHash, async (index) => {
      const record = index.skills.find((candidate) => candidate.skillId === normalized.skillId);
      if (!record) throw new Error("SKILL_NOT_FOUND: This bridge skill does not exist.");
      if (record.currentVersion !== normalized.expectedVersion) {
        throw new Error("SKILL_VERSION_CHANGED: Read the current bridge skill and retry with its exact current version.");
      }
      record.enabled = normalized.enabled;
      record.updatedAt = isoNow(this.now);
      return bridgeSummary(record);
    });
  }

  async readVersion(reference: SkillReference): Promise<LoadedBridgeVersion> {
    assertBridgeReference(reference);
    const index = await this.readIndex();
    const record = index.skills.find((candidate) => candidate.skillId === reference.skillId);
    if (!record) throw new Error("SKILL_NOT_FOUND: This bridge skill does not exist.");
    const version = record.versions.find((candidate) => candidate.version === reference.version);
    if (!version) throw new Error("SKILL_VERSION_NOT_FOUND: This bridge skill version does not exist.");
    return this.loadVersion(record, version.version);
  }

  private async loadVersion(record: BridgeSkillRecord, versionValue: string): Promise<LoadedBridgeVersion> {
    const version = record.versions.find((candidate) => candidate.version === versionValue);
    if (!version) throw new Error("SKILL_VERSION_NOT_FOUND: This bridge skill version does not exist.");
    const root = this.versionDirectory(record.skillId, version.version);
    const instructions = await readBoundedText(path.join(root, "SKILL.md"), SKILL_INSTRUCTIONS_MAX_BYTES + 16 * 1024, "Bridge skill instructions")
      .then((value) => stripBridgeFrontmatter(value, version.contentDigestVersion));
    const references = await Promise.all(version.references.map(async (reference) => {
      const filePath = await safeDescendant(root, reference.file);
      if (!filePath) throw new Error("SKILL_LIBRARY_CORRUPT: A bridge skill reference file escapes its version directory.");
      const content = await readBoundedText(filePath, SKILL_REFERENCE_MAX_BYTES, "Bridge skill reference material");
      const digest = sha256(content);
      if (digest !== reference.contentDigest) {
        throw new Error("SKILL_LIBRARY_CORRUPT: A versioned bridge skill reference no longer matches its recorded content digest.");
      }
      return { ...reference, content };
    }));
    const computedDigest = bridgeVersionDigest(
      version.name,
      version.description,
      instructions,
      references,
      version.executionMode,
      version.requirements,
      version.contentDigestVersion
    );
    if (computedDigest !== version.contentDigest) {
      throw new Error("SKILL_LIBRARY_CORRUPT: A versioned bridge skill no longer matches its recorded content digest.");
    }
    return { record: cloneBridgeRecord(record), version: { ...version, references: version.references.map((reference) => ({ ...reference })) }, instructions, references };
  }

  private async writeVersion(
    record: Pick<BridgeSkillRecord, "skillId" | "name" | "description">,
    versionValue: string,
    instructions: string,
    references: readonly NormalizedReferenceInput[],
    options: {
      executionMode: SkillExecutionMode;
      requirements: readonly NormalizedRequirementInput[];
      createdAt: string;
    }
  ): Promise<BridgeSkillVersionRecord> {
    const directory = this.versionDirectory(record.skillId, versionValue);
    const staging = `${directory}.staging-${randomUUID()}`;
    const storedReferences = references.map((reference) => ({
      referenceId: `ref_${randomUUID().replaceAll("-", "")}`,
      name: reference.name,
      mediaType: reference.mediaType,
      contentDigest: sha256(reference.content),
      bytes: utf8ByteLength(reference.content, "Reference material"),
      file: ""
    }));
    for (const reference of storedReferences) reference.file = `references/${reference.referenceId}.txt`;
    const contentDigest = bridgeVersionDigest(
      record.name,
      record.description,
      instructions,
      storedReferences.map((reference, index) => ({ ...reference, content: references[index]!.content })),
      options.executionMode,
      options.requirements,
      2
    );
    try {
      await mkdir(path.join(staging, "references"), { recursive: true, mode: 0o700 });
      await writeFile(path.join(staging, "SKILL.md"), bridgeSkillMarkdown(record.name, record.description, instructions), { encoding: "utf8", mode: 0o600 });
      await Promise.all(storedReferences.map((reference, index) =>
        writeFile(path.join(staging, reference.file), references[index]!.content, { encoding: "utf8", mode: 0o600 })
      ));
      await writeFile(path.join(staging, "manifest.json"), JSON.stringify({
        version: versionValue,
        name: record.name,
        description: record.description,
        contentDigest,
        contentDigestVersion: 2,
        references: storedReferences.map(publicReference),
        executionMode: options.executionMode,
        requirements: options.requirements
      }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
      await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
      await rename(staging, directory);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    return {
      version: versionValue,
      createdAt: options.createdAt,
      name: record.name,
      description: record.description,
      contentDigest,
      contentDigestVersion: 2,
      references: storedReferences,
      executionMode: options.executionMode,
      requirements: options.requirements.map(cloneRequirement)
    };
  }

  private async readIndex(): Promise<BridgeSkillIndex> {
    let raw: string;
    try {
      raw = decodeUtf8Strict(
        await readFile(path.join(this.directory, BRIDGE_SKILL_INDEX)),
        "Bridge skill index"
      );
    } catch (error) {
      if (isErrno(error, "ENOENT")) return { schemaVersion: 2, skills: [], mutationReceipts: [] };
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
      assertJsonTextIntegrity(parsed, "Bridge skill index");
    } catch {
      throw new Error("SKILL_LIBRARY_CORRUPT: Bridge skill index is not valid JSON.");
    }
    return validateIndex(parsed);
  }

  private async writeIndex(index: BridgeSkillIndex): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = path.join(this.directory, BRIDGE_SKILL_INDEX);
    const temporary = path.join(this.directory, `.${BRIDGE_SKILL_INDEX}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(index, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private versionDirectory(skillId: string, version: string): string {
    return path.join(this.directory, skillId, "versions", version);
  }

  private async mutate(
    requestId: string,
    actionHash: string,
    operation: (index: BridgeSkillIndex) => Promise<SkillSummary>
  ): Promise<SkillSummary> {
    const existing = mutationQueues.get(this.directory) || Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const queued = existing.then(() => turn, () => turn);
    mutationQueues.set(this.directory, queued);
    await existing.catch(() => undefined);
    try {
      return await this.withMutationLock(async () => {
        const index = await this.readIndex();
        await this.recoverOrphanedVersions(index);
        const receipt = index.mutationReceipts.find((candidate) => candidate.requestId === requestId);
        if (receipt) {
          if (receipt.actionHash !== actionHash) {
            throw new Error("SKILL_MUTATION_REQUEST_REUSED: requestId was already used for a different bridge skill mutation.");
          }
          return cloneSkillSummary(receipt.skill);
        }
        const skill = await operation(index);
        index.mutationReceipts = cloneMutationReceipts([
          ...index.mutationReceipts,
          { requestId, actionHash, skill: cloneSkillSummary(skill), createdAt: isoNow(this.now) }
        ]);
        await this.writeIndex(index);
        return skill;
      });
    } finally {
      release();
      if (mutationQueues.get(this.directory) === queued) mutationQueues.delete(this.directory);
    }
  }

  private async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lockDirectory = path.join(this.directory, BRIDGE_SKILL_MUTATION_LOCK);
    for (let attempt = 0; attempt < MUTATION_LOCK_RETRY_LIMIT; attempt += 1) {
      const owner = await this.tryAcquireMutationLock(lockDirectory);
      if (!owner) {
        const age = await stat(lockDirectory)
          .then((information) => Date.now() - information.mtimeMs)
          .catch(() => 0);
        if (age > MUTATION_LOCK_STALE_MS && await this.reclaimMutationLock(lockDirectory)) {
          continue;
        }
        await waitForMutationLock(Math.min(25 + attempt * 10, 250));
        continue;
      }
      try {
        return await operation();
      } finally {
        await this.releaseMutationLock(lockDirectory, owner.token);
      }
    }
    throw new Error("SKILL_LIBRARY_BUSY: Another bridge process is updating the skill library. Retry the same requestId shortly.");
  }

  /**
   * Build a populated private directory first, then rename it into place. A
   * lock is therefore never visible without an owner identity that lets a
   * late holder avoid deleting a newer holder's lock.
   */
  private async tryAcquireMutationLock(lockDirectory: string): Promise<BridgeSkillMutationLockOwner | undefined> {
    const owner: BridgeSkillMutationLockOwner = {
      token: randomUUID(),
      pid: process.pid,
      host: hostname()
    };
    const staging = `${lockDirectory}.staging-${owner.token}`;
    let acquired = false;
    try {
      await mkdir(staging, { mode: 0o700 });
      await writeFile(
        path.join(staging, BRIDGE_SKILL_MUTATION_LOCK_OWNER),
        JSON.stringify(owner),
        { encoding: "utf8", mode: 0o600, flag: "wx" }
      );
      await rename(staging, lockDirectory);
      acquired = true;
      return owner;
    } catch (error) {
      if (isErrno(error, "EEXIST") || isErrno(error, "ENOTEMPTY")) return undefined;
      throw error;
    } finally {
      if (!acquired) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Claim a stale lock before removing it. The claim lives inside the existing
   * lock directory, so exactly one reclaimer can win while new owners still
   * cannot acquire the outer directory. That closes the stale-removal race in
   * which two processes could otherwise delete a lock acquired in between.
   */
  private async reclaimMutationLock(lockDirectory: string): Promise<boolean> {
    if (!await this.clearRecoverableMutationLockRecovery(lockDirectory)) return false;

    const staleOwner = await readMutationLockOwner(lockDirectory);
    if (staleOwner && !canRecoverOwnedMutationLock(staleOwner)) return false;

    const recoveryDirectory = path.join(lockDirectory, BRIDGE_SKILL_MUTATION_LOCK_RECOVERY);
    const claimant = await this.tryAcquireMutationLockRecovery(recoveryDirectory);
    if (!claimant) return false;

    const currentOwner = await readMutationLockOwner(lockDirectory);
    const currentClaimant = await readMutationLockOwner(recoveryDirectory);
    if (!sameMutationLockOwner(staleOwner, currentOwner) || !sameMutationLockOwner(claimant, currentClaimant)) {
      await this.releaseMutationLockRecovery(recoveryDirectory, claimant.token);
      return false;
    }

    // No correct contender can create the outer directory until this removal
    // finishes: the claimed directory keeps the old lock present throughout.
    await rm(lockDirectory, { recursive: true, force: true });
    return true;
  }

  /**
   * A crashed recovery claimant is itself retired only after its local PID is
   * known to be dead. Moving the claim aside is atomic and never removes the
   * outer lock, so a later reclaimer can safely start over.
   */
  private async clearRecoverableMutationLockRecovery(lockDirectory: string): Promise<boolean> {
    const recoveryDirectory = path.join(lockDirectory, BRIDGE_SKILL_MUTATION_LOCK_RECOVERY);
    const information = await stat(recoveryDirectory).catch((error) => {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    });
    if (!information) return true;
    if (!information.isDirectory()) return false;

    const claimant = await readMutationLockOwner(recoveryDirectory);
    if (claimant && !canRecoverOwnedMutationLock(claimant)) return false;
    if (Date.now() - information.mtimeMs <= MUTATION_LOCK_STALE_MS) return false;

    const retiredDirectory = `${recoveryDirectory}.retired-${randomUUID()}`;
    try {
      await rename(recoveryDirectory, retiredDirectory);
    } catch (error) {
      if (isErrno(error, "ENOENT") || isErrno(error, "EEXIST") || isErrno(error, "ENOTEMPTY")) return false;
      throw error;
    }
    await rm(retiredDirectory, { recursive: true, force: true }).catch(() => undefined);
    return true;
  }

  private async tryAcquireMutationLockRecovery(
    recoveryDirectory: string
  ): Promise<BridgeSkillMutationLockOwner | undefined> {
    const owner: BridgeSkillMutationLockOwner = {
      token: randomUUID(),
      pid: process.pid,
      host: hostname()
    };
    const staging = `${recoveryDirectory}.staging-${owner.token}`;
    let acquired = false;
    try {
      await mkdir(staging, { mode: 0o700 });
      await writeFile(
        path.join(staging, BRIDGE_SKILL_MUTATION_LOCK_OWNER),
        JSON.stringify(owner),
        { encoding: "utf8", mode: 0o600, flag: "wx" }
      );
      await rename(staging, recoveryDirectory);
      acquired = true;
      return owner;
    } catch (error) {
      if (isErrno(error, "EEXIST") || isErrno(error, "ENOTEMPTY") || isErrno(error, "ENOENT")) return undefined;
      throw error;
    } finally {
      if (!acquired) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async releaseMutationLockRecovery(recoveryDirectory: string, token: string): Promise<void> {
    const owner = await readMutationLockOwner(recoveryDirectory);
    if (!owner || owner.token !== token) return;
    await rm(recoveryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }

  private async releaseMutationLock(lockDirectory: string, token: string): Promise<void> {
    const owner = await readMutationLockOwner(lockDirectory);
    if (!owner || owner.token !== token) return;
    await rm(lockDirectory, { recursive: true, force: true }).catch(() => undefined);
  }

  private async recoverOrphanedVersions(index: BridgeSkillIndex): Promise<void> {
    const known = new Set(index.skills.flatMap((skill) =>
      skill.versions.map((version) => `${skill.skillId}\u0000${version.version}`)
    ));
    const skillDirectories = await readdir(this.directory, { withFileTypes: true }).catch((error) => {
      if (isErrno(error, "ENOENT")) return [];
      throw error;
    });
    for (const entry of skillDirectories) {
      if (!entry.isDirectory() || !BRIDGE_SKILL_ID.test(entry.name)) continue;
      const versionsDirectory = path.join(this.directory, entry.name, "versions");
      const versionDirectories = await readdir(versionsDirectory, { withFileTypes: true }).catch((error) => {
        if (isErrno(error, "ENOENT")) return [];
        throw error;
      });
      for (const versionEntry of versionDirectories) {
        if (!versionEntry.isDirectory()) continue;
        const isVersion = /^[1-9]\d*$/.test(versionEntry.name);
        const isStaging = /^[1-9]\d*\.staging-[a-f0-9-]+$/i.test(versionEntry.name);
        if (!isStaging && (!isVersion || known.has(`${entry.name}\u0000${versionEntry.name}`))) continue;
        await rm(path.join(versionsDirectory, versionEntry.name), { recursive: true, force: true });
      }
    }
  }
}

function bridgeSummary(record: BridgeSkillRecord, selectedVersion = record.currentVersion): SkillSummary {
  const current = record.versions.find((version) => version.version === selectedVersion);
  if (!current) throw new Error("SKILL_LIBRARY_CORRUPT: Bridge skill has no selected version.");
  const requirements = resolveRequirements(current.requirements);
  return {
    skillId: record.skillId,
    source: BRIDGE_SKILL_SOURCE,
    version: current.version,
    name: current.name,
    description: current.description,
    contentDigest: current.contentDigest,
    enabled: record.enabled,
    availability: record.enabled ? "available" : "disabled",
    execution: {
      mode: current.executionMode,
      note: executionNote(current.executionMode, requirements),
      requirements
    }
  };
}

function bridgeVersionSummary(record: BridgeSkillRecord, version: BridgeSkillVersionRecord): SkillVersionSummary {
  const summary = bridgeSummary(record, version.version);
  return {
    skillId: summary.skillId,
    source: summary.source,
    version: summary.version,
    name: summary.name,
    description: summary.description,
    contentDigest: version.contentDigest,
    createdAt: version.createdAt,
    referenceCount: version.references.length,
    execution: cloneExecution(summary.execution)
  };
}

function bridgeDocument(loaded: LoadedBridgeVersion): SkillDocument {
  return {
    skill: bridgeSummary(loaded.record, loaded.version.version),
    instructions: loaded.instructions,
    references: loaded.references.map(publicReference),
    sourceSnapshot: "versioned-bridge-record",
    warnings: skillWarnings(loaded.record, loaded.version)
  };
}

function publicReference(reference: SkillReferenceMaterial & { file?: string; content?: string }): SkillReferenceMaterial {
  return {
    referenceId: reference.referenceId,
    name: reference.name,
    mediaType: reference.mediaType,
    contentDigest: reference.contentDigest,
    bytes: reference.bytes
  };
}

function normalizeCreateInput(input: CreateBridgeSkillInput): {
  requestId: string;
  name: string;
  nameKey: string;
  description: string;
  instructions: string;
  references: NormalizedReferenceInput[];
  executionMode: SkillExecutionMode;
  requirements: NormalizedRequirementInput[];
} {
  const name = normalizeSkillName(input.name);
  return {
    requestId: normalizeMutationRequestId(input.requestId),
    name,
    nameKey: skillNameKey(name),
    description: normalizeDescription(input.description),
    instructions: normalizeInstructions(input.instructions),
    references: normalizeReferences(input.references || []),
    executionMode: normalizeExecutionMode(input.executionMode),
    requirements: normalizeRequirements(input.requirements || [])
  };
}

function normalizeUpdateInput(input: UpdateBridgeSkillInput): {
  requestId: string;
  skillId: string;
  expectedVersion: string;
  name?: string;
  nameKey?: string;
  description?: string;
  instructions?: string;
  references?: NormalizedReferenceInput[];
  executionMode?: SkillExecutionMode;
  requirements?: NormalizedRequirementInput[];
} {
  assertBridgeSkillId(input.skillId);
  assertBridgeVersion(input.expectedVersion, "expectedVersion");
  const name = input.name === undefined ? undefined : normalizeSkillName(input.name);
  if (input.name === undefined && input.description === undefined && input.instructions === undefined &&
    input.references === undefined && input.executionMode === undefined && input.requirements === undefined) {
    throw new Error("SKILL_UPDATE_EMPTY: Provide at least one bridge skill field to update.");
  }
  return {
    requestId: normalizeMutationRequestId(input.requestId),
    skillId: input.skillId,
    expectedVersion: input.expectedVersion,
    ...(name ? { name, nameKey: skillNameKey(name) } : {}),
    ...(input.description === undefined ? {} : { description: normalizeDescription(input.description) }),
    ...(input.instructions === undefined ? {} : { instructions: normalizeInstructions(input.instructions) }),
    ...(input.references === undefined ? {} : { references: normalizeReferences(input.references) }),
    ...(input.executionMode === undefined ? {} : { executionMode: normalizeExecutionMode(input.executionMode) }),
    ...(input.requirements === undefined ? {} : { requirements: normalizeRequirements(input.requirements) })
  };
}

function normalizeRestoreInput(input: RestoreBridgeSkillInput): RestoreBridgeSkillInput {
  assertBridgeSkillId(input.skillId);
  assertBridgeVersion(input.expectedVersion, "expectedVersion");
  assertBridgeVersion(input.sourceVersion, "sourceVersion");
  return {
    requestId: normalizeMutationRequestId(input.requestId),
    skillId: input.skillId,
    expectedVersion: input.expectedVersion,
    sourceVersion: input.sourceVersion
  };
}

function normalizeSetEnabledInput(input: SetBridgeSkillEnabledInput): SetBridgeSkillEnabledInput {
  assertBridgeSkillId(input.skillId);
  assertBridgeVersion(input.expectedVersion, "expectedVersion");
  if (typeof input.enabled !== "boolean") {
    throw new Error("SKILL_ENABLED_INVALID: enabled must be true or false.");
  }
  return {
    requestId: normalizeMutationRequestId(input.requestId),
    skillId: input.skillId,
    expectedVersion: input.expectedVersion,
    enabled: input.enabled
  };
}

type NormalizedReferenceInput = { name: string; content: string; mediaType: string };
type NormalizedRequirementInput = { kind: SkillRequirementKind; id: string; description: string | null };

function normalizeReferences(input: readonly BridgeSkillReferenceInput[]): NormalizedReferenceInput[] {
  if (!Array.isArray(input) || input.length > SKILL_REFERENCE_MAX_COUNT) {
    throw new Error(`SKILL_REFERENCE_LIMIT: Provide at most ${SKILL_REFERENCE_MAX_COUNT} reference materials.`);
  }
  let bytes = 0;
  const names = new Set<string>();
  return input.map((reference) => {
    const name = normalizeReferenceName(reference.name);
    const key = skillNameKey(name);
    if (names.has(key)) throw new Error("SKILL_REFERENCE_NAME_CONFLICT: Reference material names must be unique within a version.");
    names.add(key);
    let content: string;
    try {
      // Markdown and reference material are immutable source content. Preserve
      // CRLF, trailing newlines, combining characters, and every other valid
      // UTF-8 code point exactly as supplied.
      content = verbatimText(reference.content, {
        field: "Reference material",
        maxUtf8Bytes: SKILL_REFERENCE_MAX_BYTES,
        rejectNul: true
      });
    } catch {
      throw new Error(`SKILL_REFERENCE_INVALID: Each reference material must be 1-${SKILL_REFERENCE_MAX_BYTES} UTF-8 bytes without NUL characters.`);
    }
    bytes += utf8ByteLength(content, "Reference material");
    if (bytes > SKILL_REFERENCE_TOTAL_MAX_BYTES) {
      throw new Error(`SKILL_REFERENCE_TOTAL_TOO_LARGE: Reference materials must total at most ${SKILL_REFERENCE_TOTAL_MAX_BYTES} UTF-8 bytes.`);
    }
    return { name, content, mediaType: normalizeMediaType(reference.mediaType) };
  });
}

function normalizeExecutionMode(value: SkillExecutionMode | undefined): SkillExecutionMode {
  const mode = value || "conversation-or-codex";
  if (!SKILL_EXECUTION_MODES.includes(mode)) {
    throw new Error("SKILL_EXECUTION_MODE_INVALID: executionMode must be conversation, codex, or conversation-or-codex.");
  }
  return mode;
}

function normalizeRequirements(input: readonly BridgeSkillRequirementInput[]): NormalizedRequirementInput[] {
  if (!Array.isArray(input) || input.length > SKILL_REQUIREMENT_MAX_COUNT) {
    throw new Error(`SKILL_REQUIREMENT_LIMIT: Provide at most ${SKILL_REQUIREMENT_MAX_COUNT} skill requirements.`);
  }
  const seen = new Set<string>();
  return input.map((requirement) => {
    if (!requirement || typeof requirement !== "object") {
      throw new Error("SKILL_REQUIREMENT_INVALID: Each requirement must be an object.");
    }
    if (!SKILL_REQUIREMENT_KINDS.includes(requirement.kind)) {
      throw new Error("SKILL_REQUIREMENT_KIND_INVALID: Requirement kind must be bridge-capability or environment.");
    }
    const id = normalizeRequirementId(requirement.id);
    const key = `${requirement.kind}\u0000${searchKey(id, { field: "Requirement id" })}`;
    if (seen.has(key)) throw new Error("SKILL_REQUIREMENT_CONFLICT: Skill requirements must be unique.");
    seen.add(key);
    return {
      kind: requirement.kind,
      id,
      description: requirement.description === undefined ? null : normalizeRequirementDescription(requirement.description)
    };
  });
}

function normalizeRequirementId(value: string): string {
  try {
    return canonicalHumanText(value, {
      field: "Requirement id",
      maxCharacters: SKILL_REQUIREMENT_ID_MAX_LENGTH,
      collapseWhitespace: true,
      trim: true
    });
  } catch {
    throw new Error(`SKILL_REQUIREMENT_INVALID: Requirement id must be 1-${SKILL_REQUIREMENT_ID_MAX_LENGTH} visible characters.`);
  }
}

function normalizeRequirementDescription(value: string): string {
  try {
    return canonicalHumanText(value, {
      field: "Requirement description",
      maxCharacters: SKILL_REQUIREMENT_DESCRIPTION_MAX_LENGTH,
      collapseWhitespace: true,
      trim: true
    });
  } catch {
    throw new Error(`SKILL_REQUIREMENT_INVALID: Requirement description must be 1-${SKILL_REQUIREMENT_DESCRIPTION_MAX_LENGTH} visible characters.`);
  }
}

function normalizeSkillName(value: string): string {
  try {
    return canonicalHumanText(value, {
      field: "Skill name",
      maxCharacters: SKILL_NAME_MAX_LENGTH,
      collapseWhitespace: true,
      trim: true
    });
  } catch {
    throw new Error(`SKILL_NAME_INVALID: Use 1-${SKILL_NAME_MAX_LENGTH} visible characters for a skill name.`);
  }
}

function normalizeReferenceName(value: string): string {
  const normalized = normalizeSkillName(value);
  if (normalized.includes("/") || normalized.includes("\\")) {
    throw new Error("SKILL_REFERENCE_NAME_INVALID: Reference material names cannot contain path separators.");
  }
  return normalized;
}

function normalizeDescription(value: string): string {
  try {
    return canonicalHumanText(value, {
      field: "Skill description",
      maxCharacters: SKILL_DESCRIPTION_MAX_LENGTH,
      collapseWhitespace: true,
      trim: true
    });
  } catch {
    throw new Error(`SKILL_DESCRIPTION_INVALID: Use 1-${SKILL_DESCRIPTION_MAX_LENGTH} visible characters for a description.`);
  }
}

function normalizeInstructions(value: string): string {
  try {
    return verbatimText(value, {
      field: "Instructions",
      maxUtf8Bytes: SKILL_INSTRUCTIONS_MAX_BYTES,
      rejectNul: true
    });
  } catch {
    throw new Error(`SKILL_INSTRUCTIONS_INVALID: Instructions must be 1-${SKILL_INSTRUCTIONS_MAX_BYTES} UTF-8 bytes without NUL characters.`);
  }
}

function normalizeMediaType(value: string | undefined): string {
  const raw = value === undefined ? "text/plain" : value;
  let text: string;
  try {
    text = verbatimText(raw, {
      field: "Reference material mediaType",
      maxCharacters: BRIDGE_SKILL_LIMITS.mediaTypeMaxCharacters,
      rejectControlCharacters: true,
      rejectNul: true
    });
  } catch {
    throw new Error("SKILL_REFERENCE_MEDIA_TYPE_INVALID: Reference material mediaType must be text.");
  }
  const normalized = text.trim().toLowerCase();
  if (normalized.length > BRIDGE_SKILL_LIMITS.mediaTypeMaxCharacters ||
    !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:;[a-z0-9!#$&^_.+\-=]+)?$/.test(normalized)) {
    throw new Error(`SKILL_REFERENCE_MEDIA_TYPE_INVALID: Reference material mediaType must be a valid compact media type of at most ${BRIDGE_SKILL_LIMITS.mediaTypeMaxCharacters} characters.`);
  }
  return normalized;
}

function skillNameKey(name: string): string {
  return searchKey(name, { field: "Skill name" });
}

function bridgeVersionDigest(
  name: string,
  description: string,
  instructions: string,
  references: ReadonlyArray<Pick<SkillReferenceMaterial, "referenceId" | "name" | "mediaType" | "contentDigest">>,
  executionMode: SkillExecutionMode = "conversation-or-codex",
  requirements: readonly NormalizedRequirementInput[] = [],
  digestVersion: 1 | 2 = 2
): string {
  const legacyPayload = {
    name,
    description,
    instructions,
    references: references.map((reference) => ({
      referenceId: reference.referenceId,
      name: reference.name,
      mediaType: reference.mediaType,
      contentDigest: reference.contentDigest
    }))
  };
  // Version 1 indexes were written with JSON.stringify and must keep that
  // exact field order when they are verified after the schema migration.
  if (digestVersion === 1) return sha256(JSON.stringify(legacyPayload));

  const payload = {
    ...legacyPayload,
    executionMode,
    requirements: requirements.map(cloneRequirement)
  } as {
    name: string;
    description: string;
    instructions: string;
    references: Array<Pick<SkillReferenceMaterial, "referenceId" | "name" | "mediaType" | "contentDigest">>;
    executionMode?: SkillExecutionMode;
    requirements?: NormalizedRequirementInput[];
  };
  return sha256(stableJson(payload));
}

function bridgeSkillMarkdown(name: string, description: string, instructions: string): string {
  // JSON strings are valid YAML scalar syntax and avoid emitting unsafe YAML
  // when a user-facing name contains quotes or punctuation.
  return `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n${instructions}`;
}

function stripBridgeFrontmatter(value: string, digestVersion: 1 | 2): string {
  const match = /^---\n[\s\S]*?\n---\n\n?/.exec(value);
  if (!match) throw new Error("SKILL_LIBRARY_CORRUPT: Bridge SKILL.md is missing its managed frontmatter.");
  const instructions = value.slice(match[0].length);
  // Version 1 intentionally stripped the wrapper's trailing newline. Keep
  // that historical verification behavior without rewriting an immutable
  // record. Version 2 stores and returns the exact supplied UTF-8 text.
  return digestVersion === 1 ? instructions.trim() : instructions;
}

function assertBridgeReference(reference: SkillReference): void {
  if (reference.source !== BRIDGE_SKILL_SOURCE) {
    throw new Error("SKILL_SOURCE_UNSUPPORTED: Only bridge-owned skills are available through this library.");
  }
  if (!BRIDGE_SKILL_ID.test(reference.skillId)) {
    throw new Error("SKILL_REFERENCE_INVALID: Expected an exact bridge skill reference.");
  }
  if (!/^[1-9]\d*$/.test(reference.version)) {
    throw new Error("SKILL_VERSION_INVALID: Expected an exact bridge skill version.");
  }
}

function validateIndex(value: unknown): BridgeSkillIndex {
  if (!isRecord(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2) || !Array.isArray(value.skills)) {
    throw new Error("SKILL_LIBRARY_CORRUPT: Bridge skill index has an unsupported shape.");
  }
  const legacy = value.schemaVersion === 1;
  const ids = new Set<string>();
  const names = new Set<string>();
  const skills = value.skills.map((entry) => validateBridgeRecord(entry, ids, names, legacy));
  const mutationReceipts = legacy
    ? []
    : validateMutationReceipts(value.mutationReceipts);
  return { schemaVersion: 2, skills, mutationReceipts };
}

function validateBridgeRecord(
  value: unknown,
  ids: Set<string>,
  names: Set<string>,
  legacy: boolean
): BridgeSkillRecord {
  if (!isRecord(value) || !BRIDGE_SKILL_ID.test(stringValue(value.skillId)) ||
    typeof value.name !== "string" || typeof value.nameKey !== "string" || typeof value.description !== "string" ||
    typeof value.createdAt !== "string" || typeof value.updatedAt !== "string" ||
    typeof value.currentVersion !== "string" || !Array.isArray(value.versions) ||
    (!legacy && typeof value.enabled !== "boolean")) {
    throw new Error("SKILL_LIBRARY_CORRUPT: Bridge skill index has an invalid skill record.");
  }
  const skillId = stringValue(value.skillId);
  if (ids.has(skillId)) throw new Error("SKILL_LIBRARY_CORRUPT: Bridge skill index has duplicate ids.");
  ids.add(skillId);
  const name = normalizeSkillName(value.name);
  const nameKey = skillNameKey(name);
  if (value.nameKey !== nameKey || names.has(nameKey)) {
    throw new Error("SKILL_LIBRARY_CORRUPT: Bridge skill index has duplicate or invalid names.");
  }
  names.add(nameKey);
  const description = normalizeDescription(value.description);
  const versions = value.versions.map((version) => validateBridgeVersion(version, legacy));
  if (!versions.some((version) => version.version === value.currentVersion)) {
    throw new Error("SKILL_LIBRARY_CORRUPT: Bridge skill current version is missing.");
  }
  return {
    skillId,
    name,
    nameKey,
    description,
    createdAt: stringValue(value.createdAt),
    updatedAt: stringValue(value.updatedAt),
    currentVersion: stringValue(value.currentVersion),
    enabled: legacy ? true : value.enabled as boolean,
    versions
  };
}

function validateBridgeVersion(value: unknown, legacy: boolean): BridgeSkillVersionRecord {
  if (!isRecord(value) || !/^[1-9]\d*$/.test(stringValue(value.version)) ||
    typeof value.createdAt !== "string" || typeof value.name !== "string" || typeof value.description !== "string" ||
    !SHA256.test(stringValue(value.contentDigest)) || !Array.isArray(value.references) ||
    (!legacy && value.contentDigestVersion !== 2) ||
    (!legacy && !SKILL_EXECUTION_MODES.includes(value.executionMode as SkillExecutionMode)) ||
    (!legacy && !Array.isArray(value.requirements))) {
    throw new Error("SKILL_LIBRARY_CORRUPT: Bridge skill index has an invalid version record.");
  }
  const referenceIds = new Set<string>();
  const references = value.references.map((reference) => {
    if (!isRecord(reference) || !/^ref_[a-f0-9]{32}$/.test(stringValue(reference.referenceId)) ||
      typeof reference.name !== "string" || typeof reference.mediaType !== "string" ||
      !SHA256.test(stringValue(reference.contentDigest)) || !Number.isSafeInteger(reference.bytes) ||
      (reference.bytes as number) < 1 || typeof reference.file !== "string" ||
      !/^references\/ref_[a-f0-9]{32}\.txt$/.test(reference.file)) {
      throw new Error("SKILL_LIBRARY_CORRUPT: Bridge skill index has an invalid reference record.");
    }
    const referenceId = stringValue(reference.referenceId);
    const contentDigest = stringValue(reference.contentDigest);
    const bytes = reference.bytes as number;
    if (referenceIds.has(referenceId)) throw new Error("SKILL_LIBRARY_CORRUPT: Bridge skill version has duplicate references.");
    referenceIds.add(referenceId);
    return {
      referenceId,
      name: normalizeReferenceName(reference.name),
      mediaType: normalizeMediaType(reference.mediaType),
      contentDigest,
      bytes,
      file: reference.file
    };
  });
  return {
    version: stringValue(value.version),
    createdAt: stringValue(value.createdAt),
    name: normalizeSkillName(value.name),
    description: normalizeDescription(value.description),
    contentDigest: stringValue(value.contentDigest),
    contentDigestVersion: legacy ? 1 : 2,
    references,
    executionMode: legacy ? "conversation-or-codex" : value.executionMode as SkillExecutionMode,
    requirements: legacy ? [] : normalizeStoredRequirements(value.requirements)
  };
}

function validateMutationReceipts(value: unknown): BridgeSkillMutationReceipt[] {
  if (!Array.isArray(value)) {
    throw new Error("SKILL_LIBRARY_CORRUPT: Bridge skill mutation receipts have an invalid shape.");
  }
  const requestIds = new Set<string>();
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.requestId !== "string" || !REQUEST_ID.test(entry.requestId) ||
      !SHA256.test(stringValue(entry.actionHash)) || typeof entry.createdAt !== "string") {
      throw new Error("SKILL_LIBRARY_CORRUPT: Bridge skill mutation receipt is invalid.");
    }
    if (requestIds.has(entry.requestId)) {
      throw new Error("SKILL_LIBRARY_CORRUPT: Bridge skill mutation receipts have duplicate request ids.");
    }
    requestIds.add(entry.requestId);
    return {
      requestId: entry.requestId,
      actionHash: stringValue(entry.actionHash),
      skill: validateStoredSkillSummary(entry.skill),
      createdAt: entry.createdAt
    };
  });
}

function validateStoredSkillSummary(value: unknown): SkillSummary {
  if (!isRecord(value) || !BRIDGE_SKILL_ID.test(stringValue(value.skillId)) || value.source !== BRIDGE_SKILL_SOURCE ||
    !/^[1-9]\d*$/.test(stringValue(value.version)) || typeof value.name !== "string" ||
    typeof value.description !== "string" || !SHA256.test(stringValue(value.contentDigest)) ||
    typeof value.enabled !== "boolean" || !["available", "metadata-only", "disabled"].includes(stringValue(value.availability)) ||
    !isRecord(value.execution) || !SKILL_EXECUTION_MODES.includes(value.execution.mode as SkillExecutionMode) ||
    typeof value.execution.note !== "string") {
    throw new Error("SKILL_LIBRARY_CORRUPT: Bridge skill mutation receipt has an invalid result.");
  }
  return {
    skillId: stringValue(value.skillId),
    source: BRIDGE_SKILL_SOURCE,
    version: stringValue(value.version),
    name: normalizeSkillName(value.name),
    description: normalizeDescription(value.description),
    contentDigest: stringValue(value.contentDigest),
    enabled: value.enabled,
    availability: value.availability as SkillSummary["availability"],
    execution: {
      mode: value.execution.mode as SkillExecutionMode,
      note: value.execution.note,
      requirements: normalizeStoredRequirements(value.execution.requirements)
        .map(resolveRequirement)
    }
  };
}

function normalizeStoredRequirements(value: unknown): NormalizedRequirementInput[] {
  if (!Array.isArray(value)) {
    throw new Error("SKILL_LIBRARY_CORRUPT: Bridge skill requirements have an invalid shape.");
  }
  return normalizeRequirements(value.map((entry) => {
    if (!isRecord(entry) || typeof entry.kind !== "string" || typeof entry.id !== "string" ||
      (entry.description !== null && entry.description !== undefined && typeof entry.description !== "string")) {
      throw new Error("SKILL_LIBRARY_CORRUPT: Bridge skill requirement is invalid.");
    }
    return {
      kind: entry.kind as SkillRequirementKind,
      id: entry.id,
      ...(typeof entry.description === "string" ? { description: entry.description } : {})
    };
  }));
}

function cloneBridgeRecord(record: BridgeSkillRecord): BridgeSkillRecord {
  return {
    ...record,
    versions: record.versions.map((version) => ({
      ...version,
      references: version.references.map((reference) => ({ ...reference })),
      requirements: version.requirements.map(cloneRequirement)
    }))
  };
}

function resolveRequirements(requirements: readonly NormalizedRequirementInput[]): SkillRequirement[] {
  return requirements.map(resolveRequirement);
}

function resolveRequirement(requirement: NormalizedRequirementInput): SkillRequirement {
  return {
    ...cloneRequirement(requirement),
    availability: requirement.kind === "environment"
      ? "external-environment"
      : SUPPORTED_BRIDGE_CAPABILITIES.has(requirement.id) ? "available" : "unsupported"
  };
}

function executionNote(mode: SkillExecutionMode, requirements: readonly SkillRequirement[]): string {
  const route = mode === "conversation"
    ? "Apply this version directly in the conversation."
    : mode === "codex"
      ? "Pass this exact version to a Codex task for execution."
      : "Apply this version directly in the conversation, or pass this exact version to a Codex task when local work is needed.";
  const unsupported = requirements.filter((requirement) => requirement.availability === "unsupported");
  if (unsupported.length > 0) {
    return `${route} Unsupported bridge capabilities are declared: ${unsupported.map((requirement) => requirement.id).join(", ")}.`;
  }
  const external = requirements.filter((requirement) => requirement.availability === "external-environment");
  if (external.length > 0) {
    return `${route} External environment prerequisites must be checked by the selected execution environment.`;
  }
  return route;
}

function skillWarnings(record: BridgeSkillRecord, version: BridgeSkillVersionRecord): string[] {
  const warnings: string[] = [];
  if (!record.enabled) {
    warnings.push("This bridge skill is disabled. Its immutable versions remain readable for audit, but it is excluded from discovery and cannot be newly delivered to Codex.");
  }
  for (const requirement of resolveRequirements(version.requirements)) {
    if (requirement.availability === "unsupported") {
      warnings.push(`Bridge capability '${requirement.id}' is not supported by this library and is not made available by reading this skill.`);
    } else if (requirement.availability === "external-environment") {
      warnings.push(`External environment prerequisite '${requirement.id}' is declared but is not checked or granted by reading this skill.`);
    }
  }
  return warnings;
}

function cloneRequirement(requirement: NormalizedRequirementInput): NormalizedRequirementInput {
  return { kind: requirement.kind, id: requirement.id, description: requirement.description };
}

function cloneExecution(execution: SkillSummary["execution"]): SkillSummary["execution"] {
  return {
    mode: execution.mode,
    note: execution.note,
    requirements: execution.requirements.map((requirement) => ({ ...requirement }))
  };
}

function cloneSkillSummary(skill: SkillSummary): SkillSummary {
  return { ...skill, execution: cloneExecution(skill.execution) };
}

function normalizeMutationRequestId(value: string): string {
  if (typeof value !== "string" || !REQUEST_ID.test(value)) {
    throw new Error("SKILL_MUTATION_REQUEST_ID_INVALID: requestId must be a UUID for one logical bridge skill mutation.");
  }
  return value.toLowerCase();
}

function assertBridgeSkillId(value: string): void {
  if (!BRIDGE_SKILL_ID.test(value)) {
    throw new Error("SKILL_ID_INVALID: A bridge skill id is required.");
  }
}

function assertBridgeVersion(value: string, label: string): void {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`SKILL_VERSION_INVALID: ${label} must be an exact bridge skill version.`);
  }
}

function nextBridgeVersion(currentVersion: string): string {
  const nextVersion = String(Number.parseInt(currentVersion, 10) + 1);
  if (!/^[1-9]\d*$/.test(nextVersion)) {
    throw new Error("SKILL_VERSION_INVALID: The bridge skill version counter is invalid.");
  }
  return nextVersion;
}

function mutationActionHash(operation: string, input: unknown): string {
  return sha256(stableJson({ operation, input }));
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") throw new Error("SKILL_MUTATION_INVALID: Mutation payload has an unsupported value.");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function cloneMutationReceipts(receipts: readonly BridgeSkillMutationReceipt[]): BridgeSkillMutationReceipt[] {
  return receipts.map((receipt) => ({
    requestId: receipt.requestId,
    actionHash: receipt.actionHash,
    skill: cloneSkillSummary(receipt.skill),
    createdAt: receipt.createdAt
  }));
}

function waitForMutationLock(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function safeDescendant(root: string, relative: string): Promise<string | undefined> {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/u).includes("..")) return undefined;
  const candidate = path.resolve(root, relative);
  const relativePath = path.relative(root, candidate);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) return undefined;
  try {
    const resolvedRoot = await realpath(root);
    const resolvedCandidate = await realpath(candidate);
    const resolvedRelative = path.relative(resolvedRoot, resolvedCandidate);
    if (resolvedRelative === "" || resolvedRelative === ".." || resolvedRelative.startsWith(`..${path.sep}`) || path.isAbsolute(resolvedRelative)) return undefined;
    return resolvedCandidate;
  } catch {
    return undefined;
  }
}

async function readMutationLockOwner(lockDirectory: string): Promise<BridgeSkillMutationLockOwner | undefined> {
  try {
    const parsed: unknown = JSON.parse(decodeUtf8Strict(
      await readFile(path.join(lockDirectory, BRIDGE_SKILL_MUTATION_LOCK_OWNER)),
      "Bridge skill mutation lock"
    ));
    assertJsonTextIntegrity(parsed, "Bridge skill mutation lock");
    if (!isRecord(parsed) || typeof parsed.token !== "string" || !REQUEST_ID.test(parsed.token) ||
      !Number.isSafeInteger(parsed.pid) || (parsed.pid as number) <= 0 ||
      typeof parsed.host !== "string" || !parsed.host) {
      return undefined;
    }
    return {
      token: parsed.token,
      pid: parsed.pid as number,
      host: parsed.host
    };
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Permission denial still proves that a process owns this PID. Only ESRCH
    // permits stale-lock recovery.
    return !isErrno(error, "ESRCH");
  }
}

function canRecoverOwnedMutationLock(owner: BridgeSkillMutationLockOwner): boolean {
  // A shared directory from a different host is deliberately left alone:
  // blocking a retry is safer than treating an unverifiable live owner as stale.
  return owner.host === hostname() && !processIsAlive(owner.pid);
}

function sameMutationLockOwner(
  left: BridgeSkillMutationLockOwner | undefined,
  right: BridgeSkillMutationLockOwner | undefined
): boolean {
  if (!left || !right) return left === right;
  return left.token === right.token && left.pid === right.pid && left.host === right.host;
}

async function readBoundedText(file: string, maxBytes: number, label: string): Promise<string> {
  const information = await stat(file);
  if (!information.isFile() || information.size < 1 || information.size > maxBytes) {
    throw new Error(`${label} is unavailable or exceeds its ${maxBytes}-byte limit.`);
  }
  let value: string;
  try {
    value = verbatimText(decodeUtf8Strict(await readFile(file), label), {
      field: label,
      maxUtf8Bytes: maxBytes,
      rejectNul: true
    });
  } catch {
    throw new Error(`${label} is unavailable or is not supported UTF-8 text.`);
  }
  return value;
}

function uniqueReferences(references: readonly SkillReference[]): SkillReference[] {
  const output: SkillReference[] = [];
  const seen = new Set<string>();
  for (const reference of references) {
    assertBridgeReference(reference);
    const key = `${reference.source}\u0000${reference.skillId}\u0000${reference.version}`;
    if (!seen.has(key)) { seen.add(key); output.push({ ...reference }); }
  }
  return output;
}

function normalizeSearchQuery(value: string | undefined): string {
  if (value === undefined) return "";
  try {
    return searchKey(value, {
      field: "Search text",
      allowEmpty: true,
      maxUtf8Bytes: BRIDGE_SKILL_LIMITS.searchQueryMaxBytes,
      rejectControlCharacters: true
    });
  } catch {
    throw new Error(`SKILL_SEARCH_INVALID: Search text must be at most ${BRIDGE_SKILL_LIMITS.searchQueryMaxBytes.toLocaleString("en-US")} UTF-8 bytes.`);
  }
}

function normalizeSearchLimit(value: number | undefined): number {
  if (value === undefined) return 30;
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("SKILL_SEARCH_LIMIT_INVALID: limit must be an integer from 1 through 100.");
  }
  return value;
}

function matchesSearch(skill: SkillSummary, query: string): boolean {
  if (!query) return true;
  const haystack = searchKey(`${skill.name}\n${skill.description}`, {
    field: "Stored bridge skill search text",
    allowEmpty: true,
    rejectControlCharacters: false
  });
  return query.split(/\s+/u).every((term) => haystack.includes(term));
}

function compareSkillSummaries(left: SkillSummary, right: SkillSummary): number {
  return left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) ||
    left.source.localeCompare(right.source) || left.skillId.localeCompare(right.skillId);
}

function sha256(value: string): string {
  const exact = verbatimText(value, { field: "Hashed text", allowEmpty: true, rejectNul: false });
  return createHash("sha256").update(exact, "utf8").digest("hex");
}

function isoNow(now: () => number): string {
  return new Date(now()).toISOString();
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
