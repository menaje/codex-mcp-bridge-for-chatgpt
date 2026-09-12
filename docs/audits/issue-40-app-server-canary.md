# Issue 40 authenticated App Server steering canary

Date: 2026-08-28 (Asia/Seoul)

## Environment

- Codex CLI: `0.145.0`, matching `release-manifest.json`
- Backend: authenticated local `codex app-server --stdio`
- Model/effort: `gpt-5.6-sol` / `low`
- Project: disposable empty directory
- Execution: read-only sandbox, approval policy `never`, one ephemeral App
  Server worker
- Client path: in-memory MCP client through the real public Bridge tools and a
  persistent temporary SQLite state database

The disposable directory and database were removed after the assertions. No
repository file was read or written by the canary Job.

## Probe

The public `codex_task` started one background Job whose first action was a
bounded `sleep 12`. While its root App Server turn was observably active:

1. `codex_steer` with a deliberately incorrect positive Job version returned
   `STALE_JOB_VERSION` and `delivery.status: "not-delivered"`.
2. The same operation with the exact current Job version returned
   `delivery.status: "delivered"` and
   `steeringScope: "active-codex-turn-only"`.
3. An exact retry returned the identical structured result.
4. The upstream `turn/steer` wrapper observed exactly one call.
5. The Job emitted exactly one root `turn/started` event, and its final answer
   contained both the original and steering sentinels.
6. After the Job completed, another public steering request returned
   `JOB_NOT_ACTIVE` with `delivery.status: "not-delivered"`; the App Server
   reported no active turn.
7. A byte search of the live SQLite database did not find the exact raw
   steering prompt.

Observed sanitized result:

```json
{
  "taskState": "running",
  "terminalJobState": "completed",
  "staleCode": "STALE_JOB_VERSION",
  "staleDelivery": "not-delivered",
  "delivered": "delivered",
  "deliveredScope": "active-codex-turn-only",
  "replayEqual": true,
  "terminalCode": "JOB_NOT_ACTIVE",
  "terminalDelivery": "not-delivered",
  "upstreamSteerCalls": 1,
  "turnStartedEvents": 1,
  "finalContainsBase": true,
  "finalContainsSteer": true,
  "rawSteeringPromptPersisted": false,
  "activeAfter": false
}
```

## Complementary deterministic gates

The authenticated canary exercises active delivery, optimistic stale rejection,
exact replay, terminal rejection, no future-turn start, and prompt privacy. The
fixture suite separately exercises cross-scope rejection, MCP Server distinction,
pending-interaction non-resolution, execution-policy immutability, explicit
cancel-before-steer ordering, durable replay behavior, and restart from a
persisted dispatch boundary with `DELIVERY_UNCERTAIN` and no resend.

The deterministic public-tool suite also composes `codex_task` and the exact
four-field `codex_steer` through one host-derived conversation scope, rejects a
different host session, and forces the upstream fixture to echo the complete raw
steering input through progress, event details, and the final result. The echo is
absent from retained Job state, exact public status output, and a byte scan of
the persistent Bridge SQLite database.

This evidence proves the tested boundary; it is not a distributed exactly-once
claim and does not turn App Server's experimental interface into a production
stability guarantee.
