import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";

/** The Bridge owns this private, versioned document library. */
export const BRIDGE_SKILL_SOURCE = "bridge" as const;
export const SKILL_SOURCES = [BRIDGE_SKILL_SOURCE] as const;
export type SkillSource = (typeof SKILL_SOURCES)[number];

/**
 * A v3 document has one body instead of the former instructions plus material
 * buckets. Keep its input capacity above the old 512 KiB + 2 MiB aggregate.
 */
export const BRIDGE_SKILL_LIMITS = Object.freeze({
  nameMaxCharacters: 120,
  descriptionMaxCharacters: 2_000,
  documentMaxBytes: 3 * 1_024 * 1_024,
  searchQueryMaxBytes: 1_000,
  /** A 3 MiB source can expand sixfold when JSON escapes every C0 byte. */
  mutationWireMaxBytes: 20 * 1_024 * 1_024,
  legacyInstructionsMaxBytes: 512 * 1_024,
  legacyReferenceMaxBytes: 512 * 1_024,
  legacyReferenceTotalMaxBytes: 2 * 1_024 * 1_024,
  legacyReferenceMaxCount: 64,
  legacyMediaTypeMaxCharacters: 200,
  legacyRequirementMaxCount: 32,
  legacyRequirementIdMaxCharacters: 120,
  legacyRequirementDescriptionMaxCharacters: 500
});

export type SkillReference = {
  skillId: string;
  source: SkillSource;
  /** A bridge document version is immutable. */
  version: string;
};

export type SkillSummary = SkillReference & {
  name: string;
  /** Optional discovery metadata; an empty string means no explicit summary. */
  description: string;
  contentDigest: string | null;
  enabled: boolean;
  availability: "available" | "disabled";
};

export type SkillDocument = {
  skill: SkillSummary;
  /** Exact, source-preserved Markdown supplied by the document author. */
  document: string;
  format: "markdown";
  /** True only while reading a v1/v2 structured record through its lossless adapter. */
  legacy: boolean;
  sourceSnapshot: "versioned-bridge-record";
  warnings: string[];
};

export type SkillSearchResult = { skills: SkillSummary[] };

export type SkillVersionSummary = SkillReference & {
  name: string;
  description: string;
  contentDigest: string;
  createdAt: string;
  format: "markdown";
  legacy: boolean;
};

export type SkillVersionList = {
  skillId: string;
  source: SkillSource;
  currentVersion: string;
  enabled: boolean;
  versions: SkillVersionSummary[];
};

export type CreateBridgeSkillInput = {
  /** Reuse exactly for a transport retry of this logical mutation. */
  requestId: string;
  name: string;
  /** Discovery metadata only. Omit it when the document does not need a summary. */
  description?: string;
  document: string;
};

export type UpdateBridgeSkillInput = {
  /** Reuse exactly for a transport retry of this logical mutation. */
  requestId: string;
  skillId: string;
  expectedVersion: string;
  name?: string;
  /** Send an empty string to clear the optional discovery summary. */
  description?: string;
  document?: string;
};

export type RestoreBridgeSkillInput = {
  requestId: string;
  skillId: string;
  expectedVersion: string;
  sourceVersion: string;
};

export type SetBridgeSkillEnabledInput = {
  requestId: string;
  skillId: string;
  expectedVersion: string;
  enabled: boolean;
};

/** Native-only permanent deletion requires the visible current name as confirmation. */
export type DeleteBridgeSkillInput = {
  requestId: string;
  skillId: string;
  expectedVersion: string;
  confirmName: string;
};

/**
 * Minimal native deletion receipt. It deliberately omits the deleted name,
 * description, content digest, and document so a durable retry record does
 * not turn permanent deletion into metadata retention.
 */
export type DeletedBridgeSkill = {
  skillId: string;
  source: SkillSource;
  deletedAt: string;
};

type LegacyRequirementInput = {
  kind: "bridge-capability" | "environment";
  id: string;
  description: string | null;
};

type LegacyReferenceMaterial = {
  referenceId: string;
  name: string;
  mediaType: string;
  contentDigest: string;
  bytes: number;
  file: string;
};

/** Kept only to read existing v1/v2 immutable records without rewriting them. */
type LegacyBridgeSkillVersionRecord = {
  kind: "legacy";
  version: string;
  createdAt: string;
  name: string;
  description: string;
  contentDigest: string;
  contentDigestVersion: 1 | 2;
  references: LegacyReferenceMaterial[];
  executionMode: "conversation" | "codex" | "conversation-or-codex";
  requirements: LegacyRequirementInput[];
};

type MarkdownBridgeSkillVersionRecord = {
  kind: "document";
  version: string;
  createdAt: string;
  name: string;
  description: string;
  contentDigest: string;
  contentDigestVersion: 3;
  format: "markdown";
  documentFile: "document.md";
};

type BridgeSkillVersionRecord = LegacyBridgeSkillVersionRecord | MarkdownBridgeSkillVersionRecord;

type BridgeSkillRecord = {
  skillId: string;
  name: string;
  nameKey: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  currentVersion: string;
  /** Lifecycle intentionally remains outside immutable content versions. */
  enabled: boolean;
  versions: BridgeSkillVersionRecord[];
};

type BridgeSkillMutationOutcome =
  | { kind: "skill"; skill: SkillSummary }
  | { kind: "deleted"; deletion: DeletedBridgeSkill }
  /** A permanent delete invalidates older create/update retries without retaining their content metadata. */
  | { kind: "invalidated"; invalidation: { skillId: string; invalidatedAt: string } };

type BridgeSkillMutationValue = SkillSummary | DeletedBridgeSkill;

type BridgeSkillMutationReceipt = {
  requestId: string;
  actionHash: string;
  /**
   * Deletes keep a non-content tombstone. Older receipts are reduced to a
   * minimal invalidation tombstone, so an exact retry cannot recreate a
   * permanently deleted skill or retain its name, description, or document.
   */
  outcome: BridgeSkillMutationOutcome;
  createdAt: string;
};

type BridgeSkillMutationLockOwner = { token: string; pid: number; host: string };

type BridgeSkillIndex = {
  schemaVersion: 5;
  skills: BridgeSkillRecord[];
  mutationReceipts: BridgeSkillMutationReceipt[];
};

type LoadedBridgeVersion = {
  record: BridgeSkillRecord;
  version: BridgeSkillVersionRecord;
  document: string;
  legacy: boolean;
};

type SkillLibraryOptions = { directory: string; now?: () => number };

const BRIDGE_SKILL_ID = /^bridge_[a-f0-9]{32}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const BRIDGE_SKILL_INDEX = "index.json";
const BRIDGE_SKILL_MUTATION_LOCK = ".mutation.lock";
const BRIDGE_SKILL_MUTATION_LOCK_OWNER = "owner.json";
const BRIDGE_SKILL_MUTATION_LOCK_RECOVERY = ".recovery";
const MUTATION_LOCK_STALE_MS = 120_000;
const MUTATION_LOCK_RETRY_LIMIT = 80;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** One process can receive several HTTP MCP requests concurrently. */
const mutationQueues = new Map<string, Promise<void>>();

/** Shared source of truth for model lookup and bridge-owned authoring. */
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
    const records = await this.store.list();
    const matches: SkillSummary[] = [];

    for (const record of records) {
      const summary = bridgeSummary(record);
      if (!input.includeDisabled && !summary.enabled) continue;
      if (query && !matchesSearchMetadata(summary, query)) {
        const loaded = await this.store.readVersion(summary);
        if (!matchesText(loaded.document, query)) continue;
      }
      matches.push(summary);
    }

    return { skills: matches.sort(compareSkillSummaries).slice(0, limit) };
  }

  async read(input: { reference: SkillReference }): Promise<SkillDocument> {
    return bridgeDocument(await this.store.readVersion(input.reference));
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

  deleteBridgeSkill(input: DeleteBridgeSkillInput): Promise<DeletedBridgeSkill> {
    return this.store.delete(input);
  }

  async listBridgeSkillVersions(input: { skillId: string }): Promise<SkillVersionList> {
    return this.store.listVersions(input.skillId);
  }
}

class BridgeSkillStore {
  constructor(private readonly directory: string, private readonly now: () => number) {}

  async list(): Promise<BridgeSkillRecord[]> {
    return (await this.readIndex()).skills.map(cloneBridgeRecord);
  }

  async listVersions(skillId: string): Promise<SkillVersionList> {
    assertBridgeSkillId(skillId);
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
    return this.mutate(normalized.requestId, mutationActionHash("create", normalized), async (index) => {
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
      record.versions.push(await this.writeDocumentVersion(record, "1", normalized.document, now));
      index.skills.push(record);
      return bridgeSummary(record);
    });
  }

  async update(input: UpdateBridgeSkillInput): Promise<SkillSummary> {
    const normalized = normalizeUpdateInput(input);
    return this.mutate(normalized.requestId, mutationActionHash("update", normalized), async (index) => {
      const record = findCurrentRecord(index, normalized.skillId, normalized.expectedVersion);
      const current = await this.loadVersion(record, record.currentVersion);
      const name = normalized.name ?? record.name;
      const nameKey = normalized.nameKey ?? record.nameKey;
      if (index.skills.some((candidate) => candidate.skillId !== record.skillId && candidate.nameKey === nameKey)) {
        throw new Error("SKILL_NAME_CONFLICT: A bridge skill with this name already exists.");
      }
      const description = normalized.description ?? record.description;
      const document = normalized.document ?? current.document;
      const nextVersion = nextBridgeVersion(record.currentVersion);
      const now = isoNow(this.now);
      const version = await this.writeDocumentVersion({ ...record, name, description }, nextVersion, document, now);
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
    return this.mutate(normalized.requestId, mutationActionHash("restore", normalized), async (index) => {
      const record = findCurrentRecord(index, normalized.skillId, normalized.expectedVersion);
      const source = await this.loadVersion(record, normalized.sourceVersion);
      const name = source.version.name;
      const nameKey = skillNameKey(name);
      if (index.skills.some((candidate) => candidate.skillId !== record.skillId && candidate.nameKey === nameKey)) {
        throw new Error("SKILL_NAME_CONFLICT: A bridge skill with this name already exists.");
      }
      const nextVersion = nextBridgeVersion(record.currentVersion);
      const now = isoNow(this.now);
      const version = await this.writeDocumentVersion(
        { ...record, name, description: source.version.description }, nextVersion, source.document, now
      );
      record.name = name;
      record.nameKey = nameKey;
      record.description = source.version.description;
      record.currentVersion = nextVersion;
      record.updatedAt = now;
      record.versions.push(version);
      return bridgeSummary(record);
    });
  }

  async setEnabled(input: SetBridgeSkillEnabledInput): Promise<SkillSummary> {
    const normalized = normalizeSetEnabledInput(input);
    return this.mutate(normalized.requestId, mutationActionHash("set-enabled", normalized), async (index) => {
      const record = findCurrentRecord(index, normalized.skillId, normalized.expectedVersion);
      record.enabled = normalized.enabled;
      record.updatedAt = isoNow(this.now);
      return bridgeSummary(record);
    });
  }

  /**
   * Move the exact private directory aside while the index mutation commits.
   * A crash before the index write restores it on the next mutation; a crash
   * after the index write reclaims the staged directory as deleted content.
   */
  async delete(input: DeleteBridgeSkillInput): Promise<DeletedBridgeSkill> {
    const normalized = normalizeDeleteInput(input);
    let staged: { source: string; target: string } | undefined;
    let committed = false;
    try {
      const deleted = await this.mutate<DeletedBridgeSkill>(normalized.requestId, mutationActionHash("delete", normalized), async (index) => {
        const record = findCurrentRecord(index, normalized.skillId, normalized.expectedVersion);
        if (skillNameKey(normalized.confirmName) !== record.nameKey) {
          throw new Error("SKILL_DELETE_CONFIRMATION_INVALID: Type the current bridge skill name to permanently delete it.");
        }
        const source = this.skillDirectory(record.skillId);
        const target = path.join(this.directory, `.${record.skillId}.deleting-${randomUUID()}`);
        try {
          await rename(source, target);
        } catch (error) {
          if (isErrno(error, "ENOENT")) {
            throw new Error("SKILL_LIBRARY_CORRUPT: Bridge skill files are unavailable for permanent deletion.");
          }
          throw error;
        }
        staged = { source, target };
        index.skills.splice(index.skills.indexOf(record), 1);
        // Retain only a minimal invalidation tombstone for earlier mutations.
        // Dropping them would let a delayed exact create retry recreate this
        // permanently deleted skill; retaining their summaries would leave
        // deleted names or descriptions in index.json.
        const invalidatedAt = isoNow(this.now);
        index.mutationReceipts = index.mutationReceipts.map((receipt) => (
          mutationOutcomeSkillId(receipt.outcome) === record.skillId
            ? {
              ...receipt,
              outcome: {
                kind: "invalidated",
                invalidation: { skillId: record.skillId, invalidatedAt }
              }
            }
            : receipt
        ));
        return {
          skillId: record.skillId,
          source: BRIDGE_SKILL_SOURCE,
          deletedAt: isoNow(this.now)
        };
      });
      committed = true;
      if (staged) {
        try {
          await rm(staged.target, { recursive: true, force: true });
        } catch {
          // The index commit already made deletion durable. Do not claim
          // success while the staged directory might still retain a document;
          // recovery and an exact requestId retry will attempt cleanup again.
          throw new Error(
            "SKILL_DELETE_CLEANUP_PENDING: Bridge skill deletion committed but secure cleanup is pending. Retry the same requestId."
          );
        }
      }
      return deleted;
    } catch (error) {
      if (!committed && staged) await rename(staged.target, staged.source).catch(() => undefined);
      throw error;
    }
  }

  async readVersion(reference: SkillReference): Promise<LoadedBridgeVersion> {
    assertBridgeReference(reference);
    const index = await this.readIndex();
    const record = index.skills.find((candidate) => candidate.skillId === reference.skillId);
    if (!record) throw new Error("SKILL_NOT_FOUND: This bridge skill does not exist.");
    return this.loadVersion(record, reference.version);
  }

  private async loadVersion(record: BridgeSkillRecord, versionValue: string): Promise<LoadedBridgeVersion> {
    const version = record.versions.find((candidate) => candidate.version === versionValue);
    if (!version) throw new Error("SKILL_VERSION_NOT_FOUND: This bridge skill version does not exist.");
    const root = this.versionDirectory(record.skillId, version.version);
    if (isMarkdownVersion(version)) {
      const document = await readBoundedText(
        path.join(root, version.documentFile), BRIDGE_SKILL_LIMITS.documentMaxBytes, "Bridge skill document"
      );
      if (markdownDocumentDigest(version.name, version.description, document) !== version.contentDigest) {
        throw new Error("SKILL_LIBRARY_CORRUPT: A bridge skill document no longer matches its recorded content digest.");
      }
      return { record: cloneBridgeRecord(record), version: { ...version }, document, legacy: false };
    }

    const instructions = await readBoundedText(
      path.join(root, "SKILL.md"), BRIDGE_SKILL_LIMITS.legacyInstructionsMaxBytes + 16 * 1_024, "Legacy bridge skill"
    ).then(stripLegacyFrontmatter);
    const references = await Promise.all(version.references.map(async (reference) => {
      const filePath = await safeDescendant(root, reference.file);
      if (!filePath) throw new Error("SKILL_LIBRARY_CORRUPT: A legacy reference file escapes its version directory.");
      const content = await readBoundedText(filePath, BRIDGE_SKILL_LIMITS.legacyReferenceMaxBytes, "Legacy bridge skill reference");
      if (sha256(content) !== reference.contentDigest) {
        throw new Error("SKILL_LIBRARY_CORRUPT: A legacy reference no longer matches its recorded content digest.");
      }
      return { ...reference, content };
    }));
    const digest = legacyVersionDigest(
      version.name, version.description, instructions, references, version.executionMode, version.requirements,
      version.contentDigestVersion
    );
    if (digest !== version.contentDigest) {
      throw new Error("SKILL_LIBRARY_CORRUPT: A legacy bridge skill version no longer matches its recorded content digest.");
    }
    return {
      record: cloneBridgeRecord(record),
      version: cloneLegacyVersion(version),
      document: legacyDocument(instructions, references, version),
      legacy: true
    };
  }

  private async writeDocumentVersion(
    record: Pick<BridgeSkillRecord, "skillId" | "name" | "description">,
    versionValue: string,
    document: string,
    createdAt: string
  ): Promise<MarkdownBridgeSkillVersionRecord> {
    const directory = this.versionDirectory(record.skillId, versionValue);
    const staging = `${directory}.staging-${randomUUID()}`;
    const version: MarkdownBridgeSkillVersionRecord = {
      kind: "document",
      version: versionValue,
      createdAt,
      name: record.name,
      description: record.description,
      contentDigest: markdownDocumentDigest(record.name, record.description, document),
      contentDigestVersion: 3,
      format: "markdown",
      documentFile: "document.md"
    };
    try {
      await mkdir(staging, { recursive: true, mode: 0o700 });
      await writeFile(path.join(staging, version.documentFile), document, { encoding: "utf8", mode: 0o600 });
      await writeFile(path.join(staging, "manifest.json"), JSON.stringify({
        version: version.version,
        name: version.name,
        description: version.description,
        contentDigest: version.contentDigest,
        contentDigestVersion: version.contentDigestVersion,
        format: version.format,
        documentFile: version.documentFile
      }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
      await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
      await rename(staging, directory);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    return version;
  }

  private async readIndex(): Promise<BridgeSkillIndex> {
    let raw: string;
    try {
      raw = await readFile(path.join(this.directory, BRIDGE_SKILL_INDEX), "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return { schemaVersion: 5, skills: [], mutationReceipts: [] };
      throw error;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new Error("SKILL_LIBRARY_CORRUPT: Bridge skill index is not valid JSON."); }
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

  private skillDirectory(skillId: string): string {
    return path.join(this.directory, skillId);
  }

  private versionDirectory(skillId: string, version: string): string {
    return path.join(this.skillDirectory(skillId), "versions", version);
  }

  private async mutate<T extends BridgeSkillMutationValue>(
    requestId: string,
    actionHash: string,
    operation: (index: BridgeSkillIndex) => Promise<T>
  ): Promise<T> {
    const existing = mutationQueues.get(this.directory) || Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const queued = existing.then(() => turn, () => turn);
    mutationQueues.set(this.directory, queued);
    await existing.catch(() => undefined);
    try {
      return await this.withMutationLock(async () => {
        const index = await this.readIndex();
        await this.recoverDeletedSkillStaging(index);
        await this.recoverOrphanedVersions(index);
        const receipt = index.mutationReceipts.find((candidate) => candidate.requestId === requestId);
        if (receipt) {
          if (receipt.actionHash !== actionHash) {
            throw new Error("SKILL_MUTATION_REQUEST_REUSED: requestId was already used for a different bridge skill mutation.");
          }
          if (receipt.outcome.kind === "invalidated") {
            throw new Error(
              "SKILL_MUTATION_INVALIDATED: This exact bridge skill mutation was invalidated by permanent deletion. Do not retry it."
            );
          }
          return cloneMutationValue(receipt.outcome) as T;
        }
        const result = await operation(index);
        index.mutationReceipts = cloneMutationReceipts([
          ...index.mutationReceipts,
          { requestId, actionHash, outcome: mutationOutcome(result), createdAt: isoNow(this.now) }
        ]);
        await this.writeIndex(index);
        return result;
      });
    } finally {
      release();
      if (mutationQueues.get(this.directory) === queued) mutationQueues.delete(this.directory);
    }
  }

  private async recoverDeletedSkillStaging(index: BridgeSkillIndex): Promise<void> {
    const entries = await readdir(this.directory, { withFileTypes: true }).catch((error) => {
      if (isErrno(error, "ENOENT")) return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const match = /^\.(bridge_[a-f0-9]{32})\.deleting-[a-f0-9-]+$/i.exec(entry.name);
      if (!match) continue;
      const skillId = match[1]!.toLowerCase();
      const staged = path.join(this.directory, entry.name);
      const active = index.skills.some((skill) => skill.skillId === skillId);
      if (!active) {
        await rm(staged, { recursive: true, force: true });
        continue;
      }
      const target = this.skillDirectory(skillId);
      const targetExists = await stat(target).then(() => true).catch((error) => {
        if (isErrno(error, "ENOENT")) return false;
        throw error;
      });
      if (targetExists) await rm(staged, { recursive: true, force: true });
      else await rename(staged, target);
    }
  }

  private async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lockDirectory = path.join(this.directory, BRIDGE_SKILL_MUTATION_LOCK);
    for (let attempt = 0; attempt < MUTATION_LOCK_RETRY_LIMIT; attempt += 1) {
      const owner = await this.tryAcquireMutationLock(lockDirectory);
      if (!owner) {
        const age = await stat(lockDirectory).then((information) => Date.now() - information.mtimeMs).catch(() => 0);
        if (age > MUTATION_LOCK_STALE_MS && await this.reclaimMutationLock(lockDirectory)) continue;
        await waitForMutationLock(Math.min(25 + attempt * 10, 250));
        continue;
      }
      try { return await operation(); }
      finally { await this.releaseMutationLock(lockDirectory, owner.token); }
    }
    throw new Error("SKILL_LIBRARY_BUSY: Another bridge process is updating the skill library. Retry the same requestId shortly.");
  }

  private async tryAcquireMutationLock(lockDirectory: string): Promise<BridgeSkillMutationLockOwner | undefined> {
    const owner: BridgeSkillMutationLockOwner = { token: randomUUID(), pid: process.pid, host: hostname() };
    const staging = `${lockDirectory}.staging-${owner.token}`;
    let acquired = false;
    try {
      await mkdir(staging, { mode: 0o700 });
      await writeFile(path.join(staging, BRIDGE_SKILL_MUTATION_LOCK_OWNER), JSON.stringify(owner), {
        encoding: "utf8", mode: 0o600, flag: "wx"
      });
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
    await rm(lockDirectory, { recursive: true, force: true });
    return true;
  }

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
    try { await rename(recoveryDirectory, retiredDirectory); }
    catch (error) {
      if (isErrno(error, "ENOENT") || isErrno(error, "EEXIST") || isErrno(error, "ENOTEMPTY")) return false;
      throw error;
    }
    await rm(retiredDirectory, { recursive: true, force: true }).catch(() => undefined);
    return true;
  }

  private async tryAcquireMutationLockRecovery(recoveryDirectory: string): Promise<BridgeSkillMutationLockOwner | undefined> {
    const owner: BridgeSkillMutationLockOwner = { token: randomUUID(), pid: process.pid, host: hostname() };
    const staging = `${recoveryDirectory}.staging-${owner.token}`;
    let acquired = false;
    try {
      await mkdir(staging, { mode: 0o700 });
      await writeFile(path.join(staging, BRIDGE_SKILL_MUTATION_LOCK_OWNER), JSON.stringify(owner), {
        encoding: "utf8", mode: 0o600, flag: "wx"
      });
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
    const known = new Set(index.skills.flatMap((skill) => skill.versions.map((version) => `${skill.skillId}\u0000${version.version}`)));
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

function findCurrentRecord(index: BridgeSkillIndex, skillId: string, expectedVersion: string): BridgeSkillRecord {
  const record = index.skills.find((candidate) => candidate.skillId === skillId);
  if (!record) throw new Error("SKILL_NOT_FOUND: This bridge skill does not exist.");
  if (record.currentVersion !== expectedVersion) {
    throw new Error("SKILL_VERSION_CHANGED: Read the current bridge skill and retry with its exact current version.");
  }
  return record;
}

function bridgeSummary(record: BridgeSkillRecord, selectedVersion = record.currentVersion): SkillSummary {
  const current = record.versions.find((version) => version.version === selectedVersion);
  if (!current) throw new Error("SKILL_LIBRARY_CORRUPT: Bridge skill current version is missing.");
  return {
    skillId: record.skillId,
    source: BRIDGE_SKILL_SOURCE,
    version: current.version,
    name: current.name,
    description: current.description,
    contentDigest: current.contentDigest,
    enabled: record.enabled,
    availability: record.enabled ? "available" : "disabled"
  };
}

function bridgeVersionSummary(record: BridgeSkillRecord, version: BridgeSkillVersionRecord): SkillVersionSummary {
  return {
    ...bridgeSummary(record, version.version),
    contentDigest: version.contentDigest,
    createdAt: version.createdAt,
    format: "markdown",
    legacy: !isMarkdownVersion(version)
  };
}

function bridgeDocument(loaded: LoadedBridgeVersion): SkillDocument {
  const warnings: string[] = [];
  if (!loaded.record.enabled) {
    warnings.push("This bridge skill is archived. Its immutable versions remain readable, but it is excluded from discovery.");
  }
  if (loaded.legacy) {
    warnings.push("This is a legacy structured version. Editing or restoring it creates a new free-form Markdown version.");
  }
  return {
    skill: bridgeSummary(loaded.record, loaded.version.version),
    document: loaded.document,
    format: "markdown",
    legacy: loaded.legacy,
    sourceSnapshot: "versioned-bridge-record",
    warnings
  };
}

function normalizeCreateInput(input: CreateBridgeSkillInput): {
  requestId: string; name: string; nameKey: string; description: string; document: string;
} {
  const name = normalizeSkillName(input.name);
  return {
    requestId: normalizeMutationRequestId(input.requestId),
    name,
    nameKey: skillNameKey(name),
    description: input.description === undefined ? "" : normalizeDescription(input.description, true),
    document: normalizeDocument(input.document)
  };
}

function normalizeUpdateInput(input: UpdateBridgeSkillInput): {
  requestId: string; skillId: string; expectedVersion: string; name?: string; nameKey?: string; description?: string; document?: string;
} {
  assertBridgeSkillId(input.skillId);
  assertBridgeVersion(input.expectedVersion, "expectedVersion");
  if (input.name === undefined && input.description === undefined && input.document === undefined) {
    throw new Error("SKILL_UPDATE_EMPTY: Provide at least one bridge skill field to update.");
  }
  const name = input.name === undefined ? undefined : normalizeSkillName(input.name);
  return {
    requestId: normalizeMutationRequestId(input.requestId),
    skillId: input.skillId,
    expectedVersion: input.expectedVersion,
    ...(name === undefined ? {} : { name, nameKey: skillNameKey(name) }),
    ...(input.description === undefined ? {} : { description: normalizeDescription(input.description, true) }),
    ...(input.document === undefined ? {} : { document: normalizeDocument(input.document) })
  };
}

function normalizeRestoreInput(input: RestoreBridgeSkillInput): RestoreBridgeSkillInput {
  assertBridgeSkillId(input.skillId);
  assertBridgeVersion(input.expectedVersion, "expectedVersion");
  assertBridgeVersion(input.sourceVersion, "sourceVersion");
  return {
    requestId: normalizeMutationRequestId(input.requestId), skillId: input.skillId,
    expectedVersion: input.expectedVersion, sourceVersion: input.sourceVersion
  };
}

function normalizeSetEnabledInput(input: SetBridgeSkillEnabledInput): SetBridgeSkillEnabledInput {
  assertBridgeSkillId(input.skillId);
  assertBridgeVersion(input.expectedVersion, "expectedVersion");
  if (typeof input.enabled !== "boolean") throw new Error("SKILL_ENABLED_INVALID: enabled must be true or false.");
  return {
    requestId: normalizeMutationRequestId(input.requestId), skillId: input.skillId,
    expectedVersion: input.expectedVersion, enabled: input.enabled
  };
}

function normalizeDeleteInput(input: DeleteBridgeSkillInput): DeleteBridgeSkillInput {
  assertBridgeSkillId(input.skillId);
  assertBridgeVersion(input.expectedVersion, "expectedVersion");
  return {
    requestId: normalizeMutationRequestId(input.requestId),
    skillId: input.skillId,
    expectedVersion: input.expectedVersion,
    confirmName: normalizeSkillName(input.confirmName)
  };
}

function normalizeSkillName(value: string): string {
  if (typeof value !== "string") throw new Error("SKILL_NAME_INVALID: Skill name must be text.");
  const normalized = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (!normalized || Array.from(normalized).length > BRIDGE_SKILL_LIMITS.nameMaxCharacters || CONTROL_CHARACTERS.test(normalized)) {
    throw new Error(`SKILL_NAME_INVALID: Use 1-${BRIDGE_SKILL_LIMITS.nameMaxCharacters} visible characters for a skill name.`);
  }
  return normalized;
}

function normalizeDescription(value: string, allowEmpty: boolean): string {
  if (typeof value !== "string") throw new Error("SKILL_DESCRIPTION_INVALID: Skill description must be text.");
  const normalized = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  if ((!allowEmpty && !normalized) || Array.from(normalized).length > BRIDGE_SKILL_LIMITS.descriptionMaxCharacters || CONTROL_CHARACTERS.test(normalized)) {
    throw new Error(`SKILL_DESCRIPTION_INVALID: Use at most ${BRIDGE_SKILL_LIMITS.descriptionMaxCharacters} visible characters for a description.`);
  }
  return normalized;
}

function normalizeDocument(value: string): string {
  if (typeof value !== "string") throw new Error("SKILL_DOCUMENT_INVALID: A bridge skill document must be text.");
  const bytes = Buffer.byteLength(value, "utf8");
  if (!value.trim() || bytes > BRIDGE_SKILL_LIMITS.documentMaxBytes || value.includes("\u0000")) {
    throw new Error(`SKILL_DOCUMENT_INVALID: A document must be 1-${BRIDGE_SKILL_LIMITS.documentMaxBytes} UTF-8 bytes without NUL characters.`);
  }
  // Do not normalize Markdown: code, paths, line endings, and combining text are source content.
  return value;
}

function normalizeLegacyRequirements(value: unknown): LegacyRequirementInput[] {
  if (!Array.isArray(value) || value.length > BRIDGE_SKILL_LIMITS.legacyRequirementMaxCount) {
    throw new Error("SKILL_LIBRARY_CORRUPT: Legacy bridge skill requirements have an invalid shape.");
  }
  return value.map((entry) => {
    if (!isRecord(entry) || !["bridge-capability", "environment"].includes(stringValue(entry.kind)) ||
      typeof entry.id !== "string" || (entry.description !== null && entry.description !== undefined && typeof entry.description !== "string")) {
      throw new Error("SKILL_LIBRARY_CORRUPT: A legacy bridge skill requirement is invalid.");
    }
    const id = normalizeLegacyHumanText(entry.id, BRIDGE_SKILL_LIMITS.legacyRequirementIdMaxCharacters, "requirement id");
    const description = typeof entry.description === "string"
      ? normalizeLegacyHumanText(entry.description, BRIDGE_SKILL_LIMITS.legacyRequirementDescriptionMaxCharacters, "requirement description")
      : null;
    return { kind: entry.kind as LegacyRequirementInput["kind"], id, description };
  });
}

function normalizeLegacyHumanText(value: string, max: number, label: string): string {
  const normalized = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (!normalized || Array.from(normalized).length > max || CONTROL_CHARACTERS.test(normalized)) {
    throw new Error(`SKILL_LIBRARY_CORRUPT: Legacy ${label} is invalid.`);
  }
  return normalized;
}

function skillNameKey(name: string): string {
  return name.normalize("NFKC").toLocaleLowerCase("en-US");
}

function markdownDocumentDigest(name: string, description: string, document: string): string {
  return sha256(stableJson({ name, description, document, format: "markdown" }));
}

function legacyVersionDigest(
  name: string,
  description: string,
  instructions: string,
  references: ReadonlyArray<Pick<LegacyReferenceMaterial, "referenceId" | "name" | "mediaType" | "contentDigest">>,
  executionMode: LegacyBridgeSkillVersionRecord["executionMode"],
  requirements: readonly LegacyRequirementInput[],
  digestVersion: 1 | 2
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
  if (digestVersion === 1) return sha256(JSON.stringify(legacyPayload));
  return sha256(stableJson({ ...legacyPayload, executionMode, requirements }));
}

function stripLegacyFrontmatter(value: string): string {
  const match = /^---\n[\s\S]*?\n---\n\n?/.exec(value);
  if (!match) throw new Error("SKILL_LIBRARY_CORRUPT: Legacy Bridge SKILL.md is missing its managed frontmatter.");
  // v1/v2 persisted the normalized instructions in this form. Preserve that historical read behavior.
  return value.slice(match[0].length).trim();
}

function legacyDocument(
  instructions: string,
  references: Array<LegacyReferenceMaterial & { content: string }>,
  version: LegacyBridgeSkillVersionRecord
): string {
  const sections = [instructions];
  for (const reference of references) {
    sections.push(`## Imported reference: ${reference.name}\n\n${reference.content}`);
  }
  const metadata = [
    `- Previous usage route: ${version.executionMode}`,
    ...version.requirements.map((requirement) => {
      const description = requirement.description ? ` — ${requirement.description}` : "";
      return `- Previous requirement: ${requirement.kind}:${requirement.id}${description}`;
    })
  ];
  if (metadata.length > 0) sections.push(`## Imported legacy metadata\n\n${metadata.join("\n")}`);
  return sections.join("\n\n---\n\n");
}

function assertBridgeReference(reference: SkillReference): void {
  if (reference.source !== BRIDGE_SKILL_SOURCE) {
    throw new Error("SKILL_SOURCE_UNSUPPORTED: Only bridge-owned skills are available through this library.");
  }
  assertBridgeSkillId(reference.skillId);
  assertBridgeVersion(reference.version, "version");
}

function assertBridgeSkillId(value: string): void {
  if (!BRIDGE_SKILL_ID.test(value)) throw new Error("SKILL_ID_INVALID: A bridge skill id is required.");
}

function assertBridgeVersion(value: string, label: string): void {
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`SKILL_VERSION_INVALID: ${label} must be an exact bridge skill version.`);
}

function validateIndex(value: unknown): BridgeSkillIndex {
  if (!isRecord(value) || ![1, 2, 3, 4, 5].includes(value.schemaVersion as number) || !Array.isArray(value.skills)) {
    throw new Error("SKILL_LIBRARY_CORRUPT: Bridge skill index has an unsupported shape.");
  }
  const indexVersion = value.schemaVersion as 1 | 2 | 3 | 4 | 5;
  const ids = new Set<string>();
  const names = new Set<string>();
  const skills = value.skills.map((entry) => validateBridgeRecord(entry, ids, names, indexVersion));
  const mutationReceipts = indexVersion === 1 ? [] : validateMutationReceipts(
    value.mutationReceipts,
    new Set(skills.map((skill) => skill.skillId))
  );
  return { schemaVersion: 5, skills, mutationReceipts };
}

function validateBridgeRecord(
  value: unknown, ids: Set<string>, names: Set<string>, indexVersion: 1 | 2 | 3 | 4 | 5
): BridgeSkillRecord {
  if (!isRecord(value) || !BRIDGE_SKILL_ID.test(stringValue(value.skillId)) || typeof value.name !== "string" ||
    typeof value.nameKey !== "string" || typeof value.description !== "string" || typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" || typeof value.currentVersion !== "string" || !Array.isArray(value.versions) ||
    (indexVersion !== 1 && typeof value.enabled !== "boolean")) {
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
  const description = normalizeDescription(value.description, indexVersion >= 3);
  const versions = value.versions.map((version) => validateBridgeVersion(version, indexVersion));
  if (!versions.some((version) => version.version === value.currentVersion)) {
    throw new Error("SKILL_LIBRARY_CORRUPT: Bridge skill current version is missing.");
  }
  return {
    skillId, name, nameKey, description, createdAt: value.createdAt, updatedAt: value.updatedAt,
    currentVersion: value.currentVersion, enabled: indexVersion === 1 ? true : value.enabled as boolean, versions
  };
}

function validateBridgeVersion(value: unknown, indexVersion: 1 | 2 | 3 | 4 | 5): BridgeSkillVersionRecord {
  if (isRecord(value) && value.kind === "document") return validateMarkdownVersion(value);
  return validateLegacyVersion(value, indexVersion);
}

function validateMarkdownVersion(value: Record<string, unknown>): MarkdownBridgeSkillVersionRecord {
  if (!/^[1-9]\d*$/.test(stringValue(value.version)) || typeof value.createdAt !== "string" || typeof value.name !== "string" ||
    typeof value.description !== "string" || !SHA256.test(stringValue(value.contentDigest)) || value.contentDigestVersion !== 3 ||
    value.format !== "markdown" || value.documentFile !== "document.md") {
    throw new Error("SKILL_LIBRARY_CORRUPT: Bridge skill document version is invalid.");
  }
  return {
    kind: "document", version: stringValue(value.version), createdAt: value.createdAt,
    name: normalizeSkillName(value.name), description: normalizeDescription(value.description, true),
    contentDigest: stringValue(value.contentDigest), contentDigestVersion: 3, format: "markdown", documentFile: "document.md"
  };
}

function validateLegacyVersion(value: unknown, indexVersion: 1 | 2 | 3 | 4 | 5): LegacyBridgeSkillVersionRecord {
  if (!isRecord(value) || !/^[1-9]\d*$/.test(stringValue(value.version)) || typeof value.createdAt !== "string" ||
    typeof value.name !== "string" || typeof value.description !== "string" || !SHA256.test(stringValue(value.contentDigest)) ||
    !Array.isArray(value.references) || (indexVersion !== 1 && value.contentDigestVersion !== 2 && value.contentDigestVersion !== 1) ||
    (indexVersion !== 1 && !["conversation", "codex", "conversation-or-codex"].includes(stringValue(value.executionMode))) ||
    (indexVersion !== 1 && !Array.isArray(value.requirements))) {
    throw new Error("SKILL_LIBRARY_CORRUPT: Legacy bridge skill version is invalid.");
  }
  const referenceIds = new Set<string>();
  const references = value.references.map((reference) => {
    if (!isRecord(reference) || !/^ref_[a-f0-9]{32}$/.test(stringValue(reference.referenceId)) || typeof reference.name !== "string" ||
      typeof reference.mediaType !== "string" || !SHA256.test(stringValue(reference.contentDigest)) ||
      !Number.isSafeInteger(reference.bytes) || (reference.bytes as number) < 1 || typeof reference.file !== "string" ||
      !/^references\/ref_[a-f0-9]{32}\.txt$/.test(reference.file)) {
      throw new Error("SKILL_LIBRARY_CORRUPT: Legacy bridge skill reference is invalid.");
    }
    const referenceId = stringValue(reference.referenceId);
    if (referenceIds.has(referenceId)) throw new Error("SKILL_LIBRARY_CORRUPT: Legacy bridge skill has duplicate references.");
    referenceIds.add(referenceId);
    return {
      referenceId,
      name: normalizeSkillName(reference.name),
      mediaType: normalizeLegacyMediaType(reference.mediaType),
      contentDigest: stringValue(reference.contentDigest),
      bytes: reference.bytes as number,
      file: reference.file
    };
  });
  const contentDigestVersion = indexVersion === 1 ? 1 : (value.contentDigestVersion as 1 | 2);
  return {
    kind: "legacy", version: stringValue(value.version), createdAt: value.createdAt,
    name: normalizeSkillName(value.name), description: normalizeDescription(value.description, false),
    contentDigest: stringValue(value.contentDigest), contentDigestVersion, references,
    executionMode: indexVersion === 1 ? "conversation-or-codex" : value.executionMode as LegacyBridgeSkillVersionRecord["executionMode"],
    requirements: indexVersion === 1 ? [] : normalizeLegacyRequirements(value.requirements)
  };
}

function normalizeLegacyMediaType(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.length > BRIDGE_SKILL_LIMITS.legacyMediaTypeMaxCharacters ||
    !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:;[a-z0-9!#$&^_.+\-=]+)?$/.test(normalized)) {
    throw new Error("SKILL_LIBRARY_CORRUPT: Legacy bridge skill reference media type is invalid.");
  }
  return normalized;
}

function validateMutationReceipts(value: unknown, activeSkillIds: ReadonlySet<string>): BridgeSkillMutationReceipt[] {
  if (!Array.isArray(value)) throw new Error("SKILL_LIBRARY_CORRUPT: Bridge skill mutation receipts have an invalid shape.");
  const requestIds = new Set<string>();
  const receipts: BridgeSkillMutationReceipt[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.requestId !== "string" || !REQUEST_ID.test(entry.requestId) ||
      !SHA256.test(stringValue(entry.actionHash)) || typeof entry.createdAt !== "string") {
      throw new Error("SKILL_LIBRARY_CORRUPT: Bridge skill mutation receipt is invalid.");
    }
    if (requestIds.has(entry.requestId)) throw new Error("SKILL_LIBRARY_CORRUPT: Bridge skill mutation receipts have duplicate request ids.");
    requestIds.add(entry.requestId);
    const outcome = entry.outcome === undefined
      ? legacyMutationReceiptOutcome(entry.skill, activeSkillIds, entry.createdAt)
      : validateMutationOutcome(entry.outcome, activeSkillIds, entry.createdAt);
    receipts.push({
      requestId: entry.requestId, actionHash: stringValue(entry.actionHash),
      outcome, createdAt: entry.createdAt
    });
  }
  return receipts;
}

function legacyMutationReceiptOutcome(
  value: unknown,
  activeSkillIds: ReadonlySet<string>,
  invalidatedAt: string
): BridgeSkillMutationOutcome {
  const skill = validateStoredSkillSummary(value);
  return activeSkillIds.has(skill.skillId)
    ? { kind: "skill", skill }
    : invalidatedMutationOutcome(skill.skillId, invalidatedAt);
}

function validateMutationOutcome(
  value: unknown,
  activeSkillIds: ReadonlySet<string>,
  invalidatedAt: string
): BridgeSkillMutationOutcome {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new Error("SKILL_LIBRARY_CORRUPT: Bridge skill mutation receipt has an invalid outcome.");
  }
  if (value.kind === "skill") {
    const skill = validateStoredSkillSummary(value.skill);
    return activeSkillIds.has(skill.skillId)
      ? { kind: "skill", skill }
      : invalidatedMutationOutcome(skill.skillId, invalidatedAt);
  }
  if (value.kind === "deleted") {
    const deletion = value.deletion;
    if (!isRecord(deletion) || !BRIDGE_SKILL_ID.test(stringValue(deletion.skillId)) ||
      deletion.source !== BRIDGE_SKILL_SOURCE || typeof deletion.deletedAt !== "string") {
      throw new Error("SKILL_LIBRARY_CORRUPT: Bridge skill deletion receipt is invalid.");
    }
    return {
      kind: "deleted",
      deletion: {
        skillId: stringValue(deletion.skillId),
        source: BRIDGE_SKILL_SOURCE,
        deletedAt: deletion.deletedAt
      }
    };
  }
  if (value.kind === "invalidated") {
    const invalidation = value.invalidation;
    if (!isRecord(invalidation) || !BRIDGE_SKILL_ID.test(stringValue(invalidation.skillId)) ||
      typeof invalidation.invalidatedAt !== "string") {
      throw new Error("SKILL_LIBRARY_CORRUPT: Bridge skill mutation invalidation receipt is invalid.");
    }
    return invalidatedMutationOutcome(stringValue(invalidation.skillId), invalidation.invalidatedAt);
  }
  throw new Error("SKILL_LIBRARY_CORRUPT: Bridge skill mutation receipt has an unknown outcome.");
}

function validateStoredSkillSummary(value: unknown): SkillSummary {
  if (!isRecord(value) || !BRIDGE_SKILL_ID.test(stringValue(value.skillId)) || value.source !== BRIDGE_SKILL_SOURCE ||
    !/^[1-9]\d*$/.test(stringValue(value.version)) || typeof value.name !== "string" || typeof value.description !== "string" ||
    !SHA256.test(stringValue(value.contentDigest)) || typeof value.enabled !== "boolean" ||
    !["available", "disabled", "metadata-only"].includes(stringValue(value.availability))) {
    throw new Error("SKILL_LIBRARY_CORRUPT: Bridge skill mutation receipt has an invalid result.");
  }
  return {
    skillId: stringValue(value.skillId), source: BRIDGE_SKILL_SOURCE, version: stringValue(value.version),
    name: normalizeSkillName(value.name), description: normalizeDescription(value.description, true),
    contentDigest: stringValue(value.contentDigest), enabled: value.enabled,
    availability: value.enabled ? "available" : "disabled"
  };
}

function isMarkdownVersion(version: BridgeSkillVersionRecord): version is MarkdownBridgeSkillVersionRecord {
  return version.kind === "document";
}

function cloneBridgeRecord(record: BridgeSkillRecord): BridgeSkillRecord {
  return {
    ...record,
    versions: record.versions.map((version) => isMarkdownVersion(version) ? { ...version } : cloneLegacyVersion(version))
  };
}

function cloneLegacyVersion(version: LegacyBridgeSkillVersionRecord): LegacyBridgeSkillVersionRecord {
  return {
    ...version,
    references: version.references.map((reference) => ({ ...reference })),
    requirements: version.requirements.map((requirement) => ({ ...requirement }))
  };
}

function cloneSkillSummary(skill: SkillSummary): SkillSummary { return { ...skill }; }

function cloneMutationReceipts(receipts: readonly BridgeSkillMutationReceipt[]): BridgeSkillMutationReceipt[] {
  return receipts.map((receipt) => ({ ...receipt, outcome: cloneMutationOutcome(receipt.outcome) }));
}

function mutationOutcome(value: BridgeSkillMutationValue): BridgeSkillMutationOutcome {
  return isDeletedBridgeSkill(value)
    ? { kind: "deleted", deletion: { ...value } }
    : { kind: "skill", skill: cloneSkillSummary(value) };
}

function invalidatedMutationOutcome(skillId: string, invalidatedAt: string): BridgeSkillMutationOutcome {
  return { kind: "invalidated", invalidation: { skillId, invalidatedAt } };
}

function cloneMutationOutcome(outcome: BridgeSkillMutationOutcome): BridgeSkillMutationOutcome {
  if (outcome.kind === "deleted") return { kind: "deleted", deletion: { ...outcome.deletion } };
  if (outcome.kind === "invalidated") return invalidatedMutationOutcome(
    outcome.invalidation.skillId, outcome.invalidation.invalidatedAt
  );
  return { kind: "skill", skill: cloneSkillSummary(outcome.skill) };
}

function cloneMutationValue(outcome: BridgeSkillMutationOutcome): BridgeSkillMutationValue {
  if (outcome.kind === "deleted") return { ...outcome.deletion };
  if (outcome.kind === "invalidated") {
    throw new Error(
      "SKILL_MUTATION_INVALIDATED: This exact bridge skill mutation was invalidated by permanent deletion. Do not retry it."
    );
  }
  return cloneSkillSummary(outcome.skill);
}

function isDeletedBridgeSkill(value: BridgeSkillMutationValue): value is DeletedBridgeSkill {
  return "deletedAt" in value;
}

function mutationOutcomeSkillId(outcome: BridgeSkillMutationOutcome): string {
  if (outcome.kind === "deleted") return outcome.deletion.skillId;
  if (outcome.kind === "invalidated") return outcome.invalidation.skillId;
  return outcome.skill.skillId;
}

function normalizeMutationRequestId(value: string): string {
  if (typeof value !== "string" || !REQUEST_ID.test(value)) {
    throw new Error("SKILL_MUTATION_REQUEST_ID_INVALID: requestId must be a UUID for one logical bridge skill mutation.");
  }
  return value.toLowerCase();
}

function nextBridgeVersion(currentVersion: string): string {
  const nextVersion = String(Number.parseInt(currentVersion, 10) + 1);
  if (!/^[1-9]\d*$/.test(nextVersion)) throw new Error("SKILL_VERSION_INVALID: The bridge skill version counter is invalid.");
  return nextVersion;
}

function mutationActionHash(operation: string, input: unknown): string {
  return sha256(stableJson({ operation, input }));
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") throw new Error("SKILL_MUTATION_INVALID: Mutation payload has an unsupported value.");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function matchesSearchMetadata(skill: SkillSummary, query: string): boolean {
  return matchesText(`${skill.name}\n${skill.description}`, query);
}

function matchesText(value: string, query: string): boolean {
  const haystack = value.normalize("NFKC").toLocaleLowerCase("en-US");
  return query.split(/\s+/u).every((term) => haystack.includes(term));
}

function normalizeSearchQuery(value: string | undefined): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > BRIDGE_SKILL_LIMITS.searchQueryMaxBytes) {
    throw new Error(`SKILL_SEARCH_INVALID: Search text must be at most ${BRIDGE_SKILL_LIMITS.searchQueryMaxBytes.toLocaleString("en-US")} UTF-8 bytes.`);
  }
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function normalizeSearchLimit(value: number | undefined): number {
  if (value === undefined) return 30;
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error("SKILL_SEARCH_LIMIT_INVALID: limit must be an integer from 1 through 100.");
  return value;
}

function compareSkillSummaries(left: SkillSummary, right: SkillSummary): number {
  return left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) || left.skillId.localeCompare(right.skillId);
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
  } catch { return undefined; }
}

async function readMutationLockOwner(lockDirectory: string): Promise<BridgeSkillMutationLockOwner | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(lockDirectory, BRIDGE_SKILL_MUTATION_LOCK_OWNER), "utf8"));
    if (!isRecord(parsed) || typeof parsed.token !== "string" || !REQUEST_ID.test(parsed.token) ||
      !Number.isSafeInteger(parsed.pid) || (parsed.pid as number) <= 0 || typeof parsed.host !== "string" || !parsed.host) return undefined;
    return { token: parsed.token, pid: parsed.pid as number, host: parsed.host };
  } catch { return undefined; }
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !isErrno(error, "ESRCH"); }
}

function canRecoverOwnedMutationLock(owner: BridgeSkillMutationLockOwner): boolean {
  return owner.host === hostname() && !processIsAlive(owner.pid);
}

function sameMutationLockOwner(left: BridgeSkillMutationLockOwner | undefined, right: BridgeSkillMutationLockOwner | undefined): boolean {
  if (!left || !right) return left === right;
  return left.token === right.token && left.pid === right.pid && left.host === right.host;
}

async function readBoundedText(file: string, maxBytes: number, label: string): Promise<string> {
  const information = await stat(file);
  if (!information.isFile() || information.size < 1 || information.size > maxBytes) {
    throw new Error(`${label} is unavailable or exceeds its ${maxBytes}-byte limit.`);
  }
  const value = await readFile(file, "utf8");
  if (Buffer.byteLength(value, "utf8") > maxBytes || value.includes("\u0000")) {
    throw new Error(`${label} is unavailable or is not supported UTF-8 text.`);
  }
  return value;
}

function waitForMutationLock(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function isoNow(now: () => number): string { return new Date(now()).toISOString(); }
function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }
function isErrno(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
