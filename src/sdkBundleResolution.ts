import { z } from "zod";

const wheelSchema = z.object({
  metadata: z.object({ name: z.string().regex(/^[a-zA-Z0-9._-]+$/), version: z.string().regex(/^[a-zA-Z0-9.!+_-]+$/),
    requires_dist: z.array(z.string()).optional() }),
  download_info: z.object({ url: z.url(), archive_info: z.object({ hashes: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }) }) })
});

/** Only binary wheels from the publisher's registry; freeze the entire resolver result with hashes. */
export function projectSdkResolution(report: unknown, version: string): { packages: Record<string, string>; requirements: string; codexRuntime: string } {
  const { install } = z.object({ install: z.array(wheelSchema).min(2).max(100) }).parse(report);
  const packages: Record<string, string> = {}, lines: string[] = [];
  for (const wheel of install) {
    const url = new URL(wheel.download_info.url), name = wheel.metadata.name.toLowerCase().replace(/[-_.]+/g, "-");
    if (url.protocol !== "https:" || url.hostname !== "files.pythonhosted.org" || !url.pathname.endsWith(".whl") || packages[name]) throw new Error("SDK_RESOLUTION_UNTRUSTED");
    packages[name] = wheel.metadata.version;
    lines.push(`${name}==${wheel.metadata.version} --hash=sha256:${wheel.download_info.archive_info.hashes.sha256}`);
  }
  const sdk = install.find(item => item.metadata.name.toLowerCase().replace(/[-_.]+/g, "-") === "openai-codex");
  const requiredCli = sdk?.metadata.requires_dist?.map(value => /^openai[-_]codex[-_]cli[-_]bin\s*==\s*(\d+\.\d+\.\d+)\s*$/i.exec(value)?.[1]).find(Boolean);
  if (packages["openai-codex"] !== version || !requiredCli || packages["openai-codex-cli-bin"] !== requiredCli) throw new Error("SDK_RUNTIME_DEPENDENCY_MISMATCH");
  return { packages, codexRuntime: requiredCli, requirements: lines.sort().join("\n") + "\n" };
}
