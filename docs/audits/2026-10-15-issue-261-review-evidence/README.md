# Independent #261 review evidence

These files were copied byte-for-byte from the independent reviewer's temporary
reports, scripts and six status outputs after the final review. `SHA256SUMS`
records their retained bytes. The reports summarize reviewer-run results; they
are not captured raw transcripts of every test command. Status logs contain
JSON with synthetic fixture references and controlled observations, followed by
the assertion result.

| Retained file | Original temporary artifact |
| --- | --- |
| `first-review.txt` | `/tmp/issue261-independent-review-56e850bc.txt` |
| `final-review.txt` | `/tmp/issue261-independent-review-d290d9bb.txt` |
| `history-scenarios.mts` | `/tmp/issue261-independent-review.mts` |
| `first-status-reproduction.mts` | `/tmp/issue261-independent-status.mts` |
| `status-scenarios.mts` | `/tmp/issue261-independent-status-rereview.mts` |
| `status-<scenario>.txt` | `/tmp/issue261-independent-status-rereview-<scenario>.log` |

The first review applies to `56e850bc25034c7fd138336797164f446ac9b417`.
The final review applies to `d290d9bb3e8117d2352f13361a52b2deb42eb539`.
History scenarios were rerun at both; the final status script asserts the final
review SHA. The first status script prints the P2 observation and asserts that
notifications are suppressed; it is not a regression expecting the fixed text.

For reproduction, use a disposable checkout of the corresponding exact SHA
with its dependencies. In a throwaway copy of a script, replace the original
`/Volumes/Data/Dev/codex-mcp-bridge-issue-261-review-fix` absolute prefix with
that checkout's absolute path, preserving the SHA assertion and all other
logic. Run it with that checkout's `node_modules/.bin/tsx`. The final status
script accepts `enabled`, `relay`, `followups`, `ended`, `paused` or
`unregistered`; invoke each separately. Running against a later audit-only
commit without adjusting the checkout deliberately fails the SHA assertion.

Fixtures create disposable SQLite state and controlled upstream replies.
They do not read operational state, launch actual Codex/GPT work, deploy,
exercise the real host, manipulate clocks or demonstrate continuous uptime.
Paused and ended states are constructed directly. The finite cases do not
exhaust the state space or establish host-wide delivery guarantees.
