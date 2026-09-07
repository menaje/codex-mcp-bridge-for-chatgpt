import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { CodexAppServerUpstreamPool } from "../src/appServerUpstream.js";
import type { UpstreamWorkerAssignment } from "../src/upstream.js";

// Explicitly opt-in: sends small synthetic turns using an existing ChatGPT
// login. Never falls back to an API key, logs credentials, or reads a project.
if (!process.argv.includes("--run-authenticated")) {
    throw new Error("Pass --run-authenticated and one or more absolute CLI paths to run this live check.");
}
const commands = process.argv.slice(2).filter(argument => argument !== "--run-authenticated");
if (!commands.length || commands.some(command => !path.isAbsolute(command))) throw new Error("Absolute CLI paths are required.");
const authFile = path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "auth.json");
const auth = JSON.parse(await readFile(authFile, "utf8"));
if (auth.auth_mode !== "chatgpt" || typeof auth.tokens?.access_token !== "string") {
    throw new Error("An existing ChatGPT file login is required; no credentials were changed.");
}

for (const command of commands) {
    const directory = await mkdtemp(path.join(tmpdir(), "bridge-live-app-server-"));
    const codexHome = path.join(directory, "codex");
    const project = path.join(directory, "synthetic-project");
    const environment = { ...process.env, CODEX_HOME: codexHome, OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined };
    let pool = new CodexAppServerUpstreamPool(command, 1, { environment });
    const deadline = setTimeout(() => { void pool.close().catch(() => undefined); }, 180_000);
    const report: Record<string, unknown> = { stages: [] };
    const stages = report.stages as string[];
    try {
        await mkdir(codexHome, { mode: 0o700 }); await mkdir(project);
        await copyFile(authFile, path.join(codexHome, "auth.json"));
        await chmod(path.join(codexHome, "auth.json"), 0o600);
        await writeFile(path.join(codexHome, "config.toml"), 'cli_auth_credentials_store = "file"\nmodel_reasoning_effort = "low"\n');
        report.version = execFileSync(command, ["--version"], { encoding: "utf8", timeout: 5_000, maxBuffer: 4096 }).trim();
        const account = await pool.readAccountSnapshot();
        assert.equal(account?.authMode, "chatgpt"); assert.equal(account.authenticated, true);
        stages.push("chatgpt-authentication");
        const models = await pool.listModels() as { data: { model: string; isDefault?: boolean }[] };
        assert.ok(models.data.length > 0); stages.push("model-catalog");
        const args = { cwd: project, sandbox: "read-only", "approval-policy": "never",
            config: { model_reasoning_effort: "low" } };
        const first = await pool.callTool("codex", { ...args,
            prompt: "This is a synthetic integration test. Do not call tools. Remember the word APRICOT. Reply with exactly LIVE_START_OK." });
        assert.equal(first.structuredContent?.turnStatus, "completed");
        assert.match(JSON.stringify(first.content), /LIVE_START_OK/); stages.push("new-turn");
        const threadId = first.structuredContent?.threadId;
        assert.equal(typeof threadId, "string");
        await pool.close();
        pool = new CodexAppServerUpstreamPool(command, 1, { environment });
        const next = await pool.callTool("codex-reply", { ...args, threadId,
            prompt: "Do not call tools. Reply with only the word I asked you to remember in the previous turn." });
        assert.equal(next.structuredContent?.threadId, threadId);
        assert.equal(next.structuredContent?.turnStatus, "completed");
        assert.match(JSON.stringify(next.content), /APRICOT/); stages.push("process-restart-and-durable-continuation");
        let onAssigned!: (assignment: UpstreamWorkerAssignment) => void;
        const assigned = new Promise<UpstreamWorkerAssignment>(resolve => { onAssigned = resolve; });
        const running = pool.callTool("codex-reply", { ...args, threadId,
            prompt: "This is a cancellation integration test. Do not read or write any files. Run sleep 20, then reply LIVE_CONTROL_DONE." },
            undefined, assignment => { if (assignment.upstreamRequestId) onAssigned(assignment); });
        // Observe the turn request before issuing either control; an admission
        // failure must reject the check instead of waiting on an assignment forever.
        const assignment = await Promise.race([assigned, running.then(() => { throw new Error("Turn completed before control admission"); })]);
        const steered = await pool.steerThread(threadId as string, "Do not do anything beyond the synthetic sleep and reply.");
        assert.equal(steered.turnId, assignment.upstreamRequestId); stages.push("active-turn-steering");
        const stopped = await pool.forceTerminateWorker(assignment, { kind: "cancellation-intent",
            intentId: randomUUID(), requestId: randomUUID(), source: "operator", reasonCode: "live-acceptance" });
        assert.equal(stopped.mode, "turn-interrupt");
        assert.equal((await running).structuredContent?.turnStatus, "interrupted"); stages.push("confirmed-turn-interruption");
        await pool.archiveThread(threadId as string); stages.push("archive");
        report.result = "passed";
    } catch (error) {
        report.result = "failed";
        // These errors concern synthetic messages; never print raw auth/account responses.
        report.error = error instanceof Error ? error.message : "Live check failed";
        process.exitCode = 1;
    } finally {
        clearTimeout(deadline);
        try { await pool.close(); }
        finally { await rm(directory, { recursive: true, force: true }); }
    }
    console.log(JSON.stringify(report));
}
