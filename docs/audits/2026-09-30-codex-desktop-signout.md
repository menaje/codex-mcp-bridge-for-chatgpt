# Codex desktop sign-out investigation — 2026-09-30 KST

This is a read-only reconstruction of the reported repeated desktop sign-outs.
No credential value, token, or account claim was read or copied, and no login,
logout, refresh, app replacement, or billed request was performed.

## Observed sequence

The direct CLI login log in the operating Codex home records browser-login
starts at the following times. The desktop app's own daily logs record the
first `desktop_fetch_auth_401` shortly afterward. The 401s were for ChatGPT
backend APIs such as usage and task listing, with `hadToken=true` and
`tokenSource=cached`.

| CLI browser login started | First desktop auth 401 | Gap |
| --- | --- | --- |
| Sep 23, 19:38:58 | Sep 23, 19:39:14 | 16 seconds |
| Sep 24, 11:34:31 | Sep 24, 11:34:59 | 28 seconds |
| Sep 25, 10:38:24 | Sep 25, 10:38:34 | 10 seconds |
| Sep 28, 18:09:24 | Sep 28, 18:09:33 | 9 seconds |

On Sep 25 and Sep 29, desktop logs later reported that its access token could
not be refreshed because the user had logged out or signed in to another
account. The current operating auth file's modification time follows the Sep
29 successful login, consistent with a later replacement login. These facts
establish temporal correlation and a real desktop authentication failure. They
do not identify which process or user action launched each direct CLI login.

## Mechanism and scope

In the [Codex CLI browser-login implementation](https://github.com/openai/codex/blob/rust-v0.158.0-alpha.2.1/codex-rs/cli/src/login.rs),
`login_with_chatgpt` calls `clear_existing_auth_before_login` before waiting
for the browser. That function calls `logout_with_revoke`; the [auth manager](https://github.com/openai/codex/blob/rust-v0.158.0-alpha.2.1/codex-rs/login/src/auth/manager.rs)
revokes and removes existing authentication from the selected Codex home.
This is present in the inspected upstream versions around the incident;
the exact binary used for each historical login was not recorded.

The older Bridge Helper's browser-login action launched the selected CLI's
`login` command with its active environment. With the ordinary shared Codex
home, this can clear the desktop app's login even if the user never clicks
"logout". That source path is a concrete failure mechanism. The local logs
do not establish whether the Bridge, a terminal, or another caller invoked
the CLI on those four occasions. The earlier opt-in test scripts that copied
`auth.json` remain a separate, conditional hazard; available records do not
show that they ran during these events. The observed error is also different
from the known refresh-token-reuse error, so the copy hypothesis should not
be presented as the diagnosed cause.

Keyring support is not the direct repair for this mechanism. The CLI's
pre-login clearing uses the configured credential store; moving the same
shared login between file and Keyring storage would retain the conflict.

## Source correction and remaining acceptance

The Bridge now rejects both legacy Helper login actions, including requests
from older clients, before spawning the CLI. First setup and recovery direct
the user to Codex settings, where a separate persistent ChatGPT profile runs
the selected CLI with its own `CODEX_HOME`. The shared login remains usable
as an existing connection; the Bridge does not initiate a replacement login
there. Synthetic tests cover both legacy entry points and the separate
profile path. The separately authorized `7116217` candidate is now installed.
Both legacy Helper login actions reject with `CODEX_SHARED_LOGIN_DISABLED`. A
new Bridge-owned profile completed login and candidate verification without
changing the shared auth file's modification time. The previous `cd9d39b`
candidate must not be used as the logout fix because it still contains the
legacy action.

Remaining acceptance includes installing the idle-restart guard correction,
activating the staged profile, and confirming the operating app retains its
login through a later refresh. Existing terminal results and delivery receipts
remain stored and scoped through the corrected transition. Issues #208/#210 have additional
execution continuity, Keyring scope, and real-environment requirements in
[the acceptance status](2026-09-29-auth-acceptance-status.md).
