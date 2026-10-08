# Documentation screenshots

Documentation uses English UI and light appearance. The October 4, 2026
refresh was captured from production UI at development commit
`37839d16039e7c16c6857d313ca8a37aa7c71e9b`, with synthetic projects, account
information, usage, and work. These examples do not report live account usage
or establish real execution, billing, or ChatGPT-host acceptance.

| Image | Capture source |
| --- | --- |
| `macos-settings-sidebar-light-en.png` | Native Settings, General destination |
| `macos-codex-account-light-en.png` | Native Settings, Codex Account & Installation destination |
| `macos-skill-library-light-en.png` | Native Skill Library, English Code Review procedure |
| `macos-menubar-usage-light-en.png` | Production Dashboard popover view, compact summary |
| `macos-dashboard-light-en.png` | Production Dashboard popover view, work and run history |
| `chatgpt-settings-light-en.png` | Production Settings HTML in Chromium with a local host fixture |
| `chatgpt-dashboard-light-en.png` | Production Dashboard HTML in Chromium with a local host fixture |

Native captures use isolated copies of the application and fixtures based on
[`native-settings-connection-visual-acceptance.ts`](../../scripts/native-settings-connection-visual-acceptance.ts)
and [`native-skill-library-visual-acceptance.ts`](../../scripts/native-skill-library-visual-acceptance.ts).
Set both the interface preference and sample content to English. Capture the
composed native window with `screencapture`; the Settings sidebar material does
not render completely through `NSView.cacheDisplay`. The Dashboard view is
hosted in an opaque capture window so desktop content does not bleed through.
No operational helper, Tunnel, account login, or Codex task is used.

Browser captures use [`settingsCard.ts`](../../src/settingsCard.ts),
[`dashboardCard.ts`](../../src/dashboardCard.ts), and the shape of
[`card-browser-fixtures.ts`](../../scripts/card-browser-fixtures.ts). Use a local
`window.openai` host adapter with English locale, a 645-pixel viewport, and
sample runtime data. Open Run history before capturing the Dashboard. Capture
the card's `main` element, then check visible labels, layout, and browser errors.

The English role-selection, Connection role, and pairing-invitation images from
the earlier capture set remain applicable. The Korean Settings capture and
unreferenced retired Activity card capture were removed. Historical acceptance
evidence in the audit directories remains separate from this documentation set.
