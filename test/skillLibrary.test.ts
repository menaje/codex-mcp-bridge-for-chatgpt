import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BRIDGE_SKILL_LIMITS, SkillLibrary } from "../src/skillLibrary.js";

describe("SkillLibrary", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("stores one source-preserved Markdown document and keeps prior versions immutable", async () => {
    const library = await createLibrary();
    const source = "# 검토\r\n\r\n- e\u0301는 원문 그대로입니다.\r\n\r\n```sh\r\nprintf 'keep CRLF'\r\n```\r\n";
    const first = await library.createBridgeSkill({
      requestId: randomUUID(),
      name: "문서 검토",
      description: "검토 절차를 찾기 위한 설명",
      document: source
    });

    expect(first).toMatchObject({ source: "bridge", version: "1", availability: "available" });
    const firstDocument = await library.read({ reference: first });
    expect(firstDocument).toMatchObject({ document: source, format: "markdown", legacy: false });
    expect(firstDocument.document).toContain("\r\n");
    expect(firstDocument.document).toContain("e\u0301");

    const second = await library.updateBridgeSkill({
      requestId: randomUUID(),
      skillId: first.skillId,
      expectedVersion: first.version,
      name: "근거 문서 검토",
      description: "수정된 검색 설명",
      document: "# 새 절차\n\n현재 버전에서만 보이는 문장입니다.\n"
    });
    expect(second.version).toBe("2");
    expect(second.contentDigest).not.toBe(first.contentDigest);

    expect((await library.read({ reference: first })).document).toBe(source);
    expect((await library.read({ reference: second })).document).toContain("현재 버전에서만");
    expect((await library.listBridgeSkillVersions({ skillId: first.skillId })).versions)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ version: "2", format: "markdown", legacy: false }),
        expect.objectContaining({ version: "1", format: "markdown", legacy: false })
      ]));
  });

  it("searches authored document text without requiring a structured material bucket", async () => {
    const library = await createLibrary();
    await library.createBridgeSkill({
      requestId: randomUUID(),
      name: "배포 확인",
      document: "# 배포\n\n문서 본문에만 있는 `rollback-token`을 확인합니다."
    });

    const result = await library.search({ query: "rollback-token" });
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]?.description).toBe("");
  });

  it("adapts a v2 structured record losslessly into a legacy Markdown document", async () => {
    const root = await temporaryRoot();
    const directory = path.join(root, "bridge-skills");
    const skillId = `bridge_${"a".repeat(32)}`;
    const referenceId = `ref_${"b".repeat(32)}`;
    const instructions = "Keep every original instruction.";
    const referenceContent = "| Original | Reference |\n| --- | --- |\n";
    const requirements = [{ kind: "environment", id: "project-files", description: "Choose the report folder." }];
    const reference = {
      referenceId,
      name: "Original evidence",
      mediaType: "text/markdown",
      contentDigest: sha256(referenceContent),
      bytes: Buffer.byteLength(referenceContent, "utf8"),
      file: `references/${referenceId}.txt`
    };
    const name = "Historical review";
    const description = "Read an existing structured record.";
    const contentDigest = sha256(stableJson({
      name,
      description,
      instructions,
      references: [{
        referenceId,
        name: reference.name,
        mediaType: reference.mediaType,
        contentDigest: reference.contentDigest
      }],
      executionMode: "conversation-or-codex",
      requirements
    }));
    const rootVersion = path.join(directory, skillId, "versions", "1");
    await mkdir(path.join(rootVersion, "references"), { recursive: true });
    await writeFile(path.join(rootVersion, "SKILL.md"), `---\nmanaged: legacy\n---\n\n${instructions}\n`, "utf8");
    await writeFile(path.join(rootVersion, reference.file), referenceContent, "utf8");
    await writeFile(path.join(directory, "index.json"), JSON.stringify({
      schemaVersion: 2,
      skills: [{
        skillId,
        name,
        nameKey: name.toLocaleLowerCase("en-US"),
        description,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        currentVersion: "1",
        enabled: true,
        versions: [{
          version: "1",
          createdAt: "2026-01-01T00:00:00.000Z",
          name,
          description,
          contentDigest,
          contentDigestVersion: 2,
          references: [reference],
          executionMode: "conversation-or-codex",
          requirements
        }]
      }],
      mutationReceipts: []
    }, null, 2), "utf8");

    const library = new SkillLibrary({ directory });
    const document = await library.read({ reference: { skillId, source: "bridge", version: "1" } });
    expect(document.legacy).toBe(true);
    expect(document.document).toContain(instructions);
    expect(document.document).toContain(referenceContent.trim());
    expect(document.document).toContain("Previous usage route: conversation-or-codex");
    expect(document.document).toContain("environment:project-files — Choose the report folder.");

    const restored = await library.restoreBridgeSkill({
      requestId: randomUUID(), skillId, expectedVersion: "1", sourceVersion: "1"
    });
    const restoredDocument = await library.read({ reference: restored });
    expect(restored.version).toBe("2");
    expect(restoredDocument.legacy).toBe(false);
    expect(restoredDocument.document).toBe(document.document);
  });

  it("keeps v1 structured records readable before their first free-form edit", async () => {
    const root = await temporaryRoot();
    const directory = path.join(root, "bridge-skills");
    const skillId = `bridge_${"c".repeat(32)}`;
    const name = "First generation review";
    const description = "Read a v1 structured skill.";
    const instructions = "Keep this historical v1 instruction.";
    const contentDigest = sha256(JSON.stringify({
      name,
      description,
      instructions,
      references: []
    }));
    const rootVersion = path.join(directory, skillId, "versions", "1");
    await mkdir(rootVersion, { recursive: true });
    await writeFile(path.join(rootVersion, "SKILL.md"), `---\nmanaged: legacy\n---\n\n${instructions}\n`, "utf8");
    await writeFile(path.join(directory, "index.json"), JSON.stringify({
      schemaVersion: 1,
      skills: [{
        skillId,
        name,
        nameKey: name.toLocaleLowerCase("en-US"),
        description,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        currentVersion: "1",
        versions: [{
          version: "1",
          createdAt: "2026-01-01T00:00:00.000Z",
          name,
          description,
          contentDigest,
          references: []
        }]
      }]
    }, null, 2), "utf8");

    const library = new SkillLibrary({ directory });
    const document = await library.read({ reference: { skillId, source: "bridge", version: "1" } });
    expect(document).toMatchObject({ legacy: true, document: expect.stringContaining(instructions) });
    expect(document.skill.enabled).toBe(true);
    expect(document.document).toContain("Previous usage route: conversation-or-codex");

    const edited = await library.updateBridgeSkill({
      requestId: randomUUID(),
      skillId,
      expectedVersion: "1",
      document: "# Current free-form document\n"
    });
    expect(edited.version).toBe("2");
    expect((await library.read({ reference: edited })).legacy).toBe(false);
    expect((await library.read({ reference: { skillId, source: "bridge", version: "1" } })).legacy).toBe(true);
  });

  it("archives separately from permanent deletion and makes an exact delete retry safe", async () => {
    const root = await temporaryRoot();
    const directory = path.join(root, "bridge-skills");
    const library = new SkillLibrary({ directory });
    const createRequest = {
      requestId: randomUUID(), name: "Release review", document: "# Review\n\nVerify the release."
    };
    const first = await library.createBridgeSkill(createRequest);
    const archived = await library.setBridgeSkillEnabled({
      requestId: randomUUID(), skillId: first.skillId, expectedVersion: "1", enabled: false
    });
    expect(archived.availability).toBe("disabled");
    expect((await library.read({ reference: first })).document).toContain("Verify the release");
    expect((await library.search({})).skills).toHaveLength(0);
    expect((await library.search({ includeDisabled: true })).skills).toHaveLength(1);

    const deleteRequest = {
      requestId: randomUUID(), skillId: first.skillId, expectedVersion: "1", confirmName: "Release review"
    };
    const deleted = await library.deleteBridgeSkill(deleteRequest);
    expect(deleted).toEqual({
      skillId: first.skillId,
      source: "bridge",
      deletedAt: expect.any(String)
    });
    await expect(stat(path.join(directory, first.skillId))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await library.deleteBridgeSkill(deleteRequest)).toEqual(deleted);
    await expect(library.createBridgeSkill(createRequest)).rejects.toThrow("SKILL_MUTATION_INVALIDATED");
    expect((await library.search({ includeDisabled: true })).skills).toEqual([]);
    await expect(library.read({ reference: first })).rejects.toThrow("SKILL_NOT_FOUND");
    const index = await readFile(path.join(directory, "index.json"), "utf8");
    expect(index).not.toContain("Release review");
    expect(index).not.toContain("Verify the release");
    expect(JSON.parse(index)).toMatchObject({
      schemaVersion: 5,
      mutationReceipts: expect.arrayContaining([expect.objectContaining({
        requestId: createRequest.requestId,
        outcome: expect.objectContaining({
          kind: "invalidated",
          invalidation: expect.objectContaining({ skillId: first.skillId })
        })
      }), expect.objectContaining({
        outcome: expect.objectContaining({
          kind: "deleted",
          deletion: expect.objectContaining({ skillId: first.skillId, source: "bridge" })
        })
      })])
    });
  });

  it("scrubs historical deleted-skill receipt metadata on the next index write", async () => {
    const root = await temporaryRoot();
    const directory = path.join(root, "bridge-skills");
    const deletedSkillId = `bridge_${"d".repeat(32)}`;
    const staleName = "Deleted historical review";
    const staleDescription = "This deleted description must not remain in index.json.";
    await mkdir(directory, { recursive: true });
    const staleRequestId = randomUUID();
    await writeFile(path.join(directory, "index.json"), JSON.stringify({
      schemaVersion: 3,
      skills: [],
      mutationReceipts: [{
        requestId: staleRequestId,
        actionHash: sha256("historical-delete"),
        skill: {
          skillId: deletedSkillId,
          source: "bridge",
          version: "1",
          name: staleName,
          description: staleDescription,
          contentDigest: sha256("historical-document"),
          enabled: false,
          availability: "disabled"
        },
        createdAt: "2026-01-01T00:00:00.000Z"
      }]
    }, null, 2), "utf8");

    const library = new SkillLibrary({ directory });
    await library.createBridgeSkill({
      requestId: randomUUID(), name: "Current document", document: "# Current\n"
    });

    const index = await readFile(path.join(directory, "index.json"), "utf8");
    expect(index).not.toContain(staleName);
    expect(index).not.toContain(staleDescription);
    const parsed = JSON.parse(index);
    expect(parsed.schemaVersion).toBe(5);
    expect(parsed.mutationReceipts).toHaveLength(2);
    expect(parsed.mutationReceipts).toEqual(expect.arrayContaining([expect.objectContaining({
      requestId: staleRequestId,
      outcome: {
        kind: "invalidated",
        invalidation: { skillId: deletedSkillId, invalidatedAt: "2026-01-01T00:00:00.000Z" }
      }
    })]));
  });

  it("requires the current name for deletion and rejects NUL source text", async () => {
    const library = await createLibrary();
    const created = await library.createBridgeSkill({
      requestId: randomUUID(), name: "Delete check", document: "# Keep me"
    });
    await expect(library.deleteBridgeSkill({
      requestId: randomUUID(), skillId: created.skillId, expectedVersion: "1", confirmName: "wrong"
    })).rejects.toThrow("SKILL_DELETE_CONFIRMATION_INVALID");
    await expect(library.createBridgeSkill({
      requestId: randomUUID(), name: "Invalid", document: "before\u0000after"
    })).rejects.toThrow("SKILL_DOCUMENT_INVALID");
  });

  it("keeps the documented 3 MiB Markdown source capacity without a lower prompt cap", async () => {
    const library = await createLibrary();
    // U+0001 is accepted source text but serializes as six ASCII bytes in
    // JSON, exercising the documented worst-case transport envelope.
    const document = "\u0001".repeat(BRIDGE_SKILL_LIMITS.documentMaxBytes);
    const requestId = randomUUID();
    const serializedRequest = JSON.stringify({ requestId, name: "Large document", document });
    expect(Buffer.byteLength(serializedRequest, "utf8")).toBeGreaterThan(8 * 1_024 * 1_024);
    expect(Buffer.byteLength(serializedRequest, "utf8")).toBeLessThanOrEqual(BRIDGE_SKILL_LIMITS.mutationWireMaxBytes);
    const created = await library.createBridgeSkill({
      requestId, name: "Large document", document
    });
    expect((await library.read({ reference: created })).document).toHaveLength(document.length);
    await expect(library.updateBridgeSkill({
      requestId: randomUUID(), skillId: created.skillId, expectedVersion: "1", document: `${document}x`
    })).rejects.toThrow("SKILL_DOCUMENT_INVALID");
  });

  it("rejects sources outside Bridge ownership", async () => {
    const library = await createLibrary();
    await expect(library.read({
      reference: { skillId: "external", source: "codex", version: "1" } as never
    })).rejects.toThrow("SKILL_SOURCE_UNSUPPORTED");
  });

  async function createLibrary(): Promise<SkillLibrary> {
    const root = await temporaryRoot();
    return new SkillLibrary({ directory: path.join(root, "bridge-skills") });
  }

  async function temporaryRoot(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "codex-bridge-skill-test-"));
    roots.push(root);
    return root;
  }
});

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
