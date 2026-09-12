import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import type { RuntimeInstaller } from "./codexRuntime.js";

const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024;

/** HTTPS + exact publisher metadata + integrity check, with no npm scripts or global install. */
export const installManagedCli: RuntimeInstaller = async ({ directory, version, onProgress }) => {
  const platform = process.platform, arch = process.arch;
  if (!["darwin", "linux", "win32"].includes(platform) || !["arm64", "x64"].includes(arch)) {
    throw new Error("CODEX_PLATFORM_UNSUPPORTED");
  }
  const metadata = await registryMetadata(`${version}-${platform}-${arch}`);
  if (metadata.name !== "@openai/codex" || metadata.version !== `${version}-${platform}-${arch}`) throw new Error("CODEX_PACKAGE_MISMATCH");
  const url = new URL(metadata.dist.tarball);
  if (url.protocol !== "https:" || url.hostname !== "registry.npmjs.org" || !url.pathname.startsWith("/@openai/codex/-/")) throw new Error("CODEX_DOWNLOAD_SOURCE_INVALID");
  const match = /^sha512-([A-Za-z0-9+/]+=*)$/.exec(metadata.dist.integrity);
  if (!match) throw new Error("CODEX_INTEGRITY_MISSING");
  const archive = path.join(directory, "download.tgz");
  await downloadVerified(url.href, archive, "sha512", match[1], "base64", async (bytes, total) => onProgress("downloading", bytes, total));
  await onProgress("installing");
  await extractVerifiedArchive(archive, directory, false);
  await rm(archive);
  const target = `${arch === "arm64" ? "aarch64" : "x86_64"}-${platform === "darwin" ? "apple-darwin" : platform === "win32" ? "pc-windows-msvc" : "unknown-linux-musl"}`;
  const command = path.join(directory, "package", "vendor", target, "bin", platform === "win32" ? "codex.exe" : "codex");
  await chmod(command, 0o700);
  await onProgress("verifying");
  return command;
};

async function registryMetadata(version: string): Promise<{ name: string; version: string; dist: { tarball: string; integrity: string } }> {
  const response = await fetch(`https://registry.npmjs.org/@openai/codex/${encodeURIComponent(version)}`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error("CODEX_PACKAGE_UNAVAILABLE");
  return await response.json() as Awaited<ReturnType<typeof registryMetadata>>;
}

export async function downloadVerified(
  url: string, file: string, algorithm: "sha256" | "sha512", digest: string, encoding: "hex" | "base64" = "hex",
  progress?: (bytes: number, total?: number) => Promise<void>
): Promise<void> {
  if (new URL(url).protocol !== "https:") throw new Error("RUNTIME_DOWNLOAD_REQUIRES_HTTPS");
  const response = await fetch(url, { signal: AbortSignal.timeout(5 * 60_000) });
  if (!response.ok || !response.body || new URL(response.url).protocol !== "https:") throw new Error("RUNTIME_DOWNLOAD_FAILED");
  const total = Number(response.headers.get("content-length")) || undefined;
  if (total && total > MAX_ARCHIVE_BYTES) throw new Error("RUNTIME_DOWNLOAD_TOO_LARGE");
  const chunks: Uint8Array[] = [];
  let bytes = 0, lastReport = 0;
  const hash = createHash(algorithm);
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > MAX_ARCHIVE_BYTES) throw new Error("RUNTIME_DOWNLOAD_TOO_LARGE");
    hash.update(chunk); chunks.push(chunk);
    if (Date.now() - lastReport >= 250) { await progress?.(bytes, total); lastReport = Date.now(); }
  }
  if (hash.digest(encoding) !== digest) throw new Error("RUNTIME_INTEGRITY_MISMATCH");
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, Buffer.concat(chunks), { mode: 0o600, flag: "wx" });
  await progress?.(bytes, total);
}

/** Validate every entry before extracting anything. Python archives may contain internal links. */
export async function extractVerifiedArchive(archive: string, directory: string, allowInternalLinks: boolean): Promise<void> {
  let expanded = 0;
  const names = new Set<string>();
  const links = new Set<string>();
  let invalid: Error | undefined;
  await tar.t({ file: archive, strict: true, onReadEntry(entry) {
    if (invalid) return;
    try {
    const name = entry.path.replace(/\\/g, "/");
    const normalized = path.posix.normalize(name).replace(/\/$/, "");
    if (path.posix.isAbsolute(name) || /^[a-zA-Z]:/.test(name) || name.split("/").includes("..") || normalized === "." || normalized.startsWith("..")) throw new Error("RUNTIME_ARCHIVE_PATH_INVALID");
    if (names.has(normalized)) throw new Error("RUNTIME_ARCHIVE_DUPLICATE_PATH");
    names.add(normalized);
    if (["SymbolicLink", "Link"].includes(entry.type)) {
      if (!allowInternalLinks) throw new Error("RUNTIME_ARCHIVE_LINK_INVALID");
      const target = (entry.linkpath || "").replace(/\\/g, "/");
      const resolved = path.posix.normalize(path.posix.join(entry.type === "Link" ? "" : path.posix.dirname(name), target));
      if (path.posix.isAbsolute(target) || /^[a-zA-Z]:/.test(target) || resolved === ".." || resolved.startsWith("../")) throw new Error("RUNTIME_ARCHIVE_LINK_INVALID");
      links.add(normalized);
    } else if (!["File", "OldFile", "Directory"].includes(entry.type)) throw new Error("RUNTIME_ARCHIVE_ENTRY_INVALID");
    expanded += entry.size;
    if (expanded > MAX_EXPANDED_BYTES || names.size > 50_000) throw new Error("RUNTIME_ARCHIVE_TOO_LARGE");
    } catch (error) { invalid = error instanceof Error ? error : new Error("RUNTIME_ARCHIVE_INVALID"); }
  } });
  if (invalid) throw invalid;
  for (const name of names) {
    let parent = path.posix.dirname(name);
    while (parent !== ".") {
      if (links.has(parent)) throw new Error("RUNTIME_ARCHIVE_LINK_TRAVERSAL");
      parent = path.posix.dirname(parent);
    }
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await tar.x({ file: archive, cwd: directory, strict: true, preservePaths: false, noChmod: true });
}
