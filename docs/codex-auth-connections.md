# Codex authentication connections

The Codex executable and the authentication connection are separate choices.
Changing the selected executable does not copy or change a login. Existing
installations continue using their current shared Codex login until someone
explicitly selects another connection.

The Bridge does not start `codex login` in the existing shared home. The legacy
Helper login endpoints reject that request, including calls from older clients.
Codex CLI clears its current login before a new browser flow completes; using
the shared home could sign out the Codex desktop app. New Bridge sign-in uses
the separate persistent ChatGPT profile below.

The native first setup and Codex settings show three connection choices:

| Choice | Storage and billing |
| --- | --- |
| Existing Codex login | Uses a verified file credential in the selected CLI's existing home. It can be a ChatGPT or API login; the observed method determines billing. Unsupported stores are rejected with an action to choose a separate Bridge login. No credential is copied. |
| Separate ChatGPT login | Creates a persistent bridge profile outside the app bundle. The selected Codex CLI performs a new login in that profile. The existing Codex app login remains in its original store. |
| API key for the bridge | Creates a different persistent bridge profile. The key is sent to the selected CLI through standard input for `codex login --with-api-key`; it is never put in a process argument or the bridge state file. API usage can incur separate charges. |

Preparing a profile, starting login, verifying the account and model catalog,
and requesting application are distinct actions. A browser login launch is not
reported as completed login. API billing needs explicit confirmation before
the connection can be requested. A failed candidate remains separate from the
currently applied connection. Canceling a candidate does not replay an old
OAuth file or log out another client.
The UI distinguishes a running login, a CLI process that exited successfully,
a failed process, and an unconfirmed result. An API-login deadline, input-channel
failure, or post-spawn process error requests termination but does not prove
the credential writer has exited. The candidate remains `login-unconfirmed`
and cannot be retried or verified until exit is observed. A Helper replacement
also preserves this block when the old writer cannot be observed. Canceling
an unresolved candidate retains and quarantines its profile; a new candidate
gets a different home. A late exit cannot update that new candidate. Successful
CLI exit still requires a separate account and model verification.

When the existing local Codex configuration contains a parseable top-level
`forced_login_method` or `forced_chatgpt_workspace_id`, bridge-owned profiles
carry those restrictions. A conflicting selection or a later local-policy
change blocks candidate verification and application. The bridge also reads
the selected App Server's effective configuration and requirements before
admitting new work. If that policy cannot be read, new work waits for a fresh
check. These checks do not establish the original cause of a logout or prove
the installed CLI's policy provenance; those need separate acceptance checks.

If the managed server is running, a requested change stays pending. Its running
process keeps the environment it started with. Ordinary launches and automatic
crash recovery keep the previous connection. The pending request can be
canceled. An explicit graceful restart checks unfinished persisted work before
applying the new connection. A graceful apply waits for
active jobs, pending admissions and interactions, protected memory-only
threads, and background processes through the existing lifecycle checks.
Retained terminal answers and unconfirmed completion-delivery receipts do not
block an idle restart or authentication change. They remain stored under their
original Job owner and readable only in the originating conversation; changing
authentication does not mark them read or authorize a new execution.
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
access. Pre-existing untagged records remain stored for history, but cannot
be resumed because the first upgrade cannot retroactively prove which account
created them.
When credential ownership cannot be verified, a process uses a temporary
unverified thread boundary. It cannot authorize new work or resume another
process's unknown sessions. Retained results keep their original owner.

## Supported authentication and displayed information

For ChatGPT execution ownership, a selected workspace ID alone is insufficient:
different users can belong to that workspace. A file profile uses the login
user claim in its selected ID token together with the selected workspace.
Neither email nor the optional usage response proves the login user. Token
refreshes that retain the same user and workspace keep the owner boundary.
An explicit environment API key can also identify API execution when the
selected App Server confirms API authentication and effective storage policy
permits that source; an unrelated ambient key never identifies a managed
Keyring, `auto`, or ephemeral credential.

Keyring authentication is outside this Bridge release's supported scope.
Codex can use its own OS credential store, but the current public App Server
API does not supply the login-user proof the Bridge needs. The Bridge does
not read the OS keychain or implement a hypothetical session endpoint. It
rejects an unverifiable existing connection and offers a separate Bridge
login or a verified file connection. Effective administrator policy remains
authoritative: a required unsupported store cannot be bypassed by choosing
another profile. Bridge-owned profiles request file storage in their private
persistent homes; credentials are managed by Codex and stored with restricted
file permissions. No credential migration or copy is performed.

Connection settings show the selected executable, connection source,
API-provided email, known authentication method, known billing route and
provided ChatGPT plan. Workspace/organization names that the API does not
supply, internal owner/workspace fingerprints and unknown fields are omitted
entirely. Missing quota or cost values have no placeholder card, dash, invented
zero or permanent “unavailable” row. Actual usage windows and balances remain
visible when provided. Optional organization/project cost reporting remains
available through its separate admin API connection and shows only confirmed
cost data. A temporary refresh failure may label a retained confirmed value;
real sign-in, policy or connection failures keep their actionable error.

After a confirmed login change, logout, or failed current owner check, the
last confirmed owner remains read-only history. It no longer authorizes new
Jobs or request replay. A live Job can still answer its own pending question
or be cancelled when its original worker generation and turn are verified.
Its terminal result is acknowledged only when the original executor still
holds that exact retained receipt. Additional guidance remains a new
execution input and needs current authentication confirmation.
After a full Bridge restart, persisted execution receipts remain dormant until
the new operational process confirms the same owner. A failed startup check
keeps them available for a later successful admission rather than recovering
them under an unverified login.

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
