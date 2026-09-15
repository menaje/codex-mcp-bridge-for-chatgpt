# Bridge skill documents

Bridge skills are a Bridge-owned library of reusable, versioned Markdown
documents. They are not Codex skills, are not installed into Codex, and never
change the `codex_task` input schema or task admission behavior.

Each version has one authored `document` field. The Bridge stores and returns
that Markdown source exactly as supplied: it does not add frontmatter, split
it into instructions and references, normalize line endings, or reinterpret
the text. `name` and optional `description` are discovery metadata only.

## Model-facing tools

`bridge_skill` is read-only and has three closed operations:

- `search` finds available Bridge documents by name, description, or authored
  Markdown text.
- `read` returns one exact immutable version as `{ document, format:
  "markdown" }`.
- `versions` lists immutable history for one Bridge document.

`bridge_skill_manage` has four append-safe lifecycle operations: `create`,
`update`, `restore`, and `set-enabled`. It accepts only Bridge document
metadata and `document`; it has no execution-mode, prerequisite, reference,
or material-bucket fields.

Read a document before applying it to a user request. Reading it does not run
anything, start Codex, grant permissions, or inject text into a Codex task.

## Native library management

The macOS Bridge Skills window is the authoring surface. Selecting an item
opens rendered Markdown. Editing stays in the same detail surface, with the
source editor and a live rendered preview side by side. Saving creates a new
immutable document version.

Archive hides a document from ordinary discovery but retains every version.
Permanent deletion is available only through the native companion API and UI;
it requires the user to type the current name, removes every version, and is
not recoverable. The model-facing `bridge_skill_manage` tool intentionally
does not expose deletion.

## Compatibility migration

The library reads existing v1/v2 structured records without rewriting them.
When opened, those records are exposed as a lossless Markdown adapter that
contains their former instructions, reference contents, and historical route
or prerequisite metadata. Such a read is marked `legacy: true`.

Updating or restoring a legacy record writes a new v3 free-form Markdown
version. The original immutable version remains available in history.

## Bounds and safety

`document` accepts up to 3 MiB of UTF-8 text. Bridge transports and model
result envelopes allow up to 8 MiB so JSON escaping cannot silently reduce
that source capacity. This is not a prompt-size promise and does not bypass
normal MCP host limits. NUL-containing text is rejected. The native renderer
displays Markdown as text and does not execute embedded HTML or scripts.
