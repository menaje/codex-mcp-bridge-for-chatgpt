# Issue #69 original-input retry

The user requested another in-app-browser attempt after building the latest app.
The running bridge reported build `03549a2dbe86:994b2f5f82d7`, matching merged
dev product code. The existing work conversation and separate global overview
were used. No replacement Activity or Settings card was opened.

## Actual ChatGPT observations

GPT created Job `6e28ec3e-e14a-44b0-b15a-7168713cd06e`. Codex called
`original_control_probe.input_probe` once and produced an original MCP form.
The overview showed input needed; its details displayed the original server
message and a colour selector with `blue` and `red`.

| UTC event | Observation |
| --- | --- |
| 05:49:44.064 | Original form request `app-0:1:0` became pending. |
| 05:50:44.242 | The MCP tool failed after 60,119 ms. |
| 05:52:54.178 | After refreshing details and selecting `blue`, the original request was resolved. The form disappeared. |
| 05:56:54.805 | The test Job was cancelled through the overview after its tool had failed. |

The first submission returned `INVALID_ARGUMENT` while the Job had advanced
from version 10 to 11. It is not counted as an accepted response. Refreshing
the displayed request allowed submission, but the Codex session then received
`MCP error -32001: Request timed out`, not the selected colour. Request resolution
alone therefore does not pass the required same-Job result-reflection check.
The test was cancelled when Codex continued waiting after the failed call.

The fixture used the MCP SDK's default 60-second request timeout. It now gives
its original elicitation a bounded ten-minute timeout. For the next actual-host
attempt, its temporary project-local MCP entry also used `tool_timeout_sec = 660`.
The [official MCP configuration reference](https://learn.chatgpt.com/docs/extend/mcp#other-configuration-options)
documents a default tool timeout of 60 seconds. These changes affect the opt-in
test fixture only; no bridge permissions, approval rules or production code changed.

The next GPT request was rejected before Job creation. ChatGPT displayed an
OpenAI safety-check rejection and asked to recheck the transmitted material;
it supplied no detailed reason. No further request or alternative execution
channel was used for this blocked Job. Only the first test Job was added.

## Local fixture check and cleanup

A separate local SDK client answered the fixture after 65 seconds. One original
form request returned `ORIGINAL_INPUT:accept:blue` after 65,024 ms. This verifies
the timeout repair across the previous 60-second boundary. It is explicitly a
local fixture check, not actual ChatGPT or Codex acceptance. JavaScript syntax
and diff whitespace checks also passed.

The temporary project configuration was removed after exact-content comparison.
A graceful helper restart cleared the test MCP connection. At 06:01:24 UTC the
latest app was running and connected, with zero active Jobs, pending admissions,
pending interactions or background processes, and no last error.

The database comparison covered 17 tables. Settings, four projects, registry,
Agents and all pre-existing event rows were unchanged. Jobs grew from 484 to
485 and Activities from 212 to 213. Two older Jobs crossed the existing six-hour
retention limit and were reduced to retained summaries; their one Activity's
version/timestamp changed. Matching `retention-pruned` and `job-retention-pruned`
events establish this normal retention processing. The retention setting was
not changed and no database replacement or restoration was performed. This run
does not claim zero changes to every pre-existing row.

#69 remains open for original form submission reaching the same Codex Job's
result on the actual ChatGPT host. Native notification tests and new unsupported
ended-response wake behavior retain their previously documented separate scope.
The [structured retry report](issue-69-input-retry.json) keeps these observations
and the local fixture check separate.
