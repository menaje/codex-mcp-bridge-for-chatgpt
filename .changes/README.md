# Change fragments

Add one JSON file for every user-visible or release-relevant change. File names
must use lower-case letters, digits, dots, underscores, or hyphens and must end
in `.json`.

Each fragment has exactly these fields:

```json
{
  "schemaVersion": 1,
  "releaseUnitId": "codex-mcp-bridge",
  "bump": "patch",
  "summary": "Describe the user-visible change on one line.",
  "breaking": false,
  "migration": null
}
```

Use `minor` for features and structural changes while the product is `0.x`.
A breaking fragment must start its summary with `BREAKING:` and provide a
one-line migration instruction. Active fragments remain in this directory
through all RCs and are consumed only by the stable-promotion command.
