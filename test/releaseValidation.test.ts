import { describe, expect, it } from "vitest";
import {
  affectedValidationPlan,
  classifyChangedPaths
} from "../scripts/release-validation.mjs";

describe("release validation levels", () => {
  it("keeps documentation and change fragments on the fast validation level", () => {
    expect(classifyChangedPaths(["README.md", ".changes/fix.json"])).toEqual({
      node: false,
      macos: false
    });
    expect(affectedValidationPlan(["docs/releasing.md"]).commands).toHaveLength(1);
  });

  it("routes Node and Swift-owned paths to their affected checks", () => {
    expect(classifyChangedPaths(["src/server.ts"])).toEqual({ node: true, macos: false });
    expect(classifyChangedPaths(["macos/Sources/App.swift"])).toEqual({ node: false, macos: true });
    expect(classifyChangedPaths(["release-manifest.json"])).toEqual({ node: true, macos: true });

    const plan = affectedValidationPlan(["src/server.ts", "macos/Sources/App.swift"]);
    expect(plan.commands).toEqual([
      ["npm", ["run", "validate:fast"]],
      ["npm", ["run", "check"]],
      ["npm", ["run", "macos:check"]]
    ]);
  });
});
