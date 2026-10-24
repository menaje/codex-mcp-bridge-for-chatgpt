# #251 postmerge response and telemetry cache corrections

Independent actual MCP HTTP and telemetry child-process review at
`acca102351334a784b9457426da9f6a6e20ab7b8` reproduced two defects. The preceding
product GO and development-complete conclusion therefore require correction;
the earlier Git merge remains real, but it did not establish these boundaries.

The response defect hydrated a retained original, cleared its saved omission,
and raised the compatibility-content contract to the original's byte size. A
1MiB configured limit consequently transmitted 2,097,180 content bytes. The
telemetry defect physically deleted old Job-less rows but left their bodies in
the parent's cache; indefinite/90-day expansion exposed them again until restart.

## Response boundary

The original result remains complete in `job_result_bodies`. Internal exact
retained detail still reads it. Hydration preserves the saved delivery omission;
original availability alone does not declare a delivered response. Semantic
publication separately compares the current serialized result size with the
registry's configured response limit, including originals that were deliverable
under a larger previous setting. Oversized originals are omitted from external
answer/content, with matching availability and omission metadata. The status and
task primary-content contracts use their configured limit, never an original's
byte size. This does not shorten history retention or change execution, scope,
restart, authentication or completion-control authority.

Actual HTTP MCP regression fixtures cover absent, normal and oversized results
with 4KiB/1MiB limits in resident/archive/restart states, exact Job/request queries,
foreign-scope refusal, full durable original equality, and a reduced current
response limit. Structured answers retain their existing separate 24KiB bound.
Status metadata follows its existing status-channel contract; the configured
result limit is not misrepresented as a cap for every byte of ToolResult JSON.

## Committed deletion and cache boundary

A retention request carries an opaque correlation ID. The child publishes only
committed transport deletion identities (ID, bridge instance and capture time)
from its existing at-most-64-row slice. Rollback/failure cannot publish candidates
as deletions. The parent's existing child-object fence and pending request ID
reject old/unsolicited/replayed ACKs; successful ACKs remove only exact persisted
cache entries. One maintenance request is in flight at a time.

New local observations remain separate from acknowledged persisted cache rows.
Write ACKs identify a result that was actually retained; an expired write omitted
from disk cannot linger and revive after expansion. On worker restart, the ready
snapshot reconciles acknowledged disk cache rows while preserving pending local
observations. Retry ACKs deduplicate an already persisted write whose earlier ACK
was lost. No persisted original is removed merely because the policy changed.

Actual child-process regressions cover both Job-less resurrection sequences,
policy expansion before physical deletion, multiple 64-row slices, fresh and
running-linked preservation, failed gate ACKs, concurrent new observations and
late/replayed ACKs, lost deletion ACK plus worker restart, and expired-write ACKs.

## Verification and delivery boundary

The exact fixed candidate and independent re-review decision are recorded in the
follow-up PR. Author tests use temporary isolated databases and localhost MCP;
they are not installed-app acceptance. Previous unchanged verification evidence
is reused. No broad #242/#246 rework, actual GPT resumption, soak/long-duration
substitute, operating app/DB/settings/authentication change or release is added.
The previously disclosed repository-wide baseline limitations remain disclosed;
these focused checks do not relabel that full run as green.

## Independent corrected-candidate decision

R independently reviewed exact `c507320686564316a2f4e53b00351b0b91ad7d9b`
and reported **GO for the two repaired boundaries**, with no new blocker.
The original four reproductions were converted to required behavior, and two
independent counterexamples were added. Together with the candidate's 27 real
MCP/child regressions, the exact independent run passed **33 cases in four files**.
This is separate from A's 161-case related regression run and exact candidate
27-case/build checks, all passed. No full-repository pass is claimed.

The original comments are
[P1 oversized retained result](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/pull/252#discussion_r4267986210)
and [P2 stale telemetry cache](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/pull/252#discussion_r4267986195).
R's actual MCP reproductions now returned 71 content bytes and 1,355 ToolResult
JSON bytes for each oversized case, while durable originals of 200,067 and
2,097,219 bytes remained complete. Both deletion/expansion reproductions now
returned zero cache rows, agreeing with disk and restart.

Independent added counterexamples verified rollback after a transport DELETE
when a later diagnostic DELETE aborted (zero deletion callbacks and the original
row preserved), and a lost record-write ACK followed by worker restart/retry and
a concurrent observation (exactly two disk/cache identities, no duplicate or loss).
Original observations/reproductions remain preserved privately.

See the [product equivalence record](2026-10-14-issue-251-postmerge-equivalence.json).
The publication adds documentation only after the reviewed product commit. PR
review completion at the exact published HEAD, new findings and development
integration remain separate from this local independent GO; they must be checked
before merging. Review threads and issue completion are not automatically marked.
