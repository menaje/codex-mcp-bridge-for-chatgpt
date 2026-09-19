# #127 Decision-card CSS and CSP hardening — 2026-09-19

Related issues: [#127](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/127),
[#131](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/131),
[#132](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/132), and
[#129](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/129)

## Conclusion

The CSS-escape bypass reported after the initial #127 merge was reproduced
through `prepareDecisionCardContent`, fixed in runtime commit
`3ddf83b820d32beb878b42b0cf153d487ecf06e9`, and covered by unit and real-browser
regressions. Inline declarations are now parsed, comments and CSS escapes are
normalized, and only an explicit set of non-loading value functions is retained.
SVG `fill` and `stroke` use the same normalized inspection and permit only plain
paint values or exact local `url(#id)` references.

A clean signed candidate from that commit was also exercised in ChatGPT with
the account-wide developer-mode CSP enforcement setting temporarily enabled.
The malicious input was absent from the stored and mounted DOM, no request URL
targeted the test host, normal card interaction and same-conversation delivery
worked, and the host installed a CSP that did not permit the test host or
arbitrary HTTPS image/connect sources. The setting was restored to its original
off state after the test.

These results close the concrete CSS bypass and the identified actual-host CSP
configuration gap. They do not establish that every sanitizer or browser parser
differential is impossible, and they do not establish the user-effect hypothesis
tracked in #129.

## Pre-fix reproduction

The merged #127 implementation at `bf3d43e0cd8731afcd97c0e5911a613cc3aabd9f`
used a string regular expression for CSS values. A focused test passed each
payload through the production `prepareDecisionCardContent` entry point rather
than testing the expression alone.

| Input | Pre-fix prepared output |
| --- | --- |
| `background:url(https://bad.example/a)` | declaration removed |
| `background:u\72l(https://bad.example/b)` | declaration retained |
| `fill="u\72l(https://bad.example/c)"` | attribute retained |
| `stroke="\75 rl(https://bad.example/d)"` | attribute retained |

PostCSS preserved the identifier escape, while Chromium decoded it as `url(...)`
and initiated resource loading in the isolated reproduction. This established a
real parser mismatch, not only a theoretical string pattern.

## Remediation

[`src/decisionCardContent.ts`](../../src/decisionCardContent.ts) now applies the
following sequence before `sanitize-html` performs its ordinary allowlist pass:

1. Parse each inline `style` attribute as a bounded declaration list with
   PostCSS. Malformed or multi-rule input is discarded.
2. Decode CSS identifier escapes according to the one-to-six-hex-digit escape
   form, remove comments, normalize property and function names, and reject
   control characters and malformed value-parser nodes.
3. Retain only the existing presentation-property allowlist and a small explicit
   set of non-loading color, sizing, and gradient functions. Unknown functions,
   including `url`, `image`, `image-set`, `paint`, `element`, `cross-fade`,
   `var`, and `env`, cause that declaration to be removed.
4. Reconstruct retained declarations from parsed property/value pairs, so raw
   attacker spelling is not passed through as a style attribute.
5. Normalize SVG `fill` and `stroke` with the same value parser. Exact local
   references such as `url(#safeGradient)` are canonicalized and retained;
   external, escaped, commented, or otherwise non-local URL paints are removed.

The parser is additionally bounded to 8,192 characters per style attribute, 64
declarations, and 500 characters per value. This is a defense-in-depth limit,
not the primary resource-loading decision.

## Automated browser evidence

The content unit suite covers ordinary and escaped spellings, comments, escaped
property names, mixed safe gradients plus unsafe URLs, SVG paint attributes, and
`var(...)`. It also verifies that safe `linear-gradient`, `calc`, `repeat`,
`minmax`, color functions, and local SVG gradients remain usable.

The production browser regression passes escaped CSS and SVG paint through the
real sanitizer, mounts the production Decision resource in Chromium, and runs a
local leak endpoint. A post-merge review found that the first version of this
test embedded port 80 in the two escaped payloads while the detector listened on
an operating-system-assigned port. The prepared/mounted DOM assertions from that
run remained valid, but the server's zero counter was not independent evidence
that Chromium made no request attempt.

The corrected harness starts the detector first and embeds its exact origin,
including the assigned port, in both malicious values before calling
`prepareDecisionCardContent`. Browser `request` and `requestfailed` listeners
are attached before every scenario navigation. A same-browser positive control
then loads a known stylesheet from the same detector: the observer records its
exact URL once and the server receives it once. Only after that control succeeds
does the harness require the sanitized card to produce zero browser attempts,
zero failed requests, and zero server arrivals. The prepared and mounted HTML
must also contain no `/leak` value, so DOM and network observations remain
separate assertions.

| Check | Result |
| --- | --- |
| `npx vitest run test/decisionCardContent.test.ts --maxWorkers=1` | 7/7 PASS |
| `npm run test:issue-127-decision-card` | 12/12 PASS; detector control browser/server 1/1; sanitized browser attempts 0, failed requests 0, server arrivals 0 |
| `npm run check` | 88 files / 779 tests PASS |
| `npm run app-server:compat:check` | 416 JSON schemas and 827 TypeScript schemas matched Codex CLI 0.153.3 |
| `npm run mcp:conformance` | 29/29 PASS |
| `npm run macos:check` | 202 tests reported, 2 opt-in live tests skipped, 0 failures |
| `npm audit` | dependency advisory scan: 0 reported vulnerabilities |
| `npm audit --omit=dev` | production-dependency advisory scan: 0 reported vulnerabilities |

The two skipped native tests require explicit live companion/remote endpoints.
The npm audit rows describe dependency-advisory coverage only; they are not a
claim that the custom sanitizer, authorization boundary, or whole product has
zero security defects.

## Clean candidate and state

`npm run macos:bundle` produced a signed app whose bundled build information was:

```text
commit: 3ddf83b820d32beb878b42b0cf153d487ecf06e9
dirty: false
build id: 3ddf83b820d3:6791e9a35a0b
```

Before replacement the installed runtime reported zero active Jobs and pending
admissions. It was shut down through the graceful lifecycle request, then the
new app was launched. The launcher reported the exact build ID above; Bridge and
Secure MCP Tunnel both became connected. The selected stable database reported
schema 24 and `PRAGMA quick_check` returned `ok`.

## Actual ChatGPT host with CSP enforcement

The account-wide **enforce CSP in developer mode** setting was initially off.
It was turned on only for this test and its saved on state was verified before
the plugin connection and conversation were refreshed.

The successful `codex_decision` create call contained both
`background:u\72l(https://example.invalid/...)` and an escaped external SVG
paint, alongside safe layout, a local SVG gradient, two radios, and an editable
condition. An earlier model attempt omitted the required `operation` field and
was rejected before creating a card; the retry supplied the explicit create
contract and one new request ID.

The mounted production card had the following observed state:

| Observation | Result |
| --- | --- |
| forbidden host in mounted generated HTML | absent |
| escaped `url` spelling in mounted generated HTML | absent |
| generated article style | `display:grid;gap:12px;color:#123456` |
| computed background image | `none` |
| external SVG paint | attribute absent |
| local SVG paint | `url(#safeGradient)` retained |
| semantic inputs | two radios and the condition textarea remained usable |
| request URLs to `example.invalid` after the successful call | 0 |

The literal test URL necessarily appeared inside the user's ChatGPT request
body. Network evidence therefore classified events by the actual request URL,
not by an unqualified string search of POST bodies. From the successful retry
through submission and result acknowledgement, observed request origins were
the ChatGPT and web-sandbox hosts only.

The host-injected card policy was also read from the mounted sandbox document.
It had `default-src 'self'`, `object-src 'none'`, and `frame-src 'none'`; neither
`img-src` nor `connect-src` permitted arbitrary `https:`, and the test host did
not appear in the policy. This is separate evidence that CSP enforcement was
actually installed for the card. The test did not bypass the fixed sanitizer to
force an unsanitized node into the sandbox, so it does not claim observation of
a standalone CSP-violation event. The sanitizer/request observation and the
host policy inspection establish the two defense layers without weakening one
to test the other.

The user path then changed the choice to **5 weeks**, edited the condition to
**단계적 전환 / CSP 강제 시험**, and confirmed once. The card first
stored the decision, reported host acceptance, and the next GPT turn called the
exact result reader and acknowledged the 5-week choice and edited condition.
The database recorded `host-accepted`, one delivery attempt, and a result offer.
The conversation scope had zero Activities, Agents, and Jobs.

Finally, the global CSP enforcement setting was restored to its original off
state and the restored value was verified. No receipt, conversation identifier,
or private tunnel URL is retained in this audit.

## Remaining scope

- GPT blind authoring from MCP discovery and validation-error self-correction
  remain unverified and belong to #131. The CSP exercise required an explicit
  corrected retry after the first call omitted `operation`; it is not evidence
  that the authoring contract is already sufficient without hints.
- The optional case where GPT uses a decision before continuing an existing
  Codex orchestration is outside the independent-card acceptance path and is
  tracked in #132. A card still never grants execution or approval authority.
- User comprehension and decision-time claims remain unverified and belong to
  #129.
- Generated JavaScript, remote assets, canvas hit regions, and coordinate-only
  image decisions remain outside Decision v1.
- Stable release approval should continue to treat sanitizer tests and host CSP
  inspection as separate controls and rerun both when either contract changes.
