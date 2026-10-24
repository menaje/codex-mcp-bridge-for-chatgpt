# Documentation screenshots

The October 23, 2026 refresh uses **English UI, English sample content, and light
appearance**. All images are captures of the current production views, using
synthetic projects, accounts, usage and work. They do not report live usage or
establish actual execution, billing, or ChatGPT-host acceptance. Product source
identity and the SHA-256 of each image are in [capture-manifest.json](capture-manifest.json).

| Image | Capture source |
| --- | --- |
| `macos-connection-setup-light-en.png` | Native first-run role selection |
| `macos-settings-sidebar-light-en.png` | Native Settings, General |
| `macos-models-execution-light-en.png` | Native Settings, Models & Execution, with Standard selected |
| `macos-projects-light-en.png` | Native Settings, Projects, with the Bridge Demo registration |
| `macos-codex-account-light-en.png` | Native Settings, Codex Account & Installation |
| `macos-app-roles-light-en.png` | Native Settings, Connection, with the local server role |
| `macos-pairing-invitation-light-en.png` | Native Settings, Connection, including the five-minute pairing action |
| `macos-skill-library-light-en.png` | Native Skill Library, English Code Review procedure and file tree |
| `macos-menubar-usage-light-en.png` | Native Dashboard popover, compact summary |
| `macos-dashboard-light-en.png` | Native Dashboard popover, In progress |
| `macos-execution-history-light-en.png` | Native Dashboard popover, Execution history |
| `macos-problem-history-light-en.png` | Native Dashboard popover, Problem history |
| `chatgpt-settings-light-en.png` | Production Settings HTML in Chromium with a local host fixture |
| `chatgpt-dashboard-light-en.png` | Production Dashboard HTML, In progress |
| `chatgpt-execution-history-light-en.png` | Production Dashboard HTML, Run history |
| `chatgpt-problem-history-light-en.png` | Production Dashboard HTML, Problem history |

The native summary calls the history tab **Execution history**; the web card
calls it **Run history**. The Connection images intentionally show the same
destination, used by the role-selection and pairing walkthroughs respectively.

## Reproduce and review

From a macOS checkout with dependencies installed, an unlocked desktop and
screen-capture access:

```bash
npx tsx scripts/documentation-screenshots.ts
```

Use `--native-only` or `--web-only` to capture one surface. Output is staged in
`output/playwright/documentation/`. Review every image before copying the PNGs
and `capture-manifest.json` into this directory. This command does not replace
the checked-in images automatically.

[`documentation-screenshots.ts`](../../scripts/documentation-screenshots.ts)
uses the shared [English sample snapshots](../../scripts/fixtures/documentation-snapshots.ts).
The [native capture entry point](../../scripts/fixtures/NativeDocumentationScreenshots.swift)
hosts unmodified production SwiftUI/AppKit views in a separate temporary app,
with read-only fixture sockets and synthetic login-item/notification state.
It sets both the interface preference and Apple locale to English, captures
composed windows with `screencapture`, and checks visible text with macOS OCR.
The Settings sidebar material is captured through the screen compositor;
`NSView.cacheDisplay` does not render it completely. The popover is hosted in
an opaque window to prevent desktop content from bleeding through.

Browser captures use [`settingsCard.ts`](../../src/settingsCard.ts) and
[`dashboardCard.ts`](../../src/dashboardCard.ts) in Chromium at a 645-pixel CSS
viewport, with an English local `window.openai` host adapter. The command opens
each tab, captures its `main` element, checks the current speed choices, and
rejects browser errors or obsolete history controls.

No operational helper, Tunnel, login, account data, settings, or Codex task is
used. Historical acceptance images remain in the audit directories with their
original dates and scope.
