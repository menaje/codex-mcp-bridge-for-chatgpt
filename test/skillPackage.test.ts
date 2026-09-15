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
    expect(inspection.suggestedMainPath).toBe("document.md");
    expect(inspection.files.map((file) => file.path)).toEqual([
      "document.md", "examples/use.markdown", "references/api.md"
    ]);
    expect(inspection.files.find((file) => file.path === "document.md")?.content).toBe("# Main\n");
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
    expect(inspection.files.map((file) => file.path)).toEqual(["document.md", "refs/info.md"]);
    const expanded = await uploads.consume(started.uploadId, "document.md");
    expect(expanded).toEqual({ document: "# Main", files: [{ path: "refs/info.md", content: "details" }] });
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

  it("allows only one concurrent consumer for an inspected upload", async () => {
    const root = await temporaryRoot();
    const uploads = new BridgeSkillPackageUploads(root);
    const zip = deterministicBridgeSkillZip("# Main", [{ path: "refs/info.md", content: "details" }]);
    const started = await uploads.begin();
    await uploads.append({ uploadId: started.uploadId, chunkIndex: 0, data: zip.toString("base64") });
    await uploads.inspect(started.uploadId);

    const outcomes = await Promise.allSettled([
      uploads.consume(started.uploadId, "document.md"),
      uploads.consume(started.uploadId, "document.md")
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
    expect((await library.inspectBridgeSkillPackageUpload(upload.uploadId)).suggestedMainPath).toBe("document.md");
    const created = await library.createBridgeSkillFromPackage({
      requestId: randomUUID(), name: "Imported package", uploadId: upload.uploadId, mainPath: "document.md"
    });
    expect((await library.readFile({ reference: created, path: "refs/a.md" })).content).toBe("A");
    const exported = await library.exportBridgeSkillPackage(created);
    expect(inspectBridgeSkillZip(exported).files.map((file) => file.path)).toEqual(["document.md", "refs/a.md"]);
  });

  it("keeps a single-use upload retryable until the version mutation commits", async () => {
    const root = await temporaryRoot();
    const library = new SkillLibrary({ directory: path.join(root, "skills") });
    await library.createBridgeSkill({ requestId: randomUUID(), name: "Existing", document: "# Existing" });
    const zip = deterministicBridgeSkillZip("# Imported", []);
    const upload = await library.beginBridgeSkillPackageUpload();
    await library.appendBridgeSkillPackageUpload({ uploadId: upload.uploadId, chunkIndex: 0, data: zip.toString("base64") });

    await expect(library.createBridgeSkillFromPackage({
      requestId: randomUUID(), name: "Existing", uploadId: upload.uploadId, mainPath: "document.md"
    })).rejects.toThrow("SKILL_NAME_CONFLICT");
    expect((await library.inspectBridgeSkillPackageUpload(upload.uploadId)).files).toHaveLength(1);

    const created = await library.createBridgeSkillFromPackage({
      requestId: randomUUID(), name: "Retry succeeds", uploadId: upload.uploadId, mainPath: "document.md"
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

function testCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
