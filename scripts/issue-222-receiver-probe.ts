// Test-only evidence scoring. No host API, credentials, polling or Job admission.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

export const BASELINE_SHA = "30919ee1e1b9461216db289a5a69876079efb92e";
export const fixture = JSON.parse(readFileSync(new URL("./fixtures/issue-222-receiver.json", import.meta.url), "utf8")) as {
  version: number; a: { phase: string; marker: string; value: number };
  b: { phase: string; marker: string; value: number }; bPrompt: string;
};
export const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const fixtureDigest = digest(fixture);
const label = z.string().regex(/^[a-zA-Z0-9._/-]{1,100}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const provenance = z.enum(["synthetic-upstream", "local-browser", "actual-chatgpt"]);
const kind = z.enum([
  "hold-started", "departure-observed", "release", "terminal", "subscribe", "signal",
  "completion-observed", "model-wake", "chat-bound", "result-read", "result-reviewed",
  "b-approved", "b-admitted", "b-executed", "model-continuity", "usage-continuity",
  "webhook-ack", "ui-mounted", "tool-call", "result-offered"
]);
const evidenceSchema = z.object({
  runId: label, seq: z.number().int().positive(), atMs: z.number().int().nonnegative(),
  kind, provenance, source: label, jobRef: label,
  scopeMatches: z.boolean().optional(), chatMatches: z.boolean().optional(),
  automatic: z.boolean().optional(), success: z.boolean().optional(),
  terminalVersion: z.number().int().positive().optional(),
  eventId: label.optional(), replay: z.boolean().optional(),
  resultDigest: hash.optional(), promptDigest: hash.optional()
}).strict();
const runSchema = z.object({
  runId: label, baselineSha: z.literal(BASELINE_SHA), fixtureDigest: z.literal(fixtureDigest),
  startedAtMs: z.number().int().nonnegative(), endedAtMs: z.number().int().nonnegative(),
  observation: provenance, route: z.enum(["direct-wait", "live-card", "events"]),
  aJobRef: label, bJobRef: label, records: z.array(evidenceSchema).max(1000)
}).strict();
export type Evidence = z.infer<typeof evidenceSchema>;
export type Run = z.infer<typeof runSchema>;
export type RunContext = Omit<Run, "records">;
export type Status = "pass" | "fail" | "unknown";
type Verdict = { status: Status; evidence: number[]; provenance: Run["observation"]; reason: string };

/** Same started/result/release promise barrier pattern as test/tools.test.ts.
 * Only controls fixture completion. It cannot observe navigation or create host evidence.
 * Missing departure leaves the fixture held; no timer releases it.
 */
export function holdFixture(
  run: Pick<Run, "runId" | "aJobRef" | "startedAtMs" | "observation">,
  control: (kind: "hold-started" | "release") => Evidence
) {
  let startedResolve!: () => void;
  let resultResolve!: (value: typeof fixture.a) => void;
  const started = new Promise<void>(r => { startedResolve = r; });
  const result = new Promise<typeof fixture.a>(r => { resultResolve = r; });
  let start: Evidence | undefined;
  let released = false;
  return {
    started,
    async call() {
      if (start) throw new Error("Fixture already started");
      start = control("hold-started");
      startedResolve();
      return result;
    },
    release(observation: unknown) {
      const parsed = evidenceSchema.safeParse(observation);
      if (!start || released || !parsed.success) throw new Error("Departure evidence required while held");
      const e = parsed.data;
      if (e.kind !== "departure-observed" || e.provenance !== run.observation || e.runId !== run.runId ||
          e.jobRef !== run.aJobRef || e.atMs < run.startedAtMs || e.atMs < start.atMs || e.seq <= start.seq || e.success !== true) {
        throw new Error("Departure evidence does not match the held run");
      }
      const release = control("release");
      if (release.seq <= e.seq || release.atMs < e.atMs) throw new Error("Release precedes departure evidence");
      released = true;
      resultResolve(fixture.a);
    }
  };
}

export function evaluate(expected: RunContext, input: unknown) {
  const parsed = runSchema.safeParse(input);
  const empty = (p: Run["observation"], reason: string, status: Status = "unknown"): Verdict => ({ status, evidence: [], provenance: p, reason });
  // This scorer consumes assertions, not authenticated browser telemetry. It never
  // grants product/host acceptance, even if a supplied file claims actual-chatgpt.
  const boundary = { scope: "test-only-evidence-scoring", actualHostAcceptance: "unknown", execution: "synthetic-upstream" } as const;
  if (!parsed.success) return { ...boundary, validity: "invalid", reasons: ["Invalid or stale run/fixture schema"],
    capabilities: Object.fromEntries(["Observe", "Wake", "BindChat", "BindAuthority"].map(k => [k, empty("synthetic-upstream", "Invalid input")])),
    followup: { status: "unknown", reason: "Invalid input" }, modelContinuity: "unknown", usageContinuity: "unknown",
    counts: { signalRecords: null, uniqueSignals: null, bAdmissions: null, bExecutions: null, reviewRecords: null } };
  const run = parsed.data;
  const reasons: string[] = [];
  const context = runSchema.omit({ records: true }).safeParse(expected);
  if (!context.success || Object.keys(context.data).some(k =>
    context.data[k as keyof RunContext] !== run[k as keyof RunContext])) {
    reasons.push("Evidence does not match independently selected run context");
  }
  const r = run.records;
  const find = (k: Evidence["kind"]) => r.filter(e => e.kind === k);
  const one = (k: Evidence["kind"]) => find(k).length === 1 ? find(k)[0] : undefined;
  const controls = ["hold-started", "release", "terminal", "b-admitted", "b-executed"];
  const observation = (k: Evidence["kind"]) => find(k).filter(e => e.provenance === run.observation && e.jobRef === run.aJobRef);
  if (run.endedAtMs < run.startedAtMs || run.aJobRef === run.bJobRef) reasons.push("Invalid run window or Job identity");
  for (const [i, e] of r.entries()) {
    if (e.runId !== run.runId || e.atMs < run.startedAtMs || e.atMs > run.endedAtMs) reasons.push("Old or out-of-window evidence");
    if (i && (e.seq <= r[i - 1]!.seq || e.atMs < r[i - 1]!.atMs)) reasons.push("Contradictory sequence or timestamp");
    const b = ["b-approved", "b-admitted", "b-executed"].includes(e.kind);
    if (e.jobRef !== (b ? run.bJobRef : run.aJobRef)) reasons.push("Wrong exact Job");
    if (controls.includes(e.kind) && e.provenance !== "synthetic-upstream") reasons.push("Fixture control mislabeled as host observation");
  }
  const start = one("hold-started"), departed = one("departure-observed"), release = one("release"), terminal = one("terminal");
  const lifecycle = [start, departed, release, terminal];
  if (lifecycle.some(e => !e)) reasons.push("Missing or duplicate lifecycle record");
  else if (!(start!.seq < departed!.seq && departed!.seq < release!.seq && release!.seq < terminal!.seq)) reasons.push("Completion before controlled departure");
  if (departed && (departed.provenance !== run.observation || departed.success !== true)) reasons.push("Departure was not observed on the requested surface");
  if (terminal && (terminal.resultDigest !== digest(fixture.a) || terminal.success !== true || !terminal.terminalVersion)) reasons.push("Terminal fixture result/version missing or mismatched");
  const signals = find("signal"), subscription = one("subscribe");
  if (run.route === "events") {
    if (!signals.length) reasons.push("Missing event signal observation");
    if (!subscription || subscription.success !== true || subscription.provenance !== run.observation) reasons.push("Missing exact subscription observation");
    for (const e of signals) {
      if (!e.eventId || !terminal || !subscription || e.seq <= subscription.seq || e.seq <= terminal.seq ||
          e.terminalVersion !== terminal.terminalVersion || (terminal.seq < subscription.seq && e.replay !== true)) {
        reasons.push("Unverified event/subscription ordering or retained replay");
      }
    }
  }
  if (signals.some(e => !terminal || e.seq <= terminal.seq || e.terminalVersion !== terminal.terminalVersion)) reasons.push("Signal precedes or mismatches terminal");
  const evidence = (k: Evidence["kind"]) => observation(k).filter(e => e.success === true && terminal && e.seq > terminal.seq);
  const reads = evidence("result-read");
  const exactReads = reads.filter(e => e.scopeMatches === true && e.resultDigest === digest(fixture.a) && e.terminalVersion === terminal!.terminalVersion);
  const reviews = evidence("result-reviewed").filter(e => exactReads.some(read => read.seq < e.seq) && e.resultDigest === digest(fixture.a) && e.terminalVersion === terminal!.terminalVersion);
  const proof = (k: Evidence["kind"], records: Evidence[], reason: string): Verdict => ({
    status: observation(k).some(e => e.success === false) ? "fail" : records.length ? "pass" : "unknown",
    evidence: records.map(e => e.seq), provenance: run.observation, reason
  });
  const capabilities = {
    Observe: proof("completion-observed", evidence("completion-observed").filter(e => e.terminalVersion === terminal!.terminalVersion), "Explicit completion observation; ACK/offer/mount are insufficient"),
    Wake: proof("model-wake", evidence("model-wake").filter(e => e.automatic === true), "Explicit new automatic model run; active-turn waits are insufficient"),
    BindChat: proof("chat-bound", evidence("chat-bound").filter(e => e.chatMatches === true), "Explicit original Chat route observation"),
    BindAuthority: proof("result-read", exactReads, "Exact result digest/version and original scope read; offer is insufficient")
  };
  if (reads.some(e => e.scopeMatches === false || e.resultDigest !== digest(fixture.a) || e.terminalVersion !== terminal!.terminalVersion)) {
    capabilities.BindAuthority.status = "fail";
    capabilities.BindAuthority.reason = "Original scope or exact result mismatch";
  }
  if (evidence("chat-bound").some(e => e.chatMatches === false)) capabilities.BindChat.status = "fail";
  const approvals = find("b-approved").filter(e => e.success === true && e.provenance === run.observation && start && e.seq < start.seq && e.promptDigest === digest(fixture.bPrompt));
  const admissions = find("b-admitted"), executions = find("b-executed");
  const eligibleB = Boolean(approvals.length === 1 && reviews.length && capabilities.BindAuthority.status === "pass" && capabilities.BindChat.status === "pass");
  const bChecks = (e: Evidence) => e.success === true && e.scopeMatches === true && e.promptDigest === digest(fixture.bPrompt) && reviews.some(review => review.seq < e.seq);
  let followup: { status: Status; reason: string } = { status: "unknown", reason: "No B performed; exact preapproval and original A read/review required" };
  if (admissions.length || executions.length) {
    followup = { status: eligibleB && admissions.length === 1 && executions.length === 1 && admissions.every(bChecks) &&
      executions.every(bChecks) && executions[0]!.seq > admissions[0]!.seq && executions[0]!.resultDigest === digest(fixture.b) ? "pass" : "fail",
      reason: "Fixture B only; one admission and execution after original A review" };
  }
  if (reasons.length) {
    for (const verdict of Object.values(capabilities)) { verdict.status = "unknown"; verdict.reason = "Invalid trial; evidence cannot establish a pass"; }
    followup = { status: "unknown", reason: "Invalid trial" };
  }
  return { ...boundary, validity: reasons.length ? "invalid" : "valid", reasons: [...new Set(reasons)],
    observation: run.observation, capabilities, followup,
    modelContinuity: "unknown", usageContinuity: "unknown",
    counts: { signalRecords: signals.length, uniqueSignals: new Set(signals.flatMap(e => e.eventId ? [e.eventId] : [])).size,
      bAdmissions: admissions.length, bExecutions: executions.length, reviewRecords: reviews.length },
    fixtureDigest, baselineSha: BASELINE_SHA };
}

/** Explicit synthetic demonstration, never browser/ChatGPT acceptance. */
export async function localDemo() {
  let seq = 0, atMs = 0;
  const run: Run = { runId: `local-${randomUUID()}`, baselineSha: BASELINE_SHA, fixtureDigest,
    startedAtMs: 0, endedAtMs: 100, observation: "synthetic-upstream", route: "direct-wait",
    aJobRef: "fixture-job-a", bJobRef: "fixture-job-b", records: [] };
  const record = (k: Evidence["kind"], extra: Partial<Evidence> = {}) => {
    const e: Evidence = { runId: run.runId, seq: ++seq, atMs: ++atMs, kind: k,
      provenance: "synthetic-upstream", source: "explicit-local-demo", jobRef: run.aJobRef, success: true, ...extra };
    run.records.push(e); return e;
  };
  const held = holdFixture(run, k => record(k));
  const result = held.call();
  await held.started;
  // Separate, explicit synthetic observation. No automatic navigation assumption.
  const departure = record("departure-observed");
  held.release(departure);
  const a = await result;
  record("terminal", { resultDigest: digest(a), terminalVersion: 1 });
  record("completion-observed", { terminalVersion: 1 });
  record("chat-bound", { chatMatches: true });
  record("result-read", { scopeMatches: true, resultDigest: digest(a), terminalVersion: 1 });
  const { records: _records, ...context } = run;
  return { context, run, report: evaluate(context, run) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, manifest, input, ...rest] = process.argv.slice(2);
    if (rest.length || (command === "--local-demo" && (manifest || input))) throw new Error("Usage");
    if (command === "--local-demo") console.log(JSON.stringify(await localDemo(), null, 2));
    else if (command === "--score" && manifest && input) console.log(JSON.stringify(evaluate(
      JSON.parse(readFileSync(manifest, "utf8")), JSON.parse(readFileSync(input, "utf8"))), null, 2));
    else throw new Error("Usage");
  } catch {
    console.error("Probe failed. Usage: tsx scripts/issue-222-receiver-probe.ts --local-demo | --score <context.json> <sanitized-run.json>");
    process.exitCode = 1;
  }
}
