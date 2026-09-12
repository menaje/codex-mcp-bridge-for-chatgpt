import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CodexAppServerUpstreamPool } from "../src/appServerUpstream.js";
import type { CodexPendingInteraction } from "../src/upstream.js";

// Opt-in authenticated acceptance: only synthetic prompts and a private empty
// working folder. The user's installed CLI, settings and credentials stay intact.
const commands = process.argv.slice(2).filter(value => value !== "--run-authenticated");
if (!process.argv.includes("--run-authenticated") || !commands.length || commands.some(value => !path.isAbsolute(value))) {
    throw new Error("Pass --run-authenticated and absolute CLI paths.");
}
const authFile = path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "auth.json");
const auth = JSON.parse(await readFile(authFile, "utf8"));
assert.ok(auth.auth_mode === "chatgpt" && typeof auth.tokens?.access_token === "string", "Existing ChatGPT file login required.");

for (const command of commands) {
    const directory = await mkdtemp(path.join(tmpdir(), "bridge-live-interactions-"));
    const codexHome = path.join(directory, "codex");
    const project = path.join(directory, "synthetic-project");
    const pool = new CodexAppServerUpstreamPool(command, 1, { environment: {
        ...process.env, CODEX_HOME: codexHome, OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined
    } });
    const deadline = setTimeout(() => { void pool.close().catch(() => undefined); }, 240_000);
    const stages: string[] = [];
    const report: Record<string, unknown> = { stages };
    try {
        await mkdir(codexHome, { mode: 0o700 }); await mkdir(project);
        await copyFile(authFile, path.join(codexHome, "auth.json"));
        await chmod(path.join(codexHome, "auth.json"), 0o600);
        // This installed CLI exposes input in default mode behind this opt-in.
        // Enable it only in the disposable test home, not in user configuration.
        await writeFile(path.join(codexHome, "config.toml"),
            'cli_auth_credentials_store = "file"\nmodel_reasoning_effort = "low"\n[features]\ndefault_mode_request_user_input = true\n');
        report.version = execFileSync(command, ["--version"], { encoding: "utf8", timeout: 5_000 }).trim();
        const account = await pool.readAccountSnapshot();
        assert.equal(account?.authMode, "chatgpt"); assert.equal(account?.authenticated, true);
        for (const test of [
            { name: "command-approval-accept", kind: "command-approval", decision: "accept",
                prompt: "This is an approval integration test in an empty folder. Use exec_command once with command printf LIVE_APPROVAL_OK and sandbox_permissions=require_escalated. Request approval explicitly even though printf is harmless. Do not read or write any files or use any other command. After the result, reply LIVE_APPROVAL_OK.", expected: /LIVE_APPROVAL_OK/ },
            { name: "command-approval-cancel", kind: "command-approval", decision: "cancel",
                prompt: "This is an approval-cancellation integration test in an empty disposable folder. Use exec_command once with command printf LIVE_CANCEL_PROBE > cancelled.txt and sandbox_permissions=require_escalated. Request approval explicitly. If cancelled, do not retry or run anything else. Do not read files or modify any other file.", expected: undefined },
            { name: "user-input-answer", kind: "user-input", decision: undefined,
                prompt: "This is an interactive-input integration test. Do not use shell or read/write files. Use request_user_input to ask one question with id=color, header=Color, question=Which test color?, options Blue and Red with short descriptions. Wait for the answer and reply exactly LIVE_INPUT_<selected color>.", expected: /LIVE_INPUT_Blue/i }
        ] as const) {
            const seen = new Set<string>();
            const responses: Promise<void>[] = [];
            let interactionError: unknown;
            const result = await pool.callTool("codex", {
                cwd: project, sandbox: "read-only", "approval-policy": "on-request",
                config: { model_reasoning_effort: "low" }, prompt: test.prompt
            }, progress => {
                const value = progress.event?.details?.interaction;
                if (!value || typeof value !== "object" || !("interactionId" in value)) return;
                const interaction = value as CodexPendingInteraction;
                if (seen.has(interaction.interactionId)) return;
                seen.add(interaction.interactionId);
                const response = (async () => {
                    assert.equal(interaction.kind, test.kind, "Unexpected interaction kind");
                    if (interaction.kind === "command-approval") {
                        const marker = test.decision === "cancel" ? "LIVE_CANCEL_PROBE" : "LIVE_APPROVAL_OK";
                        const suffix = test.decision === "cancel" ? " > cancelled.txt" : "";
                        const exactCommands = [marker, `"${marker}"`, `'${marker}'`].map(value => `printf ${value}${suffix}`);
                        const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
                        const allowed = new Set(exactCommands.flatMap(value => [value,
                            ...["zsh", "bash", "sh"].flatMap(shell => [
                                `/bin/${shell} -lc ${shellQuote(value)}`, `/bin/${shell} -lc ${JSON.stringify(value)}`
                            ])]));
                        const requestedCommand = interaction.summary.replace(/^Command approval required: /, "").split(" — ")[0];
                        assert.ok(allowed.has(requestedCommand), "Approval was not for the exact synthetic command");
                        assert.equal(interaction.cwdLabel, "synthetic-project");
                        await pool.respondToInteraction(interaction.interactionId, { decision: test.decision });
                    } else {
                        assert.equal(interaction.questions?.length, 1);
                        assert.equal(interaction.questions?.[0]?.id, "color");
                        await pool.respondToInteraction(interaction.interactionId, { answers: { color: ["Blue"] } });
                    }
                })();
                // Observe failures immediately, without an unhandled rejection or
                // leaving an unexpected approval pending until the global timeout.
                responses.push(response);
                void response.catch(error => {
                    interactionError = error;
                    return pool.close().catch(() => undefined);
                });
            }).catch(error => { throw interactionError || error; });
            await Promise.all(responses);
            assert.ok(seen.size > 0, `${test.name}: CLI did not request an interaction`);
            if (test.decision === "cancel") {
                assert.ok(["completed", "interrupted"].includes(String(result.structuredContent?.turnStatus)));
                await assert.rejects(stat(path.join(project, "cancelled.txt")), { code: "ENOENT" });
            } else {
                assert.equal(result.structuredContent?.turnStatus, "completed");
                assert.match(JSON.stringify(result.content), test.expected!);
            }
            await pool.archiveThread(result.structuredContent?.threadId as string);
            stages.push(test.name);
            console.log(JSON.stringify({ version: report.version, stage: test.name, result: "passed" }));
        }
        report.result = "passed";
    } catch (error) {
        report.result = "failed";
        report.error = error instanceof Error ? error.message : "Interaction check failed";
        process.exitCode = 1;
    } finally {
        clearTimeout(deadline);
        try { await pool.close(); } finally { await rm(directory, { recursive: true, force: true }); }
    }
    console.log(JSON.stringify(report));
}
