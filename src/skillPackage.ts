import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readdir, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { createInflateRaw, inflateRawSync } from "node:zlib";
import { decodeUtf8Strict, searchKey, utf8ByteLength, verbatimText } from "./textIntegrity.js";

export const BRIDGE_SKILL_PACKAGE_LIMITS = Object.freeze({
  compressedMaxBytes: 16 * 1_024 * 1_024,
  expandedMaxBytes: 11 * 1_024 * 1_024,
  fileMaxBytes: 3 * 1_024 * 1_024,
  fileMaxCount: 129,
  pathMaxBytes: 1_024,
  pathMaxDepth: 32,
  compressionRatioMax: 100,
  uploadChunkMaxBytes: 512 * 1_024,
  uploadTtlMs: 10 * 60 * 1_000
});

export type BridgeSkillPackageFile = {
  path: string;
  content: string;
  bytes: number;
  contentDigest: string;
  format: "markdown";
};

export type BridgeSkillPackageInspection = {
  uploadId: string;
  expiresAt: string;
  files: Array<Omit<BridgeSkillPackageFile, "content">>;
  suggestedMainPath: string | null;
  suggestedName?: string;
  suggestedDescription?: string;
  ignored: Array<{ path: string; reason: "macos-metadata" | "unsupported-file" }>;
  strippedWrapper: string | null;
};

type Upload = {
  file: string;
  nextChunk: number;
  bytes: number;
  expiresAt: number;
  inspected?: {
    files: BridgeSkillPackageFile[];
    inspection: BridgeSkillPackageInspection;
  };
  consuming?: boolean;
};

/** Process-local, expiring upload staging. Committed IDs are consumed once. */
export class BridgeSkillPackageUploads {
  private readonly uploads = new Map<string, Upload>();

  constructor(private readonly directory: string, private readonly now: () => number = Date.now) {}

  async begin(): Promise<{ uploadId: string; expiresAt: string; chunkMaxBytes: number }> {
    await this.reap();
    const uploadId = randomUUID();
    const root = path.join(this.directory, ".uploads");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const file = path.join(root, `${uploadId}.zip.part`);
    await writeFile(file, new Uint8Array(), { mode: 0o600, flag: "wx" });
    const expiresAt = this.now() + BRIDGE_SKILL_PACKAGE_LIMITS.uploadTtlMs;
    this.uploads.set(uploadId, { file, nextChunk: 0, bytes: 0, expiresAt });
    return { uploadId, expiresAt: new Date(expiresAt).toISOString(), chunkMaxBytes: BRIDGE_SKILL_PACKAGE_LIMITS.uploadChunkMaxBytes };
  }

  async append(input: { uploadId: string; chunkIndex: number; data: string }): Promise<{ receivedBytes: number; nextChunk: number }> {
    await this.reap();
    const upload = this.require(input.uploadId);
    if (upload.inspected) throw new Error("SKILL_UPLOAD_ALREADY_INSPECTED: Start a new upload to change package bytes.");
    if (!Number.isSafeInteger(input.chunkIndex) || input.chunkIndex !== upload.nextChunk) {
      throw new Error("SKILL_UPLOAD_CHUNK_OUT_OF_ORDER: Upload chunks must be contiguous and ordered.");
    }
    if (typeof input.data !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(input.data)) {
      throw new Error("SKILL_UPLOAD_CHUNK_INVALID: Upload chunk is not canonical base64.");
    }
    const bytes = Buffer.from(input.data, "base64");
    if (bytes.byteLength < 1 || bytes.byteLength > BRIDGE_SKILL_PACKAGE_LIMITS.uploadChunkMaxBytes ||
      bytes.toString("base64") !== input.data) {
      throw new Error("SKILL_UPLOAD_CHUNK_INVALID: Upload chunk has an invalid size or encoding.");
    }
    if (upload.bytes + bytes.byteLength > BRIDGE_SKILL_PACKAGE_LIMITS.compressedMaxBytes) {
      await this.discard(input.uploadId);
      throw new Error("SKILL_PACKAGE_COMPRESSED_TOO_LARGE: ZIP exceeds the compressed upload limit.");
    }
    await appendFile(upload.file, bytes);
    upload.bytes += bytes.byteLength;
    upload.nextChunk += 1;
    return { receivedBytes: upload.bytes, nextChunk: upload.nextChunk };
  }

  async inspect(uploadId: string): Promise<BridgeSkillPackageInspection> {
    await this.reap();
    const upload = this.require(uploadId);
    if (!upload.inspected) {
      if (upload.bytes < 1) throw new Error("SKILL_PACKAGE_EMPTY: Upload at least one ZIP chunk before inspection.");
      const expanded = await inspectBridgeSkillZipFile(upload.file);
      const metadata = suggestedSkillMetadata(expanded.files, expanded.suggestedMainPath);
      const inspection: BridgeSkillPackageInspection = {
        uploadId,
        expiresAt: new Date(upload.expiresAt).toISOString(),
        files: expanded.files.map(({ content: _content, ...file }) => file),
        suggestedMainPath: expanded.suggestedMainPath,
        ...(metadata.name === undefined ? {} : { suggestedName: metadata.name }),
        ...(metadata.description === undefined ? {} : { suggestedDescription: metadata.description }),
        ignored: expanded.ignored,
        strippedWrapper: expanded.strippedWrapper
      };
      upload.inspected = { files: expanded.files, inspection };
    }
    return structuredClone(upload.inspected.inspection);
  }

  async consume(
    uploadId: string,
    mainPath: string | null,
    includePaths?: readonly string[]
  ): Promise<{ document?: string; files: Array<{ path: string; content: string }> }> {
    return this.commit(uploadId, mainPath, includePaths, async (selection) => selection);
  }

  /** Keep the inspected upload retryable until its version mutation commits. */
  async commit<Result>(
    uploadId: string,
    mainPath: string | null,
    includePaths: readonly string[] | undefined,
    operation: (selection: { document?: string; files: Array<{ path: string; content: string }> }) => Promise<Result>
  ): Promise<Result> {
    const inspection = await this.inspect(uploadId);
    const upload = this.require(uploadId);
    if (upload.consuming) {
      throw new Error("SKILL_UPLOAD_NOT_FOUND: The upload is unknown, expired, or already used.");
    }
    upload.consuming = true;
    try {
      const normalizedMain = mainPath === null ? null : normalizePackagePath(mainPath);
      const available = new Map(upload.inspected!.files.map((file) => [file.path, file]));
      const selectedPaths = includePaths === undefined
        ? new Set(available.keys())
        : new Set(includePaths.map(normalizePackagePath));
      if (selectedPaths.size === 0 || (includePaths !== undefined && selectedPaths.size !== includePaths.length) ||
        [...selectedPaths].some((filePath) => !available.has(filePath))) {
        throw new Error("SKILL_PACKAGE_SELECTION_INVALID: Select unique paths from the inspected package.");
      }
      if (normalizedMain !== null && !selectedPaths.has(normalizedMain)) {
        throw new Error("SKILL_PACKAGE_SELECTION_INVALID: The main document must remain selected.");
      }
      const selected = normalizedMain === null ? undefined : available.get(normalizedMain);
      if (normalizedMain !== null && !selected) {
        throw new Error("SKILL_PACKAGE_MAIN_NOT_FOUND: Select a Markdown path from the inspected package.");
      }
      const files = upload.inspected!.files
        .filter((file) => selectedPaths.has(file.path))
        .filter((file) => file.path !== selected?.path)
        .map(({ path: filePath, content }) => ({ path: filePath, content }));
      const reservedMain = files.find((file) => {
        const key = packagePathCollisionKey(file.path);
        return key === "skill.md" || key === "document.md";
      });
      if (reservedMain) {
        throw new Error(`SKILL_PACKAGE_MAIN_CONFLICT: ${reservedMain.path} must be selected as the main document or excluded.`);
      }
      const result = await operation({ ...(selected ? { document: selected.content } : {}), files });
      await this.discard(inspection.uploadId);
      return result;
    } catch (error) {
      if (this.uploads.get(uploadId) === upload) upload.consuming = false;
      throw error;
    }
  }

  async discard(uploadId: string): Promise<void> {
    const upload = this.uploads.get(uploadId);
    this.uploads.delete(uploadId);
    if (upload) await rm(upload.file, { force: true }).catch(() => undefined);
  }

  private require(uploadId: string): Upload {
    const upload = this.uploads.get(uploadId);
    if (!upload) throw new Error("SKILL_UPLOAD_NOT_FOUND: The upload is unknown, expired, or already used.");
    return upload;
  }

  private async reap(): Promise<void> {
    const expired = [...this.uploads].filter(([, upload]) => upload.expiresAt <= this.now());
    await Promise.all(expired.map(([uploadId]) => this.discard(uploadId)));
    const root = path.join(this.directory, ".uploads");
    const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const activeFiles = new Set([...this.uploads.values()].map((upload) => path.basename(upload.file)));
    await Promise.all(entries.map(async (entry) => {
      if (!entry.isFile() || activeFiles.has(entry.name) ||
        !/^[0-9a-f-]{36}\.zip\.part$/iu.test(entry.name)) return;
      const file = path.join(root, entry.name);
      const information = await stat(file).catch(() => undefined);
      if (information && this.now() - information.mtimeMs > BRIDGE_SKILL_PACKAGE_LIMITS.uploadTtlMs) {
        await rm(file, { force: true });
      }
    }));
  }
}

export function inspectBridgeSkillZip(bytes: Uint8Array): {
  files: BridgeSkillPackageFile[];
  suggestedMainPath: string | null;
  ignored: BridgeSkillPackageInspection["ignored"];
  strippedWrapper: string | null;
} {
  if (bytes.byteLength < 22 || bytes.byteLength > BRIDGE_SKILL_PACKAGE_LIMITS.compressedMaxBytes) {
    throw new Error("SKILL_PACKAGE_INVALID: ZIP is empty, truncated, or exceeds the compressed size limit.");
  }
  const buffer = Buffer.from(bytes);
  const end = findEndOfCentralDirectory(buffer);
  const entriesOnDisk = buffer.readUInt16LE(end + 8);
  const count = buffer.readUInt16LE(end + 10);
  const centralSize = buffer.readUInt32LE(end + 12);
  const centralOffset = buffer.readUInt32LE(end + 16);
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error("SKILL_PACKAGE_ZIP64_UNSUPPORTED: ZIP64 packages are not accepted.");
  }
  if (entriesOnDisk !== count || count > BRIDGE_SKILL_PACKAGE_LIMITS.fileMaxCount || centralOffset + centralSize > end) {
    throw new Error("SKILL_PACKAGE_INVALID: ZIP central directory is inconsistent.");
  }

  type Entry = { originalPath: string; path: string; method: number; flags: number; crc: number; compressed: number; expanded: number; offset: number };
  const entries: Entry[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error("SKILL_PACKAGE_INVALID: ZIP central directory entry is invalid.");
    }
    const madeBy = buffer.readUInt16LE(cursor + 4);
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressed = buffer.readUInt32LE(cursor + 20);
    const expanded = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const external = buffer.readUInt32LE(cursor + 38);
    const offset = buffer.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > buffer.length || flags & 0x0001 || ![0, 8].includes(method)) {
      throw new Error(flags & 0x0001
        ? "SKILL_PACKAGE_ENCRYPTED: Encrypted ZIP entries are not accepted."
        : "SKILL_PACKAGE_COMPRESSION_UNSUPPORTED: ZIP uses an unsupported compression method.");
    }
    const nameBytes = buffer.subarray(cursor + 46, cursor + 46 + nameLength);
    // Several macOS ZIP producers store valid UTF-8 names without setting the
    // advisory language-encoding bit. The strict decoder is the trust
    // boundary: accept bytes that are actually UTF-8 and still reject every
    // ambiguous or malformed legacy-encoded path.
    const originalPath = decodeUtf8Strict(nameBytes, "SKILL_PACKAGE_PATH_ENCODING_INVALID: ZIP path");
    const normalizedPath = normalizeArchiveEntryPath(originalPath, originalPath.endsWith("/"));
    const unixMode = madeBy >> 8 === 3 ? external >>> 16 : 0;
    const fileType = unixMode & 0o170000;
    if (fileType && fileType !== 0o100000 && fileType !== 0o040000) {
      throw new Error("SKILL_PACKAGE_SPECIAL_FILE: Symlinks, hard links, and special files are not accepted.");
    }
    if (!originalPath.endsWith("/")) {
      entries.push({
        originalPath,
        path: normalizedPath,
        method,
        flags,
        crc,
        compressed,
        expanded,
        offset
      });
    }
    cursor = next;
  }
  if (cursor !== centralOffset + centralSize) throw new Error("SKILL_PACKAGE_INVALID: ZIP central directory size is inconsistent.");

  const wrapper = stripCommonPackageWrapper(entries);
  const ignored: BridgeSkillPackageInspection["ignored"] = [];
  const files: BridgeSkillPackageFile[] = [];
  const keys = new Set<string>();
  let totalExpanded = 0;
  for (const entry of entries) {
    const rawPath = entry.path;
    assertEntryExpansionLimits(entry);
    totalExpanded += entry.expanded;
    if (totalExpanded > BRIDGE_SKILL_PACKAGE_LIMITS.expandedMaxBytes) {
      throw new Error("SKILL_PACKAGE_EXPANDED_TOO_LARGE: ZIP exceeds the expanded file-count or byte limit.");
    }
    if (isMacMetadata(rawPath)) {
      ignored.push({ path: rawPath, reason: "macos-metadata" });
      continue;
    }
    if (/\.(?:zip|tar|tgz|gz|bz2|xz|7z|rar)$/iu.test(rawPath)) {
      throw new Error("SKILL_PACKAGE_NESTED_ARCHIVE: Nested archives are not accepted.");
    }
    if (!/\.(?:md|markdown)$/iu.test(rawPath)) {
      ignored.push({ path: rawPath, reason: "unsupported-file" });
      continue;
    }
    const filePath = normalizePackagePath(rawPath);
    const key = packagePathCollisionKey(filePath);
    if (keys.has(key)) throw new Error(`SKILL_PACKAGE_PATH_CONFLICT: ${filePath} conflicts with another path.`);
    keys.add(key);
    const contentBytes = extractEntry(buffer, entry, centralOffset);
    if (contentBytes.byteLength !== entry.expanded || crc32(contentBytes) !== entry.crc) {
      throw new Error("SKILL_PACKAGE_CORRUPT: A ZIP entry failed size or CRC verification.");
    }
    const content = decodeUtf8Strict(contentBytes, `SKILL_PACKAGE_TEXT_INVALID: ${filePath}`);
    if (content.includes("\u0000")) throw new Error("SKILL_PACKAGE_TEXT_INVALID: Markdown files cannot contain NUL characters.");
    files.push({ path: filePath, content, format: "markdown", bytes: contentBytes.byteLength, contentDigest: sha256(contentBytes) });
  }
  files.sort((left, right) => left.path.localeCompare(right.path, "en-US", { sensitivity: "variant" }));
  if (files.length === 0) throw new Error("SKILL_PACKAGE_NO_MARKDOWN: ZIP does not contain a supported Markdown file.");
  const rootSkill = files.find((file) => file.path === "SKILL.md");
  const rootDocument = files.find((file) => file.path === "document.md");
  const suggestedMainPath = rootSkill?.path ?? rootDocument?.path ?? (files.length === 1 ? files[0]!.path : null);
  return { files, suggestedMainPath, ignored, strippedWrapper: wrapper };
}

/**
 * Inspect an uploaded ZIP without reading the compressed archive into one
 * in-memory buffer. Central-directory and local headers are read by range;
 * entry data is consumed in bounded chunks and deflate output is bounded as
 * it is produced. Expanded Markdown remains in memory only after it has
 * passed the per-file and aggregate limits because a later single-use commit
 * must retain the inspected bytes exactly.
 */
export async function inspectBridgeSkillZipFile(file: string): Promise<{
  files: BridgeSkillPackageFile[];
  suggestedMainPath: string | null;
  ignored: BridgeSkillPackageInspection["ignored"];
  strippedWrapper: string | null;
}> {
  const information = await stat(file);
  if (!information.isFile() || information.size < 22 || information.size > BRIDGE_SKILL_PACKAGE_LIMITS.compressedMaxBytes) {
    throw new Error("SKILL_PACKAGE_INVALID: ZIP is empty, truncated, or exceeds the compressed size limit.");
  }
  const handle = await open(file, "r");
  try {
    const tailLength = Math.min(information.size, 65_557);
    const tailOffset = information.size - tailLength;
    const tail = await readExactly(handle, tailOffset, tailLength);
    const relativeEnd = findEndOfCentralDirectory(tail);
    const end = tailOffset + relativeEnd;
    const entriesOnDisk = tail.readUInt16LE(relativeEnd + 8);
    const count = tail.readUInt16LE(relativeEnd + 10);
    const centralSize = tail.readUInt32LE(relativeEnd + 12);
    const centralOffset = tail.readUInt32LE(relativeEnd + 16);
    if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      throw new Error("SKILL_PACKAGE_ZIP64_UNSUPPORTED: ZIP64 packages are not accepted.");
    }
    if (entriesOnDisk !== count || count > BRIDGE_SKILL_PACKAGE_LIMITS.fileMaxCount || centralOffset + centralSize > end) {
      throw new Error("SKILL_PACKAGE_INVALID: ZIP central directory is inconsistent.");
    }

    const entries: StreamingZipEntry[] = [];
    let cursor = centralOffset;
    for (let index = 0; index < count; index += 1) {
      const header = await readExactly(handle, cursor, 46);
      if (header.readUInt32LE(0) !== 0x02014b50) {
        throw new Error("SKILL_PACKAGE_INVALID: ZIP central directory entry is invalid.");
      }
      const madeBy = header.readUInt16LE(4);
      const flags = header.readUInt16LE(8);
      const method = header.readUInt16LE(10);
      const crc = header.readUInt32LE(16);
      const compressed = header.readUInt32LE(20);
      const expanded = header.readUInt32LE(24);
      const nameLength = header.readUInt16LE(28);
      const extraLength = header.readUInt16LE(30);
      const commentLength = header.readUInt16LE(32);
      const external = header.readUInt32LE(38);
      const offset = header.readUInt32LE(42);
      const next = cursor + 46 + nameLength + extraLength + commentLength;
      if (next > centralOffset + centralSize || flags & 0x0001 || ![0, 8].includes(method)) {
        throw new Error(flags & 0x0001
          ? "SKILL_PACKAGE_ENCRYPTED: Encrypted ZIP entries are not accepted."
          : "SKILL_PACKAGE_COMPRESSION_UNSUPPORTED: ZIP uses an unsupported compression method.");
      }
      const nameBytes = await readExactly(handle, cursor + 46, nameLength);
      // Treat the actual byte validity, rather than a frequently omitted ZIP
      // hint bit, as authoritative. Invalid UTF-8 remains a hard failure.
      const originalPath = decodeUtf8Strict(nameBytes, "SKILL_PACKAGE_PATH_ENCODING_INVALID: ZIP path");
      const directory = originalPath.endsWith("/");
      const normalizedPath = normalizeArchiveEntryPath(originalPath, directory);
      const unixMode = madeBy >> 8 === 3 ? external >>> 16 : 0;
      const fileType = unixMode & 0o170000;
      if (fileType && fileType !== 0o100000 && fileType !== 0o040000) {
        throw new Error("SKILL_PACKAGE_SPECIAL_FILE: Symlinks, hard links, and special files are not accepted.");
      }
      if (!directory) {
        entries.push({ originalPath, path: normalizedPath, method, flags, crc, compressed, expanded, offset });
      }
      cursor = next;
    }
    if (cursor !== centralOffset + centralSize) {
      throw new Error("SKILL_PACKAGE_INVALID: ZIP central directory size is inconsistent.");
    }

    const wrapper = stripCommonPackageWrapper(entries);
    const ignored: BridgeSkillPackageInspection["ignored"] = [];
    const files: BridgeSkillPackageFile[] = [];
    const keys = new Set<string>();
    let totalExpanded = 0;
    for (const entry of entries) {
      const rawPath = entry.path;
      assertEntryExpansionLimits(entry);
      totalExpanded += entry.expanded;
      if (totalExpanded > BRIDGE_SKILL_PACKAGE_LIMITS.expandedMaxBytes) {
        throw new Error("SKILL_PACKAGE_EXPANDED_TOO_LARGE: ZIP exceeds the expanded file-count or byte limit.");
      }
      if (isMacMetadata(rawPath)) {
        ignored.push({ path: rawPath, reason: "macos-metadata" });
        continue;
      }
      if (/\.(?:zip|tar|tgz|gz|bz2|xz|7z|rar)$/iu.test(rawPath)) {
        throw new Error("SKILL_PACKAGE_NESTED_ARCHIVE: Nested archives are not accepted.");
      }
      if (!/\.(?:md|markdown)$/iu.test(rawPath)) {
        ignored.push({ path: rawPath, reason: "unsupported-file" });
        continue;
      }
      const filePath = normalizePackagePath(rawPath);
      const key = packagePathCollisionKey(filePath);
      if (keys.has(key)) throw new Error(`SKILL_PACKAGE_PATH_CONFLICT: ${filePath} conflicts with another path.`);
      keys.add(key);
      const contentBytes = await extractEntryFromFile(handle, entry, centralOffset);
      if (contentBytes.byteLength !== entry.expanded || crc32(contentBytes) !== entry.crc) {
        throw new Error("SKILL_PACKAGE_CORRUPT: A ZIP entry failed size or CRC verification.");
      }
      const content = decodeUtf8Strict(contentBytes, `SKILL_PACKAGE_TEXT_INVALID: ${filePath}`);
      if (content.includes("\u0000")) throw new Error("SKILL_PACKAGE_TEXT_INVALID: Markdown files cannot contain NUL characters.");
      files.push({ path: filePath, content, format: "markdown", bytes: contentBytes.byteLength, contentDigest: sha256(contentBytes) });
    }
    files.sort((left, right) => left.path.localeCompare(right.path, "en-US", { sensitivity: "variant" }));
    if (files.length === 0) throw new Error("SKILL_PACKAGE_NO_MARKDOWN: ZIP does not contain a supported Markdown file.");
    const rootSkill = files.find((entry) => entry.path === "SKILL.md");
    const rootDocument = files.find((entry) => entry.path === "document.md");
    const suggestedMainPath = rootSkill?.path ?? rootDocument?.path ?? (files.length === 1 ? files[0]!.path : null);
    return { files, suggestedMainPath, ignored, strippedWrapper: wrapper };
  } finally {
    await handle.close();
  }
}

export function deterministicBridgeSkillZip(
  document: string,
  files: ReadonlyArray<{ path: string; content: string }>,
  mainPath: "SKILL.md" | "document.md" = "SKILL.md"
): Buffer {
  const entries = [{ path: mainPath, content: document }, ...files]
    .map((entry) => {
      const filePath = normalizeExportPath(entry.path);
      return { path: filePath, bytes: encodePackageText(entry.content, filePath) };
    })
    .sort((left, right) => left.path.localeCompare(right.path, "en-US", { sensitivity: "variant" }));
  const pathKeys = new Set<string>();
  for (const entry of entries) {
    const key = packagePathCollisionKey(entry.path);
    if (pathKeys.has(key)) throw new Error(`SKILL_PACKAGE_PATH_CONFLICT: ${entry.path} conflicts with another path.`);
    pathKeys.add(key);
  }
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const crc = crc32(entry.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.bytes.length, 18);
    local.writeUInt32LE(entry.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, entry.bytes);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.bytes.length, 20);
    central.writeUInt32LE(entry.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100600 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + entry.bytes.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      const commentLength = buffer.readUInt16LE(offset + 20);
      if (offset + 22 + commentLength === buffer.length && buffer.readUInt16LE(offset + 4) === 0 && buffer.readUInt16LE(offset + 6) === 0) {
        return offset;
      }
    }
  }
  throw new Error("SKILL_PACKAGE_INVALID: ZIP end record is missing.");
}

function extractEntry(buffer: Buffer, entry: StreamingZipEntry, centralOffset: number): Buffer {
  if (entry.offset + 30 > buffer.length || buffer.readUInt32LE(entry.offset) !== 0x04034b50) {
    throw new Error("SKILL_PACKAGE_INVALID: ZIP local entry is invalid.");
  }
  if (buffer.readUInt16LE(entry.offset + 8) !== entry.method ||
    (buffer.readUInt16LE(entry.offset + 6) & 0x0809) !== (entry.flags & 0x0809)) {
    throw new Error("SKILL_PACKAGE_INVALID: ZIP local and central entry metadata do not match.");
  }
  const nameLength = buffer.readUInt16LE(entry.offset + 26);
  const extraLength = buffer.readUInt16LE(entry.offset + 28);
  const localName = buffer.subarray(entry.offset + 30, entry.offset + 30 + nameLength);
  if (!localName.equals(Buffer.from(entry.originalPath, "utf8"))) {
    throw new Error("SKILL_PACKAGE_INVALID: ZIP local and central entry paths do not match.");
  }
  const start = entry.offset + 30 + nameLength + extraLength;
  const end = start + entry.compressed;
  if (end > centralOffset || end < start) throw new Error("SKILL_PACKAGE_INVALID: ZIP entry data is truncated.");
  const compressed = buffer.subarray(start, end);
  if (entry.method === 0) return Buffer.from(compressed);
  try {
    return inflateRawSync(compressed, { maxOutputLength: Math.min(entry.expanded + 1, BRIDGE_SKILL_PACKAGE_LIMITS.fileMaxBytes + 1) });
  } catch {
    throw new Error("SKILL_PACKAGE_CORRUPT: ZIP entry decompression failed.");
  }
}

type StreamingZipEntry = {
  originalPath: string;
  path: string;
  method: number;
  flags: number;
  crc: number;
  compressed: number;
  expanded: number;
  offset: number;
};

async function extractEntryFromFile(
  handle: FileHandle,
  entry: StreamingZipEntry,
  centralOffset: number
): Promise<Buffer> {
  const local = await readExactly(handle, entry.offset, 30);
  if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(8) !== entry.method) {
    throw new Error("SKILL_PACKAGE_INVALID: ZIP local entry is invalid.");
  }
  const localFlags = local.readUInt16LE(6);
  if ((localFlags & 0x0809) !== (entry.flags & 0x0809)) {
    throw new Error("SKILL_PACKAGE_INVALID: ZIP local and central entry flags do not match.");
  }
  const nameLength = local.readUInt16LE(26);
  const extraLength = local.readUInt16LE(28);
  const localName = await readExactly(handle, entry.offset + 30, nameLength);
  const centralName = Buffer.from(entry.originalPath, "utf8");
  if (!localName.equals(centralName)) {
    throw new Error("SKILL_PACKAGE_INVALID: ZIP local and central entry paths do not match.");
  }
  const start = entry.offset + 30 + nameLength + extraLength;
  const end = start + entry.compressed;
  if (start < 0 || end > centralOffset || end < start) {
    throw new Error("SKILL_PACKAGE_INVALID: ZIP entry data is truncated or overlaps its central directory.");
  }

  const chunks: Buffer[] = [];
  let expanded = 0;
  const append = (chunk: Uint8Array): void => {
    expanded += chunk.byteLength;
    if (expanded > entry.expanded || expanded > BRIDGE_SKILL_PACKAGE_LIMITS.fileMaxBytes) {
      throw new Error("SKILL_PACKAGE_BOMB: A ZIP entry exceeds its declared or permitted expanded size.");
    }
    chunks.push(Buffer.from(chunk));
  };
  try {
    if (entry.method === 0) {
      for await (const chunk of readRangeChunks(handle, start, entry.compressed)) append(chunk);
    } else {
      const inflater = createInflateRaw();
      Readable.from(readRangeChunks(handle, start, entry.compressed)).pipe(inflater);
      for await (const chunk of inflater) append(chunk as Buffer);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("SKILL_PACKAGE_BOMB:")) throw error;
    throw new Error("SKILL_PACKAGE_CORRUPT: ZIP entry decompression failed.", { cause: error });
  }
  return Buffer.concat(chunks, expanded);
}

async function readExactly(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || position < 0 || length < 0) {
    throw new Error("SKILL_PACKAGE_INVALID: ZIP contains an invalid byte range.");
  }
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(bytes, offset, length - offset, position + offset);
    if (result.bytesRead === 0) throw new Error("SKILL_PACKAGE_INVALID: ZIP data is truncated.");
    offset += result.bytesRead;
  }
  return bytes;
}

async function* readRangeChunks(
  handle: FileHandle,
  position: number,
  length: number
): AsyncGenerator<Buffer> {
  const chunkSize = 64 * 1_024;
  let consumed = 0;
  while (consumed < length) {
    const size = Math.min(chunkSize, length - consumed);
    yield await readExactly(handle, position + consumed, size);
    consumed += size;
  }
}

function assertEntryExpansionLimits(entry: { compressed: number; expanded: number }): void {
  if (entry.expanded > BRIDGE_SKILL_PACKAGE_LIMITS.fileMaxBytes ||
    (entry.compressed === 0 ? entry.expanded > 0 : entry.expanded / entry.compressed > BRIDGE_SKILL_PACKAGE_LIMITS.compressionRatioMax)) {
    throw new Error("SKILL_PACKAGE_BOMB: A ZIP entry exceeds its expanded-size or compression-ratio limit.");
  }
}

function commonWrapper(paths: string[]): string | null {
  if (paths.length === 0) return null;
  const segments = paths.map((value) => value.replaceAll("\\", "/").split("/"));
  const first = segments[0]?.[0];
  return first && segments.every((parts) => parts.length > 1 && parts[0] === first) ? first : null;
}

function stripCommonPackageWrapper<Entry extends { path: string }>(entries: Entry[]): string | null {
  // Finder/ditto packages commonly add a parallel __MACOSX tree. It is not
  // package content and must not prevent the real skill folder from being
  // recognized as a removable wrapper directory.
  const contentEntries = entries.filter((entry) => !isMacMetadata(entry.path));
  const wrapper = commonWrapper(contentEntries.map((entry) => entry.path));
  if (!wrapper) return null;
  const prefix = `${wrapper}/`;
  for (const entry of contentEntries) entry.path = entry.path.slice(prefix.length);
  return wrapper;
}

function normalizePackagePath(value: string): string {
  const source = normalizeArchiveEntryPath(value);
  if (!/\.(?:md|markdown)$/iu.test(source)) throw new Error("SKILL_PACKAGE_FILE_UNSUPPORTED: Main selection must be Markdown.");
  return source;
}

function suggestedSkillMetadata(
  files: readonly BridgeSkillPackageFile[],
  suggestedMainPath: string | null
): { name?: string; description?: string } {
  if (suggestedMainPath !== "SKILL.md") return {};
  const source = files.find((file) => file.path === "SKILL.md")?.content;
  if (source === undefined) return {};
  return parseSkillFrontmatter(source);
}

function parseSkillFrontmatter(source: string): { name?: string; description?: string } {
  const text = source.startsWith("\ufeff") ? source.slice(1) : source;
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  if (lines[0]?.trim() !== "---") return {};
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closing < 0) return {};
  let name: string | undefined;
  let description: string | undefined;
  for (const line of lines.slice(1, closing)) {
    if (/^\s/u.test(line)) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = yamlScalar(line.slice(separator + 1));
    if (key === "name") name = normalizedMetadataSuggestion(value, 120);
    if (key === "description") description = normalizedMetadataSuggestion(value, 2_000);
  }
  return {
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description })
  };
}

function yamlScalar(source: string): string {
  const value = source.trim();
  if (value.length < 2) return value;
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") return parsed;
    } catch { /* Fall back to the verbatim scalar. */ }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
}

function normalizedMetadataSuggestion(source: string, maxCharacters: number): string | undefined {
  const normalized = source.replace(/\s+/gu, " ").trim();
  if (!normalized || [...normalized].length > maxCharacters || /[\u0000-\u001f\u007f]/u.test(normalized)) return undefined;
  return normalized;
}

function normalizeArchiveEntryPath(value: string, directory = false): string {
  let exact: string;
  try {
    exact = verbatimText(value, {
      field: "ZIP entry path",
      allowEmpty: true,
      maxUtf8Bytes: BRIDGE_SKILL_PACKAGE_LIMITS.pathMaxBytes,
      rejectNul: true
    });
  } catch (error) {
    throw new Error("SKILL_PACKAGE_PATH_INVALID: ZIP contains an invalid UTF-8 path.", { cause: error });
  }
  // ZIP producers may use a Windows separator. Converting only the separator
  // is transport syntax handling; Unicode spelling remains byte-for-byte.
  const normalized = exact.replaceAll("\\", "/");
  const source = directory && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  const segments = source.split("/");
  if (!source || source.startsWith("/") || /^[A-Za-z]:/u.test(source) || source.includes("\u0000") ||
    segments.some((segment) => !segment || segment === "." || segment === ".." || /[\u0000-\u001f\u007f]/u.test(segment)) ||
    segments.length > BRIDGE_SKILL_PACKAGE_LIMITS.pathMaxDepth || utf8ByteLength(source, "ZIP entry path") > BRIDGE_SKILL_PACKAGE_LIMITS.pathMaxBytes) {
    throw new Error("SKILL_PACKAGE_PATH_INVALID: ZIP contains an unsafe, empty, deep, or overlong path.");
  }
  return source;
}

function packagePathCollisionKey(value: string): string {
  return searchKey(value, {
    field: "ZIP entry path comparison key",
    allowEmpty: true,
    collapseWhitespace: false,
    trim: false,
    rejectControlCharacters: false
  });
}

function normalizeExportPath(value: string): string {
  const normalized = normalizePackagePath(value);
  return normalized;
}

function encodePackageText(value: string, filePath: string): Buffer {
  try {
    const exact = verbatimText(value, {
      field: `Bridge skill package file ${filePath}`,
      allowEmpty: true,
      maxUtf8Bytes: BRIDGE_SKILL_PACKAGE_LIMITS.fileMaxBytes,
      rejectNul: true
    });
    return Buffer.from(exact, "utf8");
  } catch (error) {
    throw new Error(
      `SKILL_PACKAGE_TEXT_INVALID: ${filePath} must be well-formed UTF-8 text within the file limit.`,
      { cause: error }
    );
  }
}

function isMacMetadata(value: string): boolean {
  return value.startsWith("__MACOSX/") || value.split("/").some((part) => (
    part === ".DS_Store" || part.startsWith("._")
  ));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const CRC_TABLE = new Uint32Array(256).map((_value, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
