import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { SkillLibrary } from "../src/skillLibrary.js";
import {
  BridgeSkillPackageUploads,
  deterministicBridgeSkillZip,
  inspectBridgeSkillZip,
  inspectBridgeSkillZipFile
} from "../src/skillPackage.js";

describe("Bridge skill ZIP packages", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("exports deterministic ZIP bytes and validates every Markdown entry", () => {
    const first = deterministicBridgeSkillZip("# Main\n", [
      { path: "references/api.md", content: "# API\n" },
      { path: "examples/use.markdown", content: "Use it.\n" }
    ]);
    const second = deterministicBridgeSkillZip("# Main\n", [
      { path: "examples/use.markdown", content: "Use it.\n" },
      { path: "references/api.md", content: "# API\n" }
    ]);
    expect(second.equals(first)).toBe(true);

    const inspection = inspectBridgeSkillZip(first);
    expect(inspection.suggestedMainPath).toBe("SKILL.md");
    expect(inspection.files.map((file) => file.path)).toEqual([
      "examples/use.markdown", "references/api.md", "SKILL.md"
    ]);
    expect(inspection.files.find((file) => file.path === "SKILL.md")?.content).toBe("# Main\n");
  });

  it("prefers root SKILL.md and suggests its frontmatter metadata", async () => {
    const root = await temporaryRoot();
    const uploads = new BridgeSkillPackageUploads(root);
    const skill = [
      "---",
      'name: "package-import-test"',
      "description: 'Use SKILL.md metadata before the archive name.'",
      "---",
      "",
      "# Imported skill",
      ""
    ].join("\n");
    const zip = deterministicBridgeSkillZip(
      "# Bridge skill content\n",
      [{ path: "SKILL.md", content: skill }],
      "document.md"
    );
    expect(inspectBridgeSkillZip(zip).suggestedMainPath).toBe("SKILL.md");

    const started = await uploads.begin();
    await uploads.append({ uploadId: started.uploadId, chunkIndex: 0, data: zip.toString("base64") });
    const inspection = await uploads.inspect(started.uploadId);
    expect(inspection).toMatchObject({
      suggestedMainPath: "SKILL.md",
      suggestedName: "package-import-test",
      suggestedDescription: "Use SKILL.md metadata before the archive name."
    });
    expect(await uploads.consume(started.uploadId, "SKILL.md", ["SKILL.md"])).toEqual({
      content: skill,
      files: []
    });
  });

  it("preserves Unicode path spelling while rejecting canonical path collisions", () => {
    const decomposedPath = "references/Cafe\u0301.md";
    const inspection = inspectBridgeSkillZip(
      deterministicBridgeSkillZip("# Main\n", [{ path: decomposedPath, content: "# Accent\n" }])
    );
    expect(inspection.files.find((file) => file.content === "# Accent\n")?.path).toBe(decomposedPath);

    expect(() => deterministicBridgeSkillZip("# Main\n", [
      { path: decomposedPath, content: "decomposed" },
      { path: "references/Café.md", content: "composed" }
    ])).toThrow("SKILL_PACKAGE_PATH_CONFLICT");
  });

  it("rejects text that UTF-8 encoding would otherwise replace or truncate", () => {
    expect(() => deterministicBridgeSkillZip("\ud800", []))
      .toThrow("SKILL_PACKAGE_TEXT_INVALID");
    expect(() => deterministicBridgeSkillZip("# Main\n", [
      { path: "references/invalid.md", content: "before\udc00after" }
    ])).toThrow("SKILL_PACKAGE_TEXT_INVALID");
  });

  it("rejects encrypted metadata, nested archives, traversal, and CRC tampering", () => {
    const source = deterministicBridgeSkillZip("# Main\n", []);
    const encrypted = Buffer.from(source);
    const central = encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    encrypted.writeUInt16LE(encrypted.readUInt16LE(central + 8) | 1, central + 8);
    expect(() => inspectBridgeSkillZip(encrypted)).toThrow("SKILL_PACKAGE_ENCRYPTED");

    expect(() => deterministicBridgeSkillZip("# Main", [{ path: "../escape.md", content: "x" }]))
      .toThrow("SKILL_PACKAGE_PATH_INVALID");
    expect(() => deterministicBridgeSkillZip("# Main", [{ path: "nested/archive.zip", content: "x" }]))
      .toThrow("SKILL_PACKAGE_FILE_UNSUPPORTED");

    const traversal = Buffer.from(deterministicBridgeSkillZip("# Main", [{ path: "aa/file.md", content: "x" }]));
    const safeName = Buffer.from("aa/file.md");
    const unsafeName = Buffer.from("../file.md");
    for (let offset = traversal.indexOf(safeName); offset >= 0; offset = traversal.indexOf(safeName, offset + unsafeName.length)) {
      unsafeName.copy(traversal, offset);
    }
    expect(() => inspectBridgeSkillZip(traversal)).toThrow("SKILL_PACKAGE_PATH_INVALID");

    const corrupt = Buffer.from(source);
    const body = corrupt.indexOf(Buffer.from("# Main\n"));
    corrupt[body] = corrupt[body]! ^ 1;
    expect(() => inspectBridgeSkillZip(corrupt)).toThrow("SKILL_PACKAGE_CORRUPT");
  });

  it("stages ordered chunks, inspects them, and consumes an upload once", async () => {
    const root = await temporaryRoot();
    const uploads = new BridgeSkillPackageUploads(root);
    const zip = deterministicBridgeSkillZip("# Main", [{ path: "refs/info.md", content: "details" }]);
    const started = await uploads.begin();
    const split = Math.floor(zip.length / 2);
    await uploads.append({ uploadId: started.uploadId, chunkIndex: 0, data: zip.subarray(0, split).toString("base64") });
    await expect(uploads.append({ uploadId: started.uploadId, chunkIndex: 2, data: zip.subarray(split).toString("base64") }))
      .rejects.toThrow("SKILL_UPLOAD_CHUNK_OUT_OF_ORDER");
    await uploads.append({ uploadId: started.uploadId, chunkIndex: 1, data: zip.subarray(split).toString("base64") });
    const inspection = await uploads.inspect(started.uploadId);
    expect(inspection.files.map((file) => file.path)).toEqual(["refs/info.md", "SKILL.md"]);
    const expanded = await uploads.consume(started.uploadId, "SKILL.md");
    expect(expanded).toEqual({ content: "# Main", files: [{ path: "refs/info.md", content: "details" }] });
    await expect(uploads.inspect(started.uploadId)).rejects.toThrow("SKILL_UPLOAD_NOT_FOUND");
  });

  it("range-reads and incrementally inflates uploaded deflate entries", async () => {
    const root = await temporaryRoot();
    const archive = path.join(root, "deflated.zip");
    await writeFile(archive, deflatedSingleEntryZip("wrapper/SKILL.md", "# Compressed\n\n안녕\n"));

    const inspection = await inspectBridgeSkillZipFile(archive);
    expect(inspection.strippedWrapper).toBe("wrapper");
    expect(inspection.suggestedMainPath).toBe("SKILL.md");
    expect(inspection.files).toMatchObject([{ path: "SKILL.md", content: "# Compressed\n\n안녕\n" }]);
  });

  it("accepts strict UTF-8 names without the ZIP hint and strips wrappers independently of macOS metadata", async () => {
    const root = await temporaryRoot();
    const archive = path.join(root, "finder-style.zip");
    const wrapper = "skill-library-import-test";
    const koreanPath = "notes/한글-파일명-테스트.markdown".normalize("NFD");
    const zip = storedEntriesZip([
      { path: `${wrapper}/SKILL.md`, content: "# Main\n" },
      { path: `${wrapper}/${koreanPath}`, content: "# 한글 경로\n" },
      { path: `__MACOSX/${wrapper}/notes/._${path.basename(koreanPath)}`, content: "AppleDouble metadata" }
    ], false);

    const memoryInspection = inspectBridgeSkillZip(zip);
    expect(memoryInspection.strippedWrapper).toBe(wrapper);
    expect(memoryInspection.suggestedMainPath).toBe("SKILL.md");
    expect(memoryInspection.files.map((file) => file.path)).toEqual([koreanPath, "SKILL.md"]);
    expect(memoryInspection.ignored).toContainEqual(expect.objectContaining({ reason: "macos-metadata" }));

    await writeFile(archive, zip);
    const streamingInspection = await inspectBridgeSkillZipFile(archive);
    expect(streamingInspection.strippedWrapper).toBe(wrapper);
    expect(streamingInspection.suggestedMainPath).toBe("SKILL.md");
    expect(streamingInspection.files.map((file) => file.path)).toEqual([koreanPath, "SKILL.md"]);
  });

  it("keeps Finder metadata out of imported Markdown while retaining diagnostics for UI aggregation", async () => {
    const root = await temporaryRoot();
    const archive = path.join(root, "finder-metadata.zip");
    const wrapper = "skill-library-import-test";
    const koreanPath = "notes/한글-파일명-테스트.markdown".normalize("NFD");
    const zip = storedEntriesZip([
      { path: `${wrapper}/SKILL.md`, content: "# Main\n" },
      { path: `${wrapper}/${koreanPath}`, content: "# 한글 경로\n" },
      { path: `${wrapper}/guides/start.md`, content: "# Start\n" },
      { path: `${wrapper}/references/api.md`, content: "# API\n" },
      { path: `${wrapper}/references/usage.markdown`, content: "# Usage\n" },
      { path: `${wrapper}/.DS_Store`, content: "Finder metadata" },
      { path: `${wrapper}/._SKILL.md`, content: "AppleDouble metadata" },
      { path: `${wrapper}/notes/._${path.basename(koreanPath)}`, content: "AppleDouble metadata" },
      { path: `__MACOSX/._${wrapper}`, content: "AppleDouble metadata" },
      { path: `__MACOSX/${wrapper}/._SKILL.md`, content: "AppleDouble metadata" },
      { path: `__MACOSX/${wrapper}/notes/._${path.basename(koreanPath)}`, content: "AppleDouble metadata" },
      { path: `__MACOSX/${wrapper}/._references`, content: "AppleDouble metadata" },
      { path: `__MACOSX/${wrapper}/references/._api.md`, content: "AppleDouble metadata" },
      { path: `__MACOSX/${wrapper}/references/._usage.markdown`, content: "AppleDouble metadata" }
    ], false);

    const memoryInspection = inspectBridgeSkillZip(zip);
    expect(memoryInspection.strippedWrapper).toBe(wrapper);
    expect(memoryInspection.suggestedMainPath).toBe("SKILL.md");
    expect(memoryInspection.files).toHaveLength(5);
    expect(memoryInspection.files.map((file) => file.path)).toEqual(expect.arrayContaining([
      "SKILL.md", koreanPath, "guides/start.md", "references/api.md", "references/usage.markdown"
    ]));
    expect(memoryInspection.ignored).toHaveLength(9);
    expect(memoryInspection.ignored.every((file) => file.reason === "macos-metadata")).toBe(true);

    await writeFile(archive, zip);
    const streamingInspection = await inspectBridgeSkillZipFile(archive);
    expect(streamingInspection.strippedWrapper).toBe(wrapper);
    expect(streamingInspection.suggestedMainPath).toBe("SKILL.md");
    expect(streamingInspection.files).toHaveLength(5);
    expect(streamingInspection.ignored).toEqual(memoryInspection.ignored);
  });

  it("still rejects malformed path bytes when the ZIP UTF-8 hint is absent", async () => {
    const root = await temporaryRoot();
    const archive = path.join(root, "invalid-path.zip");
    const zip = storedEntriesZip([{ path: "SKILL.md", content: "# Main\n" }], false);
    const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const centralOffset = zip.readUInt32LE(end + 16);
    zip[centralOffset + 46] = 0xff;

    expect(() => inspectBridgeSkillZip(zip)).toThrow("SKILL_PACKAGE_PATH_ENCODING_INVALID");
    await writeFile(archive, zip);
    await expect(inspectBridgeSkillZipFile(archive)).rejects.toThrow("SKILL_PACKAGE_PATH_ENCODING_INVALID");
  });

  it("allows only one concurrent consumer for an inspected upload", async () => {
    const root = await temporaryRoot();
    const uploads = new BridgeSkillPackageUploads(root);
    const zip = deterministicBridgeSkillZip("# Main", [{ path: "refs/info.md", content: "details" }]);
    const started = await uploads.begin();
    await uploads.append({ uploadId: started.uploadId, chunkIndex: 0, data: zip.toString("base64") });
    await uploads.inspect(started.uploadId);

    const outcomes = await Promise.allSettled([
      uploads.consume(started.uploadId, "SKILL.md"),
      uploads.consume(started.uploadId, "SKILL.md")
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const failure = outcomes.find((outcome) => outcome.status === "rejected");
    expect(failure?.status === "rejected" ? String(failure.reason) : "").toContain("SKILL_UPLOAD_NOT_FOUND");
  });

  it("commits an inspected package into the same immutable tree and exports it", async () => {
    const root = await temporaryRoot();
    const library = new SkillLibrary({ directory: path.join(root, "skills") });
    const zip = deterministicBridgeSkillZip("# Imported", [{ path: "refs/a.md", content: "A" }]);
    const upload = await library.beginBridgeSkillPackageUpload();
    await library.appendBridgeSkillPackageUpload({ uploadId: upload.uploadId, chunkIndex: 0, data: zip.toString("base64") });
    expect((await library.inspectBridgeSkillPackageUpload(upload.uploadId)).suggestedMainPath).toBe("SKILL.md");
    const created = await library.createBridgeSkillFromPackage({
      requestId: randomUUID(), name: "Imported package", uploadId: upload.uploadId, mainPath: "SKILL.md"
    });
    expect((await library.readFile({ reference: created, path: "refs/a.md" })).content).toBe("A");
    const exported = await library.exportBridgeSkillPackage(created);
    expect(inspectBridgeSkillZip(exported).files.map((file) => file.path)).toEqual(["refs/a.md", "SKILL.md"]);
  });

  it("keeps a single-use upload retryable until the version mutation commits", async () => {
    const root = await temporaryRoot();
    const library = new SkillLibrary({ directory: path.join(root, "skills") });
    await library.createBridgeSkill({ requestId: randomUUID(), name: "Existing", content: "# Existing" });
    const zip = deterministicBridgeSkillZip("# Imported", []);
    const upload = await library.beginBridgeSkillPackageUpload();
    await library.appendBridgeSkillPackageUpload({ uploadId: upload.uploadId, chunkIndex: 0, data: zip.toString("base64") });

    await expect(library.createBridgeSkillFromPackage({
      requestId: randomUUID(), name: "Existing", uploadId: upload.uploadId, mainPath: "SKILL.md"
    })).rejects.toThrow("SKILL_NAME_CONFLICT");
    expect((await library.inspectBridgeSkillPackageUpload(upload.uploadId)).files).toHaveLength(1);

    const created = await library.createBridgeSkillFromPackage({
      requestId: randomUUID(), name: "Retry succeeds", uploadId: upload.uploadId, mainPath: "SKILL.md"
    });
    expect(created.name).toBe("Retry succeeds");
    await expect(library.inspectBridgeSkillPackageUpload(upload.uploadId)).rejects.toThrow("SKILL_UPLOAD_NOT_FOUND");
  });

  async function temporaryRoot(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "bridge-skill-package-"));
    roots.push(root);
    return root;
  }
});

function deflatedSingleEntryZip(filePath: string, content: string): Buffer {
  const name = Buffer.from(filePath, "utf8");
  const expanded = Buffer.from(content, "utf8");
  const compressed = deflateRawSync(expanded);
  const crc = testCrc32(expanded);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(expanded.length, 22);
  local.writeUInt16LE(name.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE((3 << 8) | 20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(expanded.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE((0o100600 << 16) >>> 0, 38);

  const centralOffset = local.length + name.length + compressed.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, name, compressed, central, name, end]);
}

function storedEntriesZip(
  entries: ReadonlyArray<{ path: string; content: string }>,
  utf8Flag = true
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  const flags = utf8Flag ? 0x0800 : 0;
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const content = Buffer.from(entry.content, "utf8");
    const crc = testCrc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100600 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, content);
    centrals.push(central, name);
    offset += local.length + name.length + content.length;
  }
  const centralSize = centrals.reduce((total, entry) => total + entry.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

function testCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
