# Current history presentation

The display baseline is `2dedefb`, immediately before PR #257. Both the menu bar
and Dashboard card keep its Activity heading, project/conversation context,
Agent name, status, recorded model/reasoning settings and execution time. The
underlying Job projection stays in place so older Jobs remain reachable and
counts and page sizes keep the same unit.

The requested corrections apply to both clients:

1. Progress, execution history and problem history append with **Show more**.
   A changed problem-list revision or retention policy restarts the first page;
   old responses cannot append after a connection, scope or snapshot change.
2. All three lists group by Activity, then Agent, then each returned Job. Agent
   identity includes its conversation; display names do not merge owners. Each
   Job uses its own saved model, reasoning setting, token usage and time.
3. Job-mode problem history contains one retained failed, interrupted or
   cancelled Job per entry. Successful Jobs, unlinked/unavailable references,
   system incidents and additional recovery events do not appear as problem
   Jobs. Its tab count and page total use that same set of Jobs.
4. No visible Job IDs, execution-detail disclosures or exact-detail buttons.
   Opening or reading these lists does not fetch exact details. The read-only
   detail APIs and their scope/retention protections remain available internally.
5. Recorded cancellation reasons and recorded error/interruption messages are
   displayed once per Job. Missing or blank reasons have no reason block or
   placeholder, including cancellations; the Job and its status stay visible.
   Korean browser examples use Korean fixture messages; stored diagnostics keep
   their recorded text.
6. The repeated **Recent Activity** prefix is absent. Activity titles remain.

`tabs-execution-browser-regression.ts` checks both append flows and display
content, stale/scope-changing problem pages, legacy fallback and Korean labels.
`tabs-review-browser-regression.ts` retains background ownership, local expiry,
health status and queued-history checks. Native tests cover problem append,
changed/late pages, Agent grouping and filtering. These are isolated fixture
checks; they do not update the operating app or its database.
