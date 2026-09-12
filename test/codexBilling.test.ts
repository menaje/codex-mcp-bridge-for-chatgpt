import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CodexBilling } from "../src/codexBilling.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const now = Date.UTC(2026, 8, 5), start = Date.UTC(2026, 8, 1) / 1000;
async function fixture(request = vi.fn<typeof fetch>()) {
  const root = await mkdtemp(path.join(tmpdir(), "codex-billing-test-")); roots.push(root);
  return { root, request, billing: new CodexBilling(root, request, () => now) };
}
const config = { adminKey: "sk-admin-test-only", organizationId: "org-test", projectId: "proj_test" };
const response = (value: number | null, hasMore = false, page?: string) => new Response(JSON.stringify({ has_more: hasMore, next_page: page || null,
  data: [{ start_time: start, end_time: start + 86400, results: [{ amount: { value, currency: "usd" } }] }] }));

it("does not use an inference key or make a request when the billing connection is absent", async () => {
  const f = await fixture(); expect(await f.billing.snapshot()).toMatchObject({ configured: false, status: "not-configured", usd: null });
  expect(f.request).not.toHaveBeenCalled();
});

it("uses a separate admin connection and paginates UTC-month costs scoped to the configured organization/project", async () => {
  const f = await fixture(vi.fn<typeof fetch>().mockResolvedValueOnce(response(2, true, "next")).mockResolvedValueOnce(response(3)));
  await f.billing.configure(config);
  expect(await f.billing.configuration()).toMatchObject({ configured: true, organizationId: "org-test" });
  expect(f.request).not.toHaveBeenCalled();
  const snapshot = await f.billing.snapshot();
  expect(snapshot).toMatchObject({ configured: true, status: "available", usd: 5, startTime: start, endTime: now / 1000, organizationId: "org-test", projectId: "proj_test" });
  expect(f.request).toHaveBeenCalledTimes(2);
  for (const [url, init] of f.request.mock.calls) {
    expect(new URL(String(url)).origin).toBe("https://api.openai.com");
    expect(new URL(String(url)).searchParams.get("project_ids[]")).toBe("proj_test");
    expect(init?.headers).toEqual({ Authorization: "Bearer sk-admin-test-only", "OpenAI-Organization": "org-test" });
    expect(init?.redirect).toBe("error");
  }
  expect((await stat(f.billing.file)).mode & 0o777).toBe(0o600);
  expect(JSON.stringify(snapshot)).not.toContain(config.adminKey);
  await f.billing.snapshot(); expect(f.request).toHaveBeenCalledTimes(2);
});

it("reports unavailable instead of zero on permission errors or unknown amounts, without exposing the raw response", async () => {
  const f = await fixture(vi.fn<typeof fetch>().mockResolvedValue(new Response("private secret account payload", { status: 403 })));
  await f.billing.configure(config);
  const snapshot = await f.billing.snapshot();
  expect(snapshot).toMatchObject({ status: "unavailable", usd: null }); expect(JSON.stringify(snapshot)).not.toContain("private");
  const unknown = await fixture(vi.fn<typeof fetch>().mockResolvedValue(response(null))); await unknown.billing.configure(config);
  expect(await unknown.billing.snapshot()).toMatchObject({ status: "unavailable", usd: null });
});

it("distinguishes a verified zero from missing costs and removes only the separate billing credentials", async () => {
  const f = await fixture(vi.fn<typeof fetch>().mockResolvedValue(response(0)));
  const execution = path.join(f.root, "auth.json"); await writeFile(execution, "execution login preserved");
  await f.billing.configure(config); expect(await f.billing.snapshot()).toMatchObject({ status: "available", usd: 0 });
  await f.billing.remove(); expect(await f.billing.snapshot()).toMatchObject({ configured: false, usd: null });
  expect(await readFile(execution, "utf8")).toBe("execution login preserved");
  await expect(readFile(f.billing.file)).rejects.toMatchObject({ code: "ENOENT" });
});

it("discards an old organization's in-flight response after disconnect", async () => {
  let finish!: (value: Response) => void;
  const f = await fixture(vi.fn<typeof fetch>().mockImplementation(() => new Promise(resolve => { finish = resolve; })));
  await f.billing.configure(config); const pending = f.billing.snapshot();
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  await f.billing.remove(); finish(response(999));
  expect(await pending).toMatchObject({ status: "not-configured", usd: null });
});
