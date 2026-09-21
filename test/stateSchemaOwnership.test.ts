import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { BridgeStateStore } from "../src/stateStore.js";

describe("state schema ownership catalog", () => {
  it("names every current table, explicit index and trigger", () => {
    const root = mkdtempSync(path.join(tmpdir(), "state-schema-ownership-"));
    const file = path.join(root, "state.sqlite");
    const store = new BridgeStateStore({ file });
    store.close();
    const database = new Database(file, { readonly: true });
    try {
      const catalog = readFileSync(
        new URL("../docs/state-schema-ownership-catalog.md", import.meta.url),
        "utf8"
      );
      const objects = database.prepare(`
        SELECT type, name, tbl_name AS tableName
          FROM sqlite_master
         WHERE type IN ('table', 'index', 'trigger')
           AND name NOT LIKE 'sqlite_%'
         ORDER BY type, name
      `).all() as Array<{ type: string; name: string; tableName: string }>;
      expect(objects.length).toBeGreaterThan(0);
      for (const object of objects) {
        expect(catalog, `${object.type} ${object.name} is missing from the ownership catalog`)
          .toContain(`\`${object.name}\``);
        expect(catalog, `${object.type} ${object.name} has an uncatalogued parent table`)
          .toContain(`\`${object.tableName}\``);
      }
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
