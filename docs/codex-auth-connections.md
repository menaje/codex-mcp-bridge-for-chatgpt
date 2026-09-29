# Codex authentication connections

The Codex executable and the authentication connection are separate choices.
Changing the selected executable does not copy or change a login. Existing
installations continue using their current shared Codex login until someone
explicitly selects another connection.

The native first setup and Codex settings show three connection choices:

| Choice | Storage and billing |
| --- | --- |
| Existing Codex login | Uses the selected CLI's existing home and authentication store. It can be a ChatGPT or API login; the observed method determines billing. No credential is copied. |
| Separate ChatGPT login | Creates a persistent bridge profile outside the app bundle. The selected Codex CLI performs a new login in that profile. The existing Codex app login remains in its original store. |
| API key for the bridge | Creates a different persistent bridge profile. The key is sent to the selected CLI through standard input for `codex login --with-api-key`; it is never put in a process argument or the bridge state file. API usage can incur separate charges. |

Preparing a profile, starting login, verifying the account and model catalog,
and requesting application are distinct actions. A browser login launch is not
reported as completed login. API billing needs explicit confirmation before
the connection can be requested. A failed candidate remains separate from the
currently applied connection. Canceling a candidate does not replay an old
OAuth file or log out another client.

When the existing local Codex configuration contains a parseable top-level
`forced_login_method` or `forced_chatgpt_workspace_id`, bridge-owned profiles
carry those restrictions. A conflicting selection or a later local-policy
change blocks candidate verification and application. This local check does
not establish the effective managed policy or the original cause of a logout;
those require the separate acceptance checks.

If the managed server is running, a requested change stays pending. Its running
process keeps the environment it started with. Ordinary launches and automatic
crash recovery keep the previous connection. The pending request can be
canceled. An explicit graceful restart checks unfinished persisted work before
applying the new connection. A graceful apply waits for
active jobs, pending admissions and interactions, protected memory-only
threads, and background processes through the existing lifecycle checks.
Restarting or forcing the server to apply authentication is not automatic.
An explicit `CODEX_HOME` setting keeps precedence and prevents a saved
connection from changing that server's effective home.

Disconnecting the bridge is a separate choice that blocks new bridge work; it
does not call Codex logout or delete shared credentials. Bridge-owned profiles
are retained when changing connections or canceling a candidate. A profile
containing credentials must never be deleted merely because another profile
was selected. The bridge does not move thread history, skills, settings, or
credentials between homes. Existing Codex-app history remains in its original
home; a thread created there cannot be assumed resumable from a different
home or account. New bridge thread records retain a non-secret authentication
boundary. A changed connection hides earlier threads from new execution while
retaining their records; switching back to the same boundary can restore
access. Pre-existing untagged shared records remain available in the initial
shared connection and acquire a boundary when used. The first upgrade cannot
retroactively prove which account created each legacy record.
When a file-backed identity and a confirmed keyring account are both
unavailable, a process uses an unverified temporary thread boundary. It does
not treat another process's unknown account as the same thread owner. Keyring
thread resume after restart therefore needs a fresh account confirmation;
until then those sessions stay hidden from execution.

## Live test credentials

Normal build, package, unit, and CI checks use synthetic credentials and fake
App Server fixtures. The opt-in `--run-authenticated` scripts require a
**persistent, independently signed-in test Codex home** in
`CODEX_BRIDGE_TEST_CODEX_HOME`. The path must differ from the operating
`CODEX_HOME` (or default `~/.codex`), contain a file credential store in
`config.toml`, contain that test profile's own `auth.json`, and contain the
`.bridge-independent-test-auth` marker. The marker records the operator's
assertion that the profile was signed in independently; it is not proof that a
copied token is independent. Create it only after a separate test login.

For example, after preparing an empty persistent test directory with
`cli_auth_credentials_store = "file"`, run the selected CLI's normal `login`
in that directory as a distinct test session. Do not copy the operational
`auth.json`, Keychain entry, or a previous test profile into it. Add the
marker only after that login succeeds. The live scripts may rotate the test
profile's own tokens; they never delete that profile when the test ends.
Synthetic project folders and reports can be removed independently. Some
legacy question probes need extra feature or fixture MCP configuration in the
test profile; absent that configuration, their feature checks remain
unverified. Never overwrite the operating config to make a probe pass.

This is a project policy for these one-shot checks. OpenAI also documents
specific headless/CI credential transfer conditions; those conditions do not
make a disposable copy of an active refresh session safe for this workflow.

Sources: [Codex authentication](https://learn.chatgpt.com/docs/auth),
[Codex App Server authentication methods](https://learn.chatgpt.com/docs/app-server).
