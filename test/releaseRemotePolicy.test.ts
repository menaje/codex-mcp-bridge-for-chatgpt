import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("repository release rulesets", () => {
  it("requires pull-request promotion and immutable main history", () => {
    const main = ruleset("main.json");
    expect(main.target).toBe("branch");
    expect(main.enforcement).toBe("active");
    expect(main.conditions.ref_name.include).toEqual(["refs/heads/main"]);
    expect(ruleTypes(main)).toEqual(expect.arrayContaining([
      "deletion",
      "non_fast_forward",
      "pull_request",
      "required_status_checks"
    ]));
    expect(main.rules.find((rule: any) => rule.type === "pull_request").parameters.required_approving_review_count)
      .toBe(0);
    expect(main.rules.find((rule: any) => rule.type === "required_status_checks").parameters).toEqual({
      do_not_enforce_on_create: false,
      required_status_checks: [{ context: "Stable promotion gate" }],
      strict_required_status_checks_policy: true
    });
  });

  it("protects dev while keeping short-lived release branches deletable", () => {
    const dev = ruleset("dev.json");
    expect(dev.conditions.ref_name.include).toEqual(["refs/heads/dev"]);
    expect(ruleTypes(dev)).toEqual(["deletion", "non_fast_forward"]);

    const release = ruleset("release.json");
    expect(release.conditions.ref_name.include).toEqual(["refs/heads/release/*"]);
    expect(ruleTypes(release)).toEqual(["non_fast_forward"]);
  });

  it("allows new version tags but rejects moving or deleting existing ones", () => {
    const tags = ruleset("tags.json");
    expect(tags.target).toBe("tag");
    expect(tags.conditions.ref_name.include).toEqual(["refs/tags/v*"]);
    expect(ruleTypes(tags)).toEqual(["deletion", "non_fast_forward"]);
    expect(ruleTypes(tags)).not.toContain("creation");
  });
});

function ruleset(name: string): any {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, ".github/rulesets", name), "utf8"));
}

function ruleTypes(value: any): string[] {
  return value.rules.map((rule: any) => rule.type);
}
