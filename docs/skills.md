# Bridge skill documents

Bridge skills are a Bridge-owned library of reusable, versioned Markdown
documents. They are not Codex skills, are not installed into Codex, and never
change the `codex_task` input schema or task admission behavior.

Each immutable version contains one authored main `document` and an optional
tree of independent `.md` or `.markdown` files. The Bridge stores and returns
each Markdown source exactly as supplied: it does not add frontmatter, split a
file into sections or blocks, normalize line endings, or reinterpret the text.
`name` and optional `description` are discovery metadata only.

## Model-facing tools

`bridge_skill` is read-only and has four closed operations:

- `search` finds available Bridge documents by name, description, main source,
  attachment path, or attachment source.
- `read` returns one exact immutable version's main `document` and its file
  inventory. Inventory entries contain a logical relative `path`, byte count,
  format, and content digest—not file contents or host paths.
- `read-file` reads one inventory path from that exact `skillId`, `source`, and
  immutable `version`, and verifies its recorded digest before returning it.
- `versions` lists immutable history for one Bridge document.

`bridge_skill_manage` accepts free-form text bundles with `create` and `update`;
an update can atomically upsert and remove attachment paths alongside the main
document and metadata. `create-package` and `update-package` commit a validated,
expiring upload from a trusted binary adapter. `restore` copies a complete old
snapshot into a new current version, and `set-enabled` archives or reactivates
a skill. The contract has no execution-mode, prerequisite, structured section,
or material-bucket fields.

Read a document before applying it to a user request. Reading it does not run
anything, start Codex, grant permissions, or inject text into a Codex task.

## Native library management

The dedicated macOS Skill Library window is the only authoring surface; it is
not duplicated in Settings. Its native three-column navigation shows skills,
the selected skill's main document and nested file tree, and a safe rendered
preview or whole-file source editor. Preview/edit/split modes never divide the
stored source into editor blocks. Saving, adding, renaming, or deleting a file
creates one new immutable version of the entire tree.

The same import review accepts internally authored Markdown, Finder file or
folder selection, drag and drop, and ZIP selection or drop. It shows ignored
files and conflicts before commit, requires an explicit main document for a
new multi-file skill, and preserves attachment paths. A root `SKILL.md` is only
a convenient main-document suggestion for importing an existing OpenAI-style
folder; it does not install, manage, or couple the package to Codex skills.

Archive hides a document from ordinary discovery but retains every version.
Permanent deletion is available only through the native companion API and UI;
it requires the user to type the current name, removes every version and
active-library receipt, and is not recoverable. An exact retry returns only a
minimal deletion tombstone (`skillId`, `source`, `deletedAt`), never deleted
name, description, digest, or Markdown. The model-facing
`bridge_skill_manage` tool intentionally does not expose deletion.

## Compatibility migration

The library reads existing v1/v2 structured records without rewriting them.
When opened, those records are exposed as a lossless Markdown adapter that
contains their former instructions, reference contents, and historical route
or prerequisite metadata. Such a read is marked `legacy: true`.

Existing v3 main-only records read with an empty file inventory. Existing
v1/v2 structured records use the lossless legacy Markdown adapter. Updating or
restoring either older form writes a new v4 free-form Markdown tree version;
the original immutable version remains available in history.

## Bounds and safety

The main document and each attachment accept up to 3 MiB of valid UTF-8;
attachments total at most 8 MiB across 128 files. Paths are NFC-canonical
relative `/` paths with bounded length/depth and case-insensitive collision
checks. Markdown remains verbatim source text after Unicode well-formedness and
NUL validation, while human metadata and path identities use the shared text
policy. Local and remote native transport envelopes are 72 MiB so the complete
tree still fits under worst-case JSON escaping. These are storage/transport
bounds, not a prompt-size promise.

ZIP is transport only. Uploads are ordered 512 KiB chunks, expire after ten
minutes, and are consumed once after a successful atomic commit. Inspection
range-reads the central directory and streams bounded entry decompression; it
rejects traversal, invalid UTF-8, encryption, unsupported compression, nested
archives, special files, oversized expansion, extreme ratios, and conflicting
paths. Each immutable version can be exported as a deterministic ZIP rebuilt
from verified stored files.

The native renderer supports headings, paragraphs, lists, quotes, inline links,
fenced code, rules, and GFM-style tables without a web view. Raw HTML and
scripts are inert, every URL open is intercepted, and only relative Markdown
links that resolve to another file in the same immutable version are followed.

## Refresh boundary

This release changes the MCP tool schema and companion protocols, so an
installed ChatGPT connector must be refreshed once and checked in a new
conversation. Later skill/file creates, edits, archives, and deletes change
runtime library data only. The model discovers that data with `search`/`read`,
so those changes do not require another connector refresh.
