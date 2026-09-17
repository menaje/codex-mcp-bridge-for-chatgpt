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

  it("stores source-preserved Markdown skill content and keeps prior versions immutable", async () => {
    const library = await createLibrary();
    const source = "# 검토\r\n\r\n- e\u0301는 원문 그대로입니다.\r\n\r\n```sh\r\nprintf 'keep CRLF'\r\n```\r\n";
    const first = await library.createBridgeSkill({
      requestId: randomUUID(),
      name: "문서 검토",
      description: "검토 절차를 찾기 위한 설명",
      content: source
    });

    expect(first).toMatchObject({ source: "bridge", version: "1", availability: "available" });
    const firstSkill = await library.read({ reference: first });
    expect(firstSkill).toMatchObject({ content: source, format: "markdown", legacy: false });
    expect(firstSkill.content).toContain("\r\n");
    expect(firstSkill.content).toContain("e\u0301");

    const second = await library.updateBridgeSkill({
      requestId: randomUUID(),
      skillId: first.skillId,
      expectedVersion: first.version,
      name: "근거 문서 검토",
      description: "수정된 검색 설명",
      content: "# 새 절차\n\n현재 버전에서만 보이는 문장입니다.\n"
    });
    expect(second.version).toBe("2");
    expect(second.contentDigest).not.toBe(first.contentDigest);

    expect((await library.read({ reference: first })).content).toBe(source);
    expect((await library.read({ reference: second })).content).toContain("현재 버전에서만");
    expect((await library.listBridgeSkillVersions({ skillId: first.skillId })).versions)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ version: "2", format: "markdown", legacy: false }),
        expect.objectContaining({ version: "1", format: "markdown", legacy: false })
      ]));
  });

  it("stores new skill content as SKILL.md and still reads legacy document.md versions", async () => {
    const root = await temporaryRoot();
    const directory = path.join(root, "bridge-skills");
    const library = new SkillLibrary({ directory });
    const source = "# Standard main document\n";
    const created = await library.createBridgeSkill({
      requestId: randomUUID(), name: "Standard filename", content: source
    });
    const versionDirectory = path.join(directory, created.skillId, "versions", created.version);
    const indexPath = path.join(directory, "index.json");
    const index = JSON.parse(await readFile(indexPath, "utf8"));

    expect(index.schemaVersion).toBe(6);
    expect(index.skills[0].versions[0]).toMatchObject({ kind: "skill", contentFile: "SKILL.md", contentDigestVersion: 5 });
    expect(await readFile(path.join(versionDirectory, "SKILL.md"), "utf8")).toBe(source);
    await expect(stat(path.join(versionDirectory, "document.md"))).rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(path.join(versionDirectory, "document.md"), source, "utf8");
    await rm(path.join(versionDirectory, "SKILL.md"));
    const version = index.skills[0].versions[0];
    index.schemaVersion = 5;
    version.kind = "document";
    version.contentDigestVersion = 4;
    version.documentFile = "document.md";
    version.contentDigest = legacyMarkdownDigest(version.name, version.description, source, version.files);
    delete version.contentFile;
    await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");

    expect((await new SkillLibrary({ directory }).read({ reference: created })).content).toBe(source);
  });

  it("searches authored skill content without requiring a structured material bucket", async () => {
    const library = await createLibrary();
    await library.createBridgeSkill({
      requestId: randomUUID(),
      name: "배포 확인",
      content: "# 배포\n\n스킬 본문에만 있는 `rollback-token`을 확인합니다."
    });

    const result = await library.search({ query: "rollback-token" });
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]?.description).toBe("");
  });

  it("stores, searches, and reads a version-pinned nested Markdown file tree", async () => {
    const library = await createLibrary();
    const created = await library.createBridgeSkill({
      requestId: randomUUID(),
      name: "API 검토",
      content: "# Main\n\nUse the supporting files only when relevant.",
      files: [
        { path: "references/API.md", content: "# API\n\nUse the `evidence-token` header." },
        { path: "examples/request.markdown", content: "```json\n{\"ok\":true}\n```\n" }
      ]
    });

    const read = await library.read({ reference: created });
    expect(read.files).toEqual([
      expect.objectContaining({ path: "examples/request.markdown", format: "markdown", bytes: 24 }),
      expect.objectContaining({ path: "references/API.md", format: "markdown" })
    ]);
    expect(read.content).toContain("Use the supporting files");
    expect(read.files[0]).not.toHaveProperty("content");
    expect(JSON.stringify(read.files)).not.toContain("evidence-token");
    expect((await library.search({ query: "evidence-token" })).skills).toHaveLength(1);
    expect((await library.search({ query: "request.markdown" })).skills).toHaveLength(1);

    const file = await library.readFile({ reference: created, path: "references/API.md" });
    expect(file).toMatchObject({
      kind: "skill-file",
      skill: { skillId: created.skillId, version: "1" },
      path: "references/API.md",
      content: expect.stringContaining("evidence-token"),
      format: "markdown"
    });
    expect(file.bytes).toBe(Buffer.byteLength(file.content, "utf8"));
    expect(file.contentDigest).toBe(sha256(file.content));
  });

  it("round-trips a decomposed Unicode path while using an NFC case-folded collision key", async () => {
    const library = await createLibrary();
    const decomposedPath = "references/Cafe\u0301.md";
    const created = await library.createBridgeSkill({
      requestId: randomUUID(),
      name: "Verbatim path",
      content: "# Main",
      files: [{ path: decomposedPath, content: "exact path" }]
    });

    expect((await library.read({ reference: created })).files[0]?.path).toBe(decomposedPath);
    expect((await library.readFile({ reference: created, path: decomposedPath })).path).toBe(decomposedPath);
    await expect(library.updateBridgeSkill({
      requestId: randomUUID(),
      skillId: created.skillId,
      expectedVersion: created.version,
      files: {
        upsert: [
          { path: decomposedPath, content: "one" },
          { path: "references/Caf\u00e9.md", content: "two" }
        ]
      }
    })).rejects.toThrow("SKILL_FILE_PATH_CONFLICT");
  });

  it("applies file changes atomically, keeps history immutable, and restores the whole tree", async () => {
    const library = await createLibrary();
    const first = await library.createBridgeSkill({
      requestId: randomUUID(), name: "Versioned package", content: "# One",
      files: [
        { path: "notes/keep.md", content: "keep-v1" },
        { path: "notes/remove.md", content: "remove-v1" }
      ]
    });
    const second = await library.updateBridgeSkill({
      requestId: randomUUID(), skillId: first.skillId, expectedVersion: first.version,
      content: "# Two",
      files: {
        upsert: [
          { path: "notes/keep.md", content: "keep-v2" },
          { path: "new/deep/reference.md", content: "new-v2" }
        ],
        remove: ["notes/remove.md"]
      }
    });

    expect((await library.read({ reference: first })).files.map((file) => file.path))
      .toEqual(["notes/keep.md", "notes/remove.md"]);
    expect((await library.readFile({ reference: first, path: "notes/keep.md" })).content).toBe("keep-v1");
    expect((await library.read({ reference: second })).files.map((file) => file.path))
      .toEqual(["new/deep/reference.md", "notes/keep.md"]);
    await expect(library.readFile({ reference: second, path: "notes/remove.md" })).rejects.toThrow("SKILL_FILE_NOT_FOUND");

    const restored = await library.restoreBridgeSkill({
      requestId: randomUUID(), skillId: first.skillId, expectedVersion: second.version, sourceVersion: first.version
    });
    expect(restored.version).toBe("3");
    expect((await library.read({ reference: restored })).content).toBe("# One");
    expect((await library.readFile({ reference: restored, path: "notes/remove.md" })).content).toBe("remove-v1");
  });

  it("treats a case-only attachment upsert as replacement on case-insensitive targets", async () => {
    const library = await createLibrary();
    const first = await library.createBridgeSkill({
      requestId: randomUUID(), name: "Case-aware files", content: "# Main",
      files: [{ path: "references/API.md", content: "old" }]
    });
    const second = await library.updateBridgeSkill({
      requestId: randomUUID(), skillId: first.skillId, expectedVersion: first.version,
      files: { upsert: [{ path: "references/api.md", content: "new" }] }
    });

    expect((await library.read({ reference: second })).files.map((file) => file.path))
      .toEqual(["references/api.md"]);
    expect((await library.readFile({ reference: second, path: "references/api.md" })).content).toBe("new");
  });

  it("rejects unsafe, conflicting, unsupported, and invalid-Unicode file inputs", async () => {
    const library = await createLibrary();
    const base = { requestId: randomUUID(), name: "Unsafe package", content: "# Main" };
    await expect(library.createBridgeSkill({ ...base, files: [{ path: "../escape.md", content: "x" }] }))
      .rejects.toThrow("SKILL_FILE_PATH_INVALID");
    await expect(library.createBridgeSkill({ ...base, requestId: randomUUID(), files: [{ path: "image.png", content: "x" }] }))
      .rejects.toThrow("SKILL_FILE_TYPE_UNSUPPORTED");
    await expect(library.createBridgeSkill({ ...base, requestId: randomUUID(), files: [{ path: "SKILL.md", content: "x" }] }))
      .rejects.toThrow("SKILL_FILE_TYPE_UNSUPPORTED");
    await expect(library.createBridgeSkill({ ...base, requestId: randomUUID(), files: [{ path: "document.md", content: "x" }] }))
      .rejects.toThrow("SKILL_FILE_TYPE_UNSUPPORTED");
    await expect(library.createBridgeSkill({
      ...base, requestId: randomUUID(), files: [
        { path: "Cafe\u0301.md", content: "one" },
        { path: "Caf\u00e9.md", content: "two" }
      ]
    })).rejects.toThrow("SKILL_FILE_PATH_CONFLICT");
    await expect(library.createBridgeSkill({
      ...base, requestId: randomUUID(), files: [{ path: "bad.md", content: "\ud800" }]
    })).rejects.toThrow("SKILL_FILE_INVALID");
  });

  it("rejects a persisted index that is not strict UTF-8", async () => {
    const root = await temporaryRoot();
    const directory = path.join(root, "bridge-skills");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "index.json"), Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]));
    const library = new SkillLibrary({ directory });

    await expect(library.search({})).rejects.toThrow("SKILL_LIBRARY_CORRUPT");
  });

  it("adapts a v2 structured record losslessly into legacy Markdown skill content", async () => {
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
    const skill = await library.read({ reference: { skillId, source: "bridge", version: "1" } });
    expect(skill.legacy).toBe(true);
    expect(skill.content).toContain(instructions);
    expect(skill.content).toContain(referenceContent.trim());
    expect(skill.content).toContain("Previous usage route: conversation-or-codex");
    expect(skill.content).toContain("environment:project-files — Choose the report folder.");

    const restored = await library.restoreBridgeSkill({
      requestId: randomUUID(), skillId, expectedVersion: "1", sourceVersion: "1"
    });
    const restoredSkill = await library.read({ reference: restored });
    expect(restored.version).toBe("2");
    expect(restoredSkill.legacy).toBe(false);
    expect(restoredSkill.content).toBe(skill.content);
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
    const skill = await library.read({ reference: { skillId, source: "bridge", version: "1" } });
    expect(skill).toMatchObject({ legacy: true, content: expect.stringContaining(instructions) });
    expect(skill.skill.enabled).toBe(true);
    expect(skill.content).toContain("Previous usage route: conversation-or-codex");

    const edited = await library.updateBridgeSkill({
      requestId: randomUUID(),
      skillId,
      expectedVersion: "1",
      content: "# Current free-form skill content\n"
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
      requestId: randomUUID(), name: "Release review", content: "# Review\n\nVerify the release."
    };
    const first = await library.createBridgeSkill(createRequest);
    const archived = await library.setBridgeSkillEnabled({
      requestId: randomUUID(), skillId: first.skillId, expectedVersion: "1", enabled: false
    });
    expect(archived.availability).toBe("disabled");
    expect((await library.read({ reference: first })).content).toContain("Verify the release");
    expect((await library.search({})).skills).toHaveLength(0);
    expect((await library.search({ includeDisabled: true })).skills).toHaveLength(1);

    const deleteRequest = {
      requestId: randomUUID(), skillId: first.skillId, expectedVersion: "1"
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
      schemaVersion: 6,
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
      requestId: randomUUID(), name: "Current skill", content: "# Current\n"
    });

    const index = await readFile(path.join(directory, "index.json"), "utf8");
    expect(index).not.toContain(staleName);
    expect(index).not.toContain(staleDescription);
    const parsed = JSON.parse(index);
    expect(parsed.schemaVersion).toBe(6);
    expect(parsed.mutationReceipts).toHaveLength(2);
    expect(parsed.mutationReceipts).toEqual(expect.arrayContaining([expect.objectContaining({
      requestId: staleRequestId,
      outcome: {
        kind: "invalidated",
        invalidation: { skillId: deletedSkillId, invalidatedAt: "2026-01-01T00:00:00.000Z" }
      }
    })]));
  });

  it("version-checks deletion without a typed name and rejects NUL skill content", async () => {
    const library = await createLibrary();
    const created = await library.createBridgeSkill({
      requestId: randomUUID(), name: "Delete check", content: "# Keep me"
    });
    await expect(library.deleteBridgeSkill({
      requestId: randomUUID(), skillId: created.skillId, expectedVersion: "2"
    })).rejects.toThrow("SKILL_VERSION_CHANGED");
    await expect(library.createBridgeSkill({
      requestId: randomUUID(), name: "Invalid", content: "before\u0000after"
    })).rejects.toThrow("SKILL_CONTENT_INVALID");
  });

  it("keeps the documented 3 MiB Markdown source capacity without a lower prompt cap", async () => {
    const library = await createLibrary();
    // U+0001 is accepted source text but serializes as six ASCII bytes in
    // JSON, exercising the documented worst-case transport envelope.
    const content = "\u0001".repeat(BRIDGE_SKILL_LIMITS.contentMaxBytes);
    const requestId = randomUUID();
    const serializedRequest = JSON.stringify({ requestId, name: "Large skill", content });
    expect(Buffer.byteLength(serializedRequest, "utf8")).toBeGreaterThan(8 * 1_024 * 1_024);
    expect(Buffer.byteLength(serializedRequest, "utf8")).toBeLessThanOrEqual(BRIDGE_SKILL_LIMITS.mutationWireMaxBytes);
    const created = await library.createBridgeSkill({
      requestId, name: "Large skill", content
    });
    expect((await library.read({ reference: created })).content).toHaveLength(content.length);
    await expect(library.updateBridgeSkill({
      requestId: randomUUID(), skillId: created.skillId, expectedVersion: "1", content: `${content}x`
    })).rejects.toThrow("SKILL_CONTENT_INVALID");
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

function legacyMarkdownDigest(
  name: string,
  description: string,
  document: string,
  files: Array<{ path: string; format: string; bytes: number; contentDigest: string }>
): string {
  return sha256(stableJson({
    name,
    description,
    document: {
      bytes: Buffer.byteLength(document, "utf8"),
      contentDigest: sha256(document),
      format: "markdown"
    },
    files,
    format: "markdown-tree"
  }));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
