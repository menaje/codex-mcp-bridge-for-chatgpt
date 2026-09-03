export async function probeHttpHealth(
  url,
  {
    timeoutMs = 5_000,
    fetchImpl = globalThis.fetch
  } = {}
) {
  if (typeof fetchImpl !== "function") throw new Error("Node.js fetch support is required.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new Error("HTTP health timeout must be an integer from 1 to 60000 milliseconds.");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: { accept: "application/json" }
    });
    await response.body?.cancel().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
