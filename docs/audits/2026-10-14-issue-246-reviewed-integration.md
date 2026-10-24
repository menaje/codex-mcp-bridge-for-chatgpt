# Issue #246 reviewed integration

Cold startup now observes a loaded helper without treating missing handshake
evidence as incompatibility. Initial server recovery uses one durable intent,
at most three total attempts and one absolute five-minute budget. Only structured
transient readiness failures with confirmed owned cleanup authorize retry.

Surviving children require closed admission, confirmed protection state and exact
ownership. Drain/cancel validates the expected runtime at the state-owner's
synchronous mutation boundary. A later ordinary drain retires the initial
owner, so an older cancellation cannot reopen the newer gate. Unknown ownership,
protected work and failed inspection preserve survivors and prohibit retry.

## Review and publication identities

- Reviewed source: `3aeeb0e8d89d1ce1c72952a5179d414a214a3d90`.
- Base dev: `d231bd2b9f4d4b55cc1283b698c499828eff2d0f`.
- Publication code snapshot: `958115dfdab9e43af9b74cb28a2e1d11145c26c2`.
- Reviewed Node runtime source hash:
  `34a625f42cb4c2905161bd6909d7453b31539d11033c6afe351c6223da3d321d`.

All 32 changed non-audit blobs, including native sources, tests, policy and
release fragment, match the independently reviewed revision exactly. The
publication snapshot preserves the existing dev base and excludes four private
historical audit records. This separate record adds only public technical
evidence. Full original history and raw verification records remain preserved
privately; they were not overwritten or published. Source/blob comparison,
rather than ancestry alone, establishes this snapshot's reviewed provenance.

## Independent verification at the reviewed revision

| Check | Result and boundary |
| --- | --- |
| Build and release/localization metadata | PASS; clean reviewed source. |
| Affected Node, 17 files | 277 passed, one existing 61-second reservation case excluded; no deadline shortening or replacement endurance run. |
| Selected native | 86 passed, strict concurrency and warnings-as-errors. |
| Original protected-orphan stimulus | 12 fixed-outcome conditions passed; protected child survived, one spawn, no automatic retry. The unchanged assertion demanding the old bug rejected the corrected behavior and is not counted as a passing original assertion. |
| Actual launcher/HTTP/state-owner receiver chain | 15 conditions passed using isolated fixtures, without real Jobs or grants. |
| App Server schema check | PASS with exact existing CLI 0.153.3: 416 JSON and 827 TypeScript files, including normalized hashes. CLI selection and schema pin were unchanged. |
| Native input | PASS: 32 declarations and three existing system-owned exceptions. |

The independent reviewer issued T5 code-integration GO with no remaining valid
P0/P1/P2 finding. The prior schema prerequisite failure and all reported defects
remain in the private history; successful later checks do not erase them.
Fast-gate components are satisfied at the reviewed revision. This does not claim
that the complete CI pipeline or every default full-suite command was rerun.
Native/localization reuse is bounded by exact input blob identity; extraction
and compilation evidence is not relabelled as a new run.

## Acceptance boundary

The earlier actual 90-second helper preparation fixture is historical component
evidence, not a full current-revision server/Tunnel or OS reboot acceptance.
Installed reboot/login/initial-network-delay acceptance remains unverified.
The operational 502 direct cause in Issue #242 remains unconfirmed. Read,
completion, transport and initial-start fixture success do not close those gaps.
This integration references #242/#246 without automatically closing either.

App replacement requires a matching built artifact and a fresh no-active-work
preflight with an explicit impact/rollback plan before stopping the installed
app/helper. No reboot, network/authentication/permission reconfiguration or
production fault injection is part of this source integration.
