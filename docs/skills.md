# Bridge skill library

Keep procedures you want to reuse in ChatGPT, such as code-review checklists,
release instructions, and project references. A Bridge skill contains your
Markdown instructions and optional reference files, with a version created
for each saved change.

## Create and use your first skill

1. Open the macOS menu-bar popover, select **Skill Library** (the book icon), and choose **New Skill**, or import
   a Markdown file, folder, or ZIP through the **Bridge Skills** menu.
2. Name the skill **Code Review**, add a short description, and use content
   like this for its `SKILL.md`:

   ```markdown
   # Code Review

   Review the requested change in the selected registered project.

   1. Confirm the scope and read the relevant files and project instructions.
   2. Check correctness, error handling, and compatibility.
   3. Run relevant existing checks when needed to verify a finding.
   4. Report actionable findings with file and line references. Explain any
      remaining uncertainty and summarize the checks performed.

   Read [the checklist](guides/checklist.markdown) when it is relevant.
   ```

3. If you keep the relative link, add `guides/checklist.markdown` to the skill.
   Review the import's proposed content, ignored files, and conflicts, then save.
4. In ChatGPT, with the Bridge connection enabled, ask:

   > Find the Bridge skill "Code Review" and read it and its checklist. Use
   > that procedure to review the registered project "Bridge Demo", then
   > report the findings here.

Use your exact registered project name. ChatGPT reads the selected skill version
and relevant files before applying the procedure. Reading a skill does not
start Codex, grant access, or automatically attach its text to every task.
The normal task approval and access settings still apply.

<p align="center">
  <img src="images/macos-skill-library-light-en.png" alt="English Skill Library showing Code Review instructions, Markdown reference files, and the rendered preview" width="820">
</p>

Use preview, edit, or split mode to inspect and edit the complete Markdown
source. **Version History** lets you inspect earlier snapshots, restore one
as a new version, or export a verified snapshot as a ZIP. Archive hides a skill
from ordinary discovery while retaining its history; reactivate it to use it
again. Permanent deletion removes that history after confirmation.

To add files to the selected skill, use **Import into Current Skill**. Dropping
a file, folder, or ZIP starts a new-skill import. A root `SKILL.md` can include
`name` and `description` frontmatter to prefill the import form; the original
source is preserved. Only `.md` and `.markdown` content files are supported.

The native app provides the graphical editor. Model-facing tools can also
create and update the library when the user requests those changes. Bridge
skills are stored in this Bridge library; they are not installed into Codex's
own skill directories.

## Source and task contract

Bridge skills never change the `codex_task` input schema or task admission behavior.

Each immutable version contains one authored `content` value and an optional
tree of independent `.md` or `.markdown` files. The Bridge stores and returns
each Markdown source exactly as supplied: it does not add frontmatter, split a
file into sections or blocks, normalize line endings, or reinterpret the text.
`name` and optional `description` are discovery metadata only. New immutable
versions store skill content as `SKILL.md`.

## Model-facing tools

`bridge_skill` is read-only and has four closed operations:

- `search` finds available Bridge skills by name, description, content,
  attachment path, or attachment content.
- `read` returns one exact immutable version as
  `{ kind: "skill", skill: { name, description, content, files, ... } }`.
  File inventory entries contain a logical relative `path`, byte count, format,
  and content digest—not attachment contents or host paths.
- `read-file` reads one inventory path from that exact `skillId`, `source`, and
  immutable `version`, and verifies its recorded digest before returning it.
- `versions` lists immutable history for one Bridge skill.

`bridge_skill_manage` accepts free-form `content` with `create` and `update`;
an update can atomically upsert and remove attachment paths alongside the skill
content and metadata. `create-package` and `update-package` commit a validated,
expiring upload from a trusted binary adapter. `restore` copies a complete old
snapshot into a new current version, and `set-enabled` archives or reactivates
a skill. The contract has no execution-mode, prerequisite, structured section,
or material-bucket fields.

Read a skill before applying it to a user request. Reading it does not run
anything, start Codex, grant permissions, or inject text into a Codex task.

## Native library management

The dedicated macOS Skill Library window is the graphical authoring surface;
it is not duplicated in Settings. Its native three-column navigation shows skills,
the selected skill's `SKILL.md` content and nested file tree, and a safe rendered
preview or whole-file source editor. Preview/edit/split modes never divide the
stored source into editor blocks. Saving, adding, renaming, or deleting a file
creates one new immutable version of the entire tree.

The same import review accepts internally authored Markdown, Finder file or
folder selection, drag and drop, and ZIP selection or drop. It shows ignored
files and conflicts before commit, requires an explicit source for `SKILL.md`
content for a new multi-file skill, and preserves attachment paths. File,
folder, and ZIP drops always start a new-skill import; adding content to the
selected skill is available only through the explicit **Import into Current
Skill** action. A
root `SKILL.md` takes precedence over legacy `document.md` and other Markdown
files as the suggested content source. Its valid top-level `name` and `description`
frontmatter prefill discovery metadata without changing the stored Markdown;
the selected folder or ZIP name is used only when `name` is absent or invalid.
This compatibility behavior does not install, manage, or couple the package to
Codex skills.

Archive hides a skill from ordinary discovery but retains every version.
Archive/reactivate and permanent-delete icon actions stay fixed at the bottom
of the inspector, have tooltips and accessibility labels, and are disabled
while edits are unsaved or a mutation is running. Permanent deletion is
available only through the native companion API and UI. It uses one destructive
confirmation without typed-name verification, removes every version and active
library receipt, and is not recoverable. The request still requires the exact
`skillId`, `expectedVersion`, and idempotent `requestId`. An exact retry returns
only a minimal deletion tombstone (`skillId`, `source`, `deletedAt`), never deleted
name, description, digest, or Markdown. The model-facing
`bridge_skill_manage` tool intentionally does not expose deletion.

## Compatibility migration

The library reads existing v1/v2 structured records without rewriting them.
When opened, those records are exposed as a lossless Markdown adapter that
contains their former instructions, reference contents, and historical route
or prerequisite metadata. Such a read is marked `legacy: true`.

The library index schema is version 6. New immutable records use kind `skill`,
digest version 5, `contentFile: "SKILL.md"`, and the `content` contract. Existing
v3/v4 records with kind `document`, `documentFile`, `document.md`, or `SKILL.md`
remain readable without being rewritten. Existing v1/v2 structured records use
the lossless legacy Markdown adapter. Updating or restoring an older form writes
a current skill/content record while preserving the original immutable history.
Legacy document terminology is therefore storage compatibility only.

## Bounds and safety

Skill content and each attachment accept up to 3 MiB of valid UTF-8;
attachments total at most 8 MiB across 128 files. Logical relative `/` paths
have bounded length/depth and preserve their supplied Unicode spelling. A
derived NFC, case-folded key rejects paths that would collide without replacing
the stored path. Markdown and paths remain verbatim after Unicode
well-formedness and NUL validation, while human metadata uses the shared
canonical text policy. Local and remote native transport envelopes are 72 MiB
so the complete tree still fits under worst-case JSON escaping. These are
storage/transport bounds, not a prompt-size promise.

ZIP is transport only. Uploads are ordered 512 KiB chunks, expire after ten
minutes, and are consumed once after a successful atomic commit. Inspection
range-reads the central directory and streams bounded entry decompression; it
rejects traversal, invalid UTF-8, encryption, unsupported compression, nested
archives, special files, oversized expansion, extreme ratios, and conflicting
paths. Each immutable version can be exported as a deterministic ZIP rebuilt
from verified stored files. Current exports name skill content `SKILL.md`;
imports continue to accept legacy packages whose content file is
`document.md`. ZIPs from macOS producers are also accepted when a filename's
UTF-8 flag is missing but its bytes decode as strict UTF-8. Finder metadata is
ignored before detecting and removing a common wrapper folder; malformed or
ambiguous non-UTF-8 paths remain rejected.

The native renderer supports headings, paragraphs, lists, quotes, inline links,
fenced code, rules, and GFM-style tables without a web view. Raw HTML and
scripts are inert, every URL open is intercepted, and only relative Markdown
links that resolve to another file in the same immutable version are followed.

## Refresh boundary

The current development build uses local companion protocol 12 and remote
companion protocol 10; see [release inventory](../release-manifest.json).
After an upgrade that changes tools or companion protocols, native clients must
reconnect or restart after upgrading. An installed ChatGPT connector must be
refreshed once and checked in a new conversation. Later skill/file creates,
edits, archives, and deletes change runtime library data only, so those changes
do not require another connector refresh.
