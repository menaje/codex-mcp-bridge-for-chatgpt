import { describe, expect, it } from "vitest";
import {
  canonicalizeDecisionSubmission,
  prepareDecisionCardContent
} from "../src/decisionCardContent.js";

describe("free-form decision card content", () => {
  it("keeps varied semantic HTML and native controls while removing executable authority", () => {
    const prepared = prepareDecisionCardContent(`
      <article style="display:grid;grid-template-columns:1fr 1fr;gap:12px;background:url(https://bad.example/x)">
        <h2>Migration choice</h2>
        <script>steal()</script>
        <img src="https://bad.example/chart.png" onerror="steal()" alt="remote" />
        <table><thead><tr><th>Plan</th><th>Risk</th></tr></thead><tbody><tr><td>Staged</td><td>Low</td></tr></tbody></table>
        <svg viewBox="0 0 100 20" aria-label="Risk comparison"><rect width="70" height="8" fill="#16875a" /></svg>
        <label for="plan">Migration plan</label>
        <select id="plan" name="plan" required>
          <option value="staged">Staged transition</option>
          <option value="rewrite">Immediate rewrite</option>
        </select>
        <label>Budget <input name="budget" type="range" min="1" max="12" step="1" data-decision-unit="weeks" /></label>
        <output data-decision-output-for="budget"></output>
        <label><input name="compatibility" type="checkbox" /> Preserve compatibility</label>
        <label>Conditions <textarea name="conditions" maxlength="500"></textarea></label>
      </article>
    `);

    expect(prepared.html).toContain("<table>");
    expect(prepared.html).toContain("<svg");
    expect(prepared.html).toContain("data-decision-output-for=\"budget\"");
    expect(prepared.html).not.toContain("script");
    expect(prepared.html).not.toContain("onerror");
    expect(prepared.html).not.toContain("bad.example");
    expect(prepared.html).not.toContain("background:url");
    expect(prepared.fields).toEqual([
      expect.objectContaining({ name: "plan", label: "Migration plan", kind: "choice", required: true }),
      expect.objectContaining({ name: "budget", label: "Budget", kind: "range", min: 1, max: 12, step: 1, unit: "weeks" }),
      expect.objectContaining({ name: "compatibility", label: "Preserve compatibility", kind: "boolean" }),
      expect.objectContaining({ name: "conditions", label: "Conditions", kind: "text", maxLength: 500 })
    ]);
    expect(prepared.policy).toMatchObject({
      scripts: "blocked",
      eventHandlers: "blocked",
      externalNetwork: "blocked",
      images: "data-raster-only"
    });
  });

  it("removes CSS-escaped resource loads from inline styles and SVG paint", () => {
    const prepared = prepareDecisionCardContent(String.raw`
      <article style="display:grid;background:u\72l(https://bad.example/style.png);color:#123456">
        <h2>Escaped CSS</h2>
        <svg viewBox="0 0 100 20" aria-label="Escaped paint checks">
          <defs><linearGradient id="safeGradient"><stop offset="0" stop-color="#fff" /></linearGradient></defs>
          <rect id="blocked-fill" width="30" height="10" fill="u\72l(https://bad.example/fill.svg)" />
          <path id="blocked-stroke" d="M0 0 L30 10" stroke="\75 rl(https://bad.example/stroke.svg)" />
          <rect id="safe-fill" x="35" width="30" height="10" fill="url(#safeGradient)" />
        </svg>
      </article>
    `);

    expect(prepared.html).toContain("display:grid");
    expect(prepared.html).toContain("color:#123456");
    expect(prepared.html).toContain('id="safe-fill"');
    expect(prepared.html).toContain('fill="url(#safeGradient)"');
    expect(prepared.html).not.toContain("bad.example");
    expect(prepared.html).not.toMatch(/background\s*:/i);
    expect(prepared.html).not.toMatch(/(?:fill|stroke)="[^\"]*\\/i);
  });

  it("normalizes CSS tokens before accepting only non-loading value functions", () => {
    const unsafeBackgrounds = [
      String.raw`u\72l(https://bad.example/a)`,
      String.raw`U\000072L(https://bad.example/b)`,
      String.raw`\75\72\6c(https://bad.example/c)`,
      String.raw`u/**/rl(https://bad.example/d)`,
      String.raw`u\72l/**/(https://bad.example/e)`,
      String.raw`image\2d set(u\72l(https://bad.example/f) 1x)`,
      String.raw`linear-gradient(#fff,#000),u\72l(https://bad.example/g)`,
      "var(--host-image)"
    ];
    for (const background of unsafeBackgrounds) {
      const prepared = prepareDecisionCardContent(
        `<div style="display:grid;background:${background};color:rgb(1 2 3 / .8)">Safe text</div>`
      );
      expect(prepared.html, background).toContain("display:grid");
      expect(prepared.html, background).toContain("color:rgb(1 2 3 / .8)");
      expect(prepared.html, background).not.toContain("background:");
      expect(prepared.html, background).not.toContain("bad.example");
    }

    const escapedProperty = prepareDecisionCardContent(String.raw`
      <div style="b\61ckground:u\72l(https://bad.example/property.png);c\6flor:#123456;display:grid">
        Escaped properties
      </div>
    `);
    expect(escapedProperty.html).toContain("color:#123456");
    expect(escapedProperty.html).toContain("display:grid");
    expect(escapedProperty.html).not.toContain("background:");
    expect(escapedProperty.html).not.toContain("bad.example");

    const safe = prepareDecisionCardContent(`
      <div style="background:linear-gradient(90deg,#fff,#000);width:calc(100% - 1rem);grid-template-columns:repeat(2,minmax(0,1fr))">
        Safe presentation functions
      </div>
    `);
    expect(safe.html).toContain("background:linear-gradient(90deg,#fff,#000)");
    expect(safe.html).toContain("width:calc(100% - 1rem)");
    expect(safe.html).toContain("grid-template-columns:repeat(2,minmax(0,1fr))");
  });

  it("derives semantic labels and rejects values that were never displayed", () => {
    const prepared = prepareDecisionCardContent(`
      <fieldset><legend>Release strategy</legend>
        <label><input type="radio" name="strategy" value="canary" required /> Canary</label>
        <label><input type="radio" name="strategy" value="big-bang" /> Big bang</label>
      </fieldset>
      <fieldset><legend>Required safeguards</legend>
        <label><input type="checkbox" name="guard" value="rollback" /> Rollback plan</label>
        <label><input type="checkbox" name="guard" value="backup" /> Verified backup</label>
      </fieldset>
    `);
    expect(prepared.fields).toEqual([
      expect.objectContaining({
        name: "strategy",
        label: "Release strategy",
        kind: "choice",
        options: [
          { value: "canary", label: "Canary" },
          { value: "big-bang", label: "Big bang" }
        ]
      }),
      expect.objectContaining({
        name: "guard",
        label: "Required safeguards",
        kind: "multi-choice",
        options: [
          { value: "rollback", label: "Rollback plan" },
          { value: "backup", label: "Verified backup" }
        ]
      })
    ]);

    const decision = canonicalizeDecisionSubmission(prepared.fields, {
      intent: "confirm",
      fields: [
        { name: "strategy", values: ["canary"] },
        { name: "guard", values: ["rollback", "backup"] }
      ],
      comment: "Keep the previous release available."
    });
    expect(decision.summary).toContain("Release strategy: Canary");
    expect(decision.summary).toContain("Rollback plan, Verified backup");
    expect(() => canonicalizeDecisionSubmission(prepared.fields, {
      intent: "confirm",
      fields: [
        { name: "strategy", values: ["hidden-value"] },
        { name: "guard", values: [] }
      ]
    })).toThrow(/DECISION_OPTION_INVALID/);
  });

  it("supports a natural-language-only card without inventing a questionnaire", () => {
    const prepared = prepareDecisionCardContent(`
      <section><h2>What changes</h2><p>The rollout stays reversible for seven days.</p></section>
    `);
    expect(prepared.fields).toEqual([]);
    expect(canonicalizeDecisionSubmission(prepared.fields, {
      intent: "request-explanation",
      fields: [],
      comment: "Explain the rollback trigger first."
    }).summary).toBe("Intent: More explanation requested\nUser note: Explain the rollback trigger first.");
  });

  it("requires a visible semantic label for every submitted control", () => {
    expect(() => prepareDecisionCardContent('<input name="opaque" value="B" />'))
      .toThrow(/DECISION_FIELD_LABEL_REQUIRED/);
    expect(() => prepareDecisionCardContent(`
      <label><input type="radio" name="plan" value="a" /> Plan A</label>
      <label><input type="radio" name="plan" value="b" /> Plan B</label>
    `)).toThrow(/DECISION_FIELD_GROUP_LABEL_REQUIRED/);
  });

  it("allows defer and explanation without a final choice but validates confirmed numeric meaning", () => {
    const prepared = prepareDecisionCardContent(`
      <fieldset><legend>Release strategy</legend>
        <label><input type="radio" name="strategy" value="canary" required /> Canary</label>
        <label><input type="radio" name="strategy" value="direct" /> Direct</label>
      </fieldset>
      <label>Batch size <input type="number" name="batch" min="2" max="10" step="2" required /></label>
    `);

    expect(canonicalizeDecisionSubmission(prepared.fields, {
      intent: "request-explanation",
      fields: [
        { name: "strategy", values: [] },
        { name: "batch", values: [] }
      ]
    }).summary).toContain("More explanation requested");
    expect(() => canonicalizeDecisionSubmission(prepared.fields, {
      intent: "confirm",
      fields: [
        { name: "strategy", values: [] },
        { name: "batch", values: ["4"] }
      ]
    })).toThrow(/DECISION_FIELD_REQUIRED/);
    expect(() => canonicalizeDecisionSubmission(prepared.fields, {
      intent: "confirm",
      fields: [
        { name: "strategy", values: ["canary"] },
        { name: "batch", values: ["3"] }
      ]
    })).toThrow(/DECISION_NUMBER_STEP_INVALID/);
    expect(() => canonicalizeDecisionSubmission(prepared.fields, {
      intent: "confirm",
      fields: [
        { name: "strategy", values: ["canary"] },
        { name: "batch", values: [" "] }
      ]
    })).toThrow(/DECISION_FIELD_INVALID/);
  });
});
