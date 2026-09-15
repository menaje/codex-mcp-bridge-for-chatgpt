import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BRIDGE_SKILL_LIMITS, SkillLibrary } from "../src/skillLibrary.js";

describe("SkillLibrary", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("preserves verbatim instruction and reference bytes while canonicalizing human metadata", async () => {
    const root = await temporaryRoot();
    const library = new SkillLibrary({ directory: path.join(root, "bridge-skills") });
    const instructions = "  Café\r\n`./각`\r\n";
    const reference = "Café\r\n  keep trailing space  \r\n";
    const created = await library.createBridgeSkill({
      requestId: randomUUID(),
      name: "  Café  ",
      description: "  Café metadata  ",
      instructions,
      references: [{ name: "  Notes  ", content: reference }]
    });
    const document = await library.read({ reference: created });
    expect(document.skill.name).toBe("Café");
    expect(document.skill.description).toBe("Café metadata");
    expect(document.instructions).toBe(instructions);
    expect((await library.readReference({
      reference: created,
      referenceId: document.references[0]!.referenceId
    })).content).toBe(reference);
  });

  it("keeps bridge skill instructions and materials immutable by version", async () => {
    const root = await temporaryRoot();
    const library = new SkillLibrary({ directory: path.join(root, "bridge-skills") });
    const first = await library.createBridgeSkill({
      requestId: randomUUID(),
      name: "Report review",
      description: "Review a report with an evidence table.",
      instructions: "Check claims, evidence, and unresolved risks.",
      references: [{
        name: "Review table",
        mediaType: "text/markdown",
        content: "| Claim | Evidence | Risk |\n| --- | --- | --- |"
      }],
      executionMode: "conversation-or-codex",
      requirements: [
        { kind: "bridge-capability", id: "conversation" },
        { kind: "environment", id: "project-files", description: "The selected execution needs the report files." }
      ]
    });

    expect(first).toMatchObject({ source: "bridge", version: "1", availability: "available" });
    const versionOne = await library.read({ reference: first });
    expect(versionOne.instructions).toContain("unresolved risks");
    expect(versionOne.references).toHaveLength(1);

    const second = await library.updateBridgeSkill({
      requestId: randomUUID(),
      skillId: first.skillId,
      expectedVersion: first.version,
      name: "Evidence review",
      description: "Review a report with an evidence table and action items.",
      instructions: "Check claims, evidence, risks, and recommended fixes."
    });
    expect(second.version).toBe("2");
    expect(second.contentDigest).not.toBe(first.contentDigest);

    const preserved = await library.read({ reference: first });
    expect(preserved.skill).toMatchObject({
      name: "Report review",
      description: "Review a report with an evidence table."
    });
    expect(preserved.instructions).toContain("unresolved risks");
    const current = await library.read({ reference: second });
    expect(current.skill).toMatchObject({
      name: "Evidence review",
      description: "Review a report with an evidence table and action items."
    });
    expect(current.instructions).toContain("recommended fixes");
    expect(current.skill.execution.requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "project-files", availability: "external-environment" })
    ]));

    const material = await library.readReference({
      reference: first,
      referenceId: versionOne.references[0]!.referenceId
    });
    expect(material.content).toContain("Evidence");
    expect(material.sourceSnapshot).toBe("versioned-bridge-record");

    const delivery = await library.prepareForExecution({ references: [second] });
    expect(delivery.requiredSkills).toEqual([expect.objectContaining({
      skillId: second.skillId,
      version: "2",
      delivery: "bridge-instruction-bundle"
    })]);
    expect(delivery.promptPreamble).toContain("recommended fixes");
    expect(delivery.promptPreamble).toContain("environment:project-files (external-environment)");
    expect(delivery.promptPreamble).toContain("External environment prerequisite 'project-files'");

    const historicalDelivery = await library.prepareForExecution({ references: [first] });
    expect(historicalDelivery.requiredSkills).toEqual([expect.objectContaining({
      name: "Report review",
      version: "1"
    })]);
    expect(historicalDelivery.promptPreamble).toContain("[Required bridge skill: Report review]");
  });

  it("rejects references outside the bridge-owned source", async () => {
    const root = await temporaryRoot();
    const library = new SkillLibrary({ directory: path.join(root, "bridge-skills") });

    await expect(library.read({
      reference: { skillId: "external", source: "codex", version: "1" } as any
    })).rejects.toThrow("SKILL_SOURCE_UNSUPPORTED");
  });

  it("keeps reading a legacy version-one digest after migrating the index schema", async () => {
    const root = await temporaryRoot();
    const directory = path.join(root, "bridge-skills");
    const library = new SkillLibrary({ directory });
    const first = await library.createBridgeSkill({
      requestId: randomUUID(),
      name: "Legacy review",
      description: "Read a historical bridge skill.",
      instructions: "Use the original instructions exactly.",
      references: [{ name: "Legacy material", content: "Keep the reference content." }]
    });
    const indexPath = path.join(directory, "index.json");
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    const version = index.skills[0].versions[0];
    version.contentDigest = createHash("sha256").update(JSON.stringify({
      name: version.name,
      description: version.description,
      instructions: "Use the original instructions exactly.",
      references: version.references.map((reference: { referenceId: string; name: string; mediaType: string; contentDigest: string }) => ({
        referenceId: reference.referenceId,
        name: reference.name,
        mediaType: reference.mediaType,
        contentDigest: reference.contentDigest
      }))
    })).digest("hex");
    delete version.contentDigestVersion;
    delete version.executionMode;
    delete version.requirements;
    delete index.skills[0].enabled;
    delete index.mutationReceipts;
    index.schemaVersion = 1;
    await writeFile(indexPath, JSON.stringify(index, null, 2) + "\n", "utf8");

    const document = await library.read({ reference: first });
    expect(document.instructions).toBe("Use the original instructions exactly.");
    expect(document.skill.execution).toMatchObject({ mode: "conversation-or-codex", requirements: [] });
  });

  it("recovers a dead-owner lock and stale recovery claim before writing", async () => {
    const root = await temporaryRoot();
    const directory = path.join(root, "bridge-skills");
    const library = new SkillLibrary({ directory });
    const orphan = path.join(directory, `bridge_${"f".repeat(32)}`, "versions", "1");
    const lock = path.join(directory, ".mutation.lock");
    const recovery = path.join(lock, ".recovery");
    await mkdir(orphan, { recursive: true });
    await writeFile(path.join(orphan, "partial"), "interrupted write", "utf8");
    await mkdir(recovery, { recursive: true });
    await writeFile(path.join(lock, "owner.json"), JSON.stringify({
      token: randomUUID(), pid: 2_147_483_647, host: hostname()
    }), "utf8");
    await writeFile(path.join(recovery, "owner.json"), JSON.stringify({
      token: randomUUID(), pid: 2_147_483_647, host: hostname()
    }), "utf8");
    const stale = new Date(Date.now() - 180_000);
    await utimes(recovery, stale, stale);
    await utimes(lock, stale, stale);

    const created = await library.createBridgeSkill({
      requestId: randomUUID(),
      name: "Recovered write",
      description: "Verify mutation recovery.",
      instructions: "Create the next durable version."
    });

    expect(created.version).toBe("1");
    await expect(stat(orphan)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("replays an exact mutation, preserves history, and archives without deleting it", async () => {
    const root = await temporaryRoot();
    const library = new SkillLibrary({ directory: path.join(root, "bridge-skills") });
    const createRequestId = randomUUID();
    const create = {
      requestId: createRequestId,
      name: "Release review",
      description: "Review a release before publishing.",
      instructions: "Verify the release notes and blockers.",
      references: [{ name: "Checklist", content: "- changelog\n- tests\n" }]
    };
    const first = await library.createBridgeSkill(create);
    const replay = await library.createBridgeSkill(create);
    expect(replay).toEqual(first);
    await expect(library.createBridgeSkill({ ...create, description: "Different payload." }))
      .rejects.toThrow("SKILL_MUTATION_REQUEST_REUSED");

    const updated = await library.updateBridgeSkill({
      requestId: randomUUID(),
      skillId: first.skillId,
      expectedVersion: first.version,
      instructions: "Verify the release notes, blockers, and rollback plan."
    });
    const versions = await library.listBridgeSkillVersions({ skillId: first.skillId });
    expect(versions.currentVersion).toBe("2");
    expect(versions.versions.map((version) => version.version)).toEqual(["2", "1"]);

    const restored = await library.restoreBridgeSkill({
      requestId: randomUUID(),
      skillId: first.skillId,
      expectedVersion: updated.version,
      sourceVersion: "1"
    });
    expect(restored.version).toBe("3");
    expect((await library.read({ reference: restored })).instructions).toContain("release notes and blockers.");

    const disabled = await library.setBridgeSkillEnabled({
      requestId: randomUUID(),
      skillId: first.skillId,
      expectedVersion: restored.version,
      enabled: false
    });
    expect(disabled).toMatchObject({ enabled: false, availability: "disabled" });
    expect((await library.search({})).skills).toHaveLength(0);
    expect((await library.search({ includeDisabled: true })).skills).toEqual([
      expect.objectContaining({ skillId: first.skillId, enabled: false })
    ]);
    expect((await library.read({ reference: first })).warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("disabled")
    ]));
    await expect(library.prepareForExecution({ references: [restored] }))
      .rejects.toThrow("SKILL_DISABLED");
  });

  it("rejects NUL reference text before it can create an unreadable immutable version", async () => {
    const root = await temporaryRoot();
    const library = new SkillLibrary({ directory: path.join(root, "bridge-skills") });

    await expect(library.createBridgeSkill({
      requestId: randomUUID(),
      name: "Invalid reference text",
      description: "Do not persist a reference that cannot later be read as text.",
      instructions: "Reject invalid material before creating a version.",
      references: [{ name: "Broken text", content: "before\u0000after" }]
    })).rejects.toThrow("SKILL_REFERENCE_INVALID");

    await expect(library.search({ includeDisabled: true })).resolves.toEqual({ skills: [] });
  });

  it("keeps direct library metadata within the same material contract as its transports", async () => {
    const root = await temporaryRoot();
    const library = new SkillLibrary({ directory: path.join(root, "bridge-skills") });
    await expect(library.createBridgeSkill({
      requestId: randomUUID(),
      name: "Invalid media type",
      description: "Direct callers must not bypass the material metadata bound.",
      instructions: "Reject oversized material metadata before storing a version.",
      references: [{
        name: "Oversized MIME",
        content: "Reference text.",
        mediaType: `text/${"a".repeat(BRIDGE_SKILL_LIMITS.mediaTypeMaxCharacters)}`
      }]
    })).rejects.toThrow("SKILL_REFERENCE_MEDIA_TYPE_INVALID");
  });

  it("delivers a fully valid maximum-size bridge skill without a lower prompt cap", async () => {
    const root = await temporaryRoot();
    const library = new SkillLibrary({ directory: path.join(root, "bridge-skills") });
    const instruction = "i".repeat(BRIDGE_SKILL_LIMITS.instructionsMaxBytes);
    const material = "m".repeat(BRIDGE_SKILL_LIMITS.referenceMaxBytes);
    const skill = await library.createBridgeSkill({
      requestId: randomUUID(),
      name: "Maximum delivery payload",
      description: "Confirms storage-sized instructions and materials can reach Codex.",
      instructions: instruction,
      references: ["one", "two", "three", "four"].map((name) => ({ name, content: material }))
    });

    const delivery = await library.prepareForExecution({ references: [skill] });
    expect(Buffer.byteLength(delivery.promptPreamble, "utf8")).toBeLessThanOrEqual(
      BRIDGE_SKILL_LIMITS.executionBundleMaxBytes
    );
    expect(delivery.requiredSkills).toEqual([expect.objectContaining({ skillId: skill.skillId, version: "1" })]);
  });

  it("keeps an exact mutation receipt after more than 512 later mutations", async () => {
    const root = await temporaryRoot();
    const library = new SkillLibrary({ directory: path.join(root, "bridge-skills") });
    const create = {
      requestId: randomUUID(),
      name: "Long lived receipt",
      description: "Verify retry durability beyond a historical cap.",
      instructions: "Return the original result for this exact request."
    };
    const first = await library.createBridgeSkill(create);

    for (let index = 0; index < 513; index += 1) {
      await library.setBridgeSkillEnabled({
        requestId: randomUUID(),
        skillId: first.skillId,
        expectedVersion: first.version,
        enabled: index % 2 === 1
      });
    }

    await expect(library.createBridgeSkill(create)).resolves.toEqual(first);
    await expect(library.createBridgeSkill({ ...create, description: "Different retry payload." }))
      .rejects.toThrow("SKILL_MUTATION_REQUEST_REUSED");
  });

  async function temporaryRoot(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "skill-library-"));
    roots.push(root);
    return root;
  }
});
