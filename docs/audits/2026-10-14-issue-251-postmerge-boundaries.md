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
