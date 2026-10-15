# PR257 review follow-up

Base: dev `d2dc4a60be44726049eb42ca06523e78a0a4fb19`. PR257 was already merged when these five automatic inline findings arrived. This is a separate corrective PR; its validation does not establish operating application acceptance.

| Review | Correction | Reproduction and regression evidence |
| --- | --- | --- |
| r4277750070 | Native/card execution reasons render once; distinct incident and recovery context stays visible. | Actual card rendering failed three cases before the change; five cases now pass, with native presentation coverage. |
| r4277750079 | Job handoff resolves its owning Agent and verifies the exact retained Job/thread and current-thread fence. A row cannot borrow another Job's current thread URL. | Running and terminal exact-Job service requests failed TARGET_CHANGED before the fix; both pass, and foreign/stale thread requests remain rejected. |
| r4277750083 | Native page merges reschedule expiry from the merged snapshot, including idle rows. | Actual History/Background append regression failed six assertions before the fix; local expiry still invalidates presentation when refresh fails. |
| r4277750090 | Job snapshots set historyIncluded false when the terminal body is omitted. | Actual initial service response plus production card selectStatus now makes one History fetch and shows its rows. |
| r4277750096 | Job projection preserves canonical orphaned/liveness-unknown health without replacing blocking input/approval status with generic running. | Three runtime health cases failed before the fix; ordinary, background, blocking and exact-detail revision regressions pass. |

Verification: 83 relevant source tests pass (68 shared/server/card, 14 thread connection, one mounted MCP handoff hydration); all 327 native tests execute with three existing skips and zero failures; eleven browser fixture assertions, TypeScript, build/release/localization and whitespace checks pass. The new revision changes no operating settings, authentication, database content or application bundle.

Two Dashboard query-cost assertions still fail at 57 SQL statements against a threshold of 50. A clean archive of base d2dc4a6 reproduces both failures unchanged; they are not reported as passes or repaired in this follow-up. Private command logs and original review bodies are in evidence/deploy-tabs.

This candidate must remain Draft until fixed-commit independent review. After Ready starts automatic code and security review, both reviews must reach terminal completion for the exact final HEAD and every new finding must be compared and handled. Parent final GO is required before a separate merge action or any application deployment.
