# Releasing Codex MCP Bridge for ChatGPT

Release the bridge only from a clean, reviewed working tree with the generated
manifest, card resources, native app, and packaged server derived from the same
source revision.

Public identity: **Codex MCP Bridge for ChatGPT** · GitHub repository
`menaje/codex-mcp-bridge-for-chatgpt` · npm package
`codex-mcp-bridge-for-chatgpt`.

## Required checks

Run the normal repository checks:

```sh
npm ci --dry-run --ignore-scripts
npm run build
npm test
npm run app-server:compat:check
npm run macos:check
npm run release:check
```

Use `npm run validate:full` when the full local toolchain is available. Keep
generated build output out of the review unless it is a declared package
artifact.

## MCP 2026-07-28 release gate

This is a current-only MCP release. Confirm that:

- production HTTP and stdio advertise only `2026-07-28`;
- legacy initialization, session IDs, GET/DELETE transport operations, and
  replay are rejected;
- current discovery, tool call, resource list, and resource read work with the
  SDK v2 client;
- host, Origin, and configured authorization checks run before MCP dispatch;
- the 12 model-visible and 14 app-private current descriptors are the only
  discovery inventory.

Run `npx tsx scripts/audit-tool-guidance.ts` to record the isolated descriptor
inventory and no-execution probes. This audit is not a substitute for a
connector acceptance test.

Before publishing, deploy the candidate through its Secure MCP Tunnel and
record one actual ChatGPT discovery, tool call, and card open. If that host
cannot consume the current protocol or schema, mark the release blocked. Do
not add a legacy server, parser, resource, or tool descriptor to bypass the
failure.

## Tool contract gate

Verify the current contracts in [Input contracts](input-contracts.md) and
[Output contracts](output-contracts.md):

- `codex_models` has one response contract and optional `refresh` only;
- `codex_task` requires input version 4 and the current descriptor's exact
  `executionEnvelopeRef`;
- task output uses contract version 2 and structured `nextActions`;
- old input aliases and output branches reject without mutation;
- persisted task idempotency and result retrieval remain intact after restart.

The output-contract fixture suite covers all model-visible tools and Task's
setup, replay, running, completed, failed, and cancelled states.

## UI resource gate

The release catalog is version 4 and selects one current file for Settings and
one for Dashboard. Its compatibility arrays are empty. The current resource
identities and URI-version rules are documented in
[UI card release policy](ui-release-compatibility.md).

When card source or host-affecting metadata changes:

1. render and synchronize the generated manifest, lock, and two current files;
2. review the new SHA-256 integrity digest while keeping the URI version stable
   for compatible changes;
3. increment only the affected card's URI version if a cached card cannot use
   the new server contract safely;
4. run `npm run release:check`;
5. deploy the build, refresh the ChatGPT connection, and reopen every card.

The catalog and package must not include digest-named history, a
published-baseline, or a temporary compatibility revision.

## Package and state gate

`release-manifest.json` is the source of release metadata. The release check
verifies its generated plugin files, card manifest, catalog digest, current card files,
and release-policy data. Do not hand-edit generated manifest outputs as a
substitute for the release process.

When the SQLite schema changes, run the applicable state migration and recovery
audit against the candidate package. Preserve durable settings, projects,
Activities, Agents, Jobs, questions, results, and idempotency evidence unless a
reviewed migration explicitly removes data. A wire-contract removal is not a
reason to discard state.

Build and inspect the npm package and macOS DMG as the final candidate
artifacts. Record the artifact hashes, source revision, validation output, and
ChatGPT/Tunnel acceptance in the release notes or tracking issue.

## Deployment and rollback

Deploy one current build, then refresh the ChatGPT connector if tools or card
metadata changed. An unchanged restart does not need a connector refresh.

Rollback means redeploying a previously packaged build with its matching
manifest and resources. It does not mean mixing an older resource URI or tool
descriptor into the current build. If a rollback needs state recovery, use the
documented backup and state recovery procedure.
