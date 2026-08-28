# Issue 38 ChatGPT host trace

Captured: 2026-08-28

Client: authenticated ChatGPT Work conversation

Bridge baseline: `8a2cf54`

Scope: sanitized channel/contract evidence only; conversation, Activity, Agent, Job, request, and local-path identifiers are intentionally omitted.

## Method

The bridge SQLite record, the running bridge implementation, and the authenticated raw ChatGPT conversation response were compared for the same completed Jobs. The browser network response was read without modifying the conversation. No prompt, repository result body, private reasoning, credential, or local absolute path is included here.

OpenAI's MCP Apps reference says both `structuredContent` and `content` are exposed to the model and component, while `_meta` is component-only:

https://developers.openai.com/plugins/reference#tool-results

## Observed foreground failure

| Boundary | `structuredContent` | `content` | `_meta` / UI data |
| --- | --- | --- | --- |
| Bridge retained Job result | Present: completed/delivered state and IDs | Present: multi-section final report, several KiB | Removed from durable retained result as designed |
| Bridge MCP return path | Present | Present: original primary content | Present only for Activity presentation hydration |
| Persisted ChatGPT tool message | Present: serialized as the tool message JSON | Absent | Absent from the model message |

The stored bridge result was below the configured retention limit and had `resultOmitted: false`. The ChatGPT tool message therefore proved that the answer disappeared after the bridge returned it, not during Codex execution, bridge sanitization, persistence, or retention.

## Observed exact-Job recovery failure

GPT called `codex_status` with `query.kind = "job"` and the exact completed Job ID. The bridge returned the retained primary result through `content`, but the persisted ChatGPT tool message again contained only the compact structured Job envelope (`completed`, `primary-content`, `delivered`, not omitted). It did not contain the retained report text.

GPT then started a new foreground `codex_task` to reconstruct the report. That Job completed and retained its report, but ChatGPT again stored only its structured state envelope. The final assistant response consequently reported terminal state while saying the detailed output could not be recovered.

## Root cause and correction

The regression from issue 36 put the only copy of the final answer in `content` while telling orchestrators to treat `structuredContent` as authoritative. The observed ChatGPT connector projection retained only `structuredContent` in the model tool message, so neither direct foreground completion nor exact-Job status could expose the answer to GPT.

Issue 38 corrects the contract by placing a bounded model-authoritative text answer in:

- `codex_task.structuredContent.answer` for foreground completion and replay;
- the exact completed Job item's `answer` for `codex_status`.

The structured answer is bounded to 24 KiB of JSON-encoded UTF-8 and emits a truncation marker plus warning when shortened. `content` keeps the original retained primary result as a compatibility copy. Summary status queries never embed Job bodies; they return exact-Job retrieval actions. `omitted` and `unavailable` results do not expose `answer`.

## Acceptance probes

- A foreground multi-section sentinel must be recoverable from the serialized `structuredContent` alone.
- A background/exact-Job sentinel must be recoverable from the serialized exact Job item alone.
- Escaping-heavy text must remain inside the structured-output cap and emit a truncation warning.
- Retention omission must keep `answer` absent and remain distinguishable from a delivered result.
- Activity/overview summaries must keep answer bodies absent and direct GPT to exact Job lookup.

The post-fix authenticated ChatGPT acceptance run, including foreground,
background exact-Job, discovery-schema, and conversation re-entry evidence, is
recorded in `issue-38-chatgpt-live-smoke.md`.
