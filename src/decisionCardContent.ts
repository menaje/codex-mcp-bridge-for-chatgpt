import { createHash } from "node:crypto";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import postcss from "postcss";
import valueParser from "postcss-value-parser";
import sanitizeHtml from "sanitize-html";
import { assertJsonTextIntegrity, assertWellFormedUnicode } from "./textIntegrity.js";

export const DECISION_CARD_HTML_MAX_BYTES = 96 * 1_024;
export const DECISION_CARD_MAX_FIELDS = 64;
export const DECISION_CARD_MAX_OPTIONS = 100;
export const DECISION_CARD_TEXT_VALUE_MAX_CHARACTERS = 4_000;
export const DECISION_CARD_COMMENT_MAX_CHARACTERS = 4_000;

export const DECISION_INTENTS = [
  "confirm",
  "request-explanation",
  "defer"
] as const;
export type DecisionIntent = (typeof DECISION_INTENTS)[number];

export const DECISION_FIELD_KINDS = [
  "text",
  "number",
  "range",
  "choice",
  "multi-choice",
  "boolean"
] as const;
export type DecisionFieldKind = (typeof DECISION_FIELD_KINDS)[number];

export type DecisionOptionDefinition = {
  value: string;
  label: string;
};

export type DecisionFieldDefinition = {
  name: string;
  label: string;
  kind: DecisionFieldKind;
  required: boolean;
  options?: DecisionOptionDefinition[];
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  maxLength?: number;
};

export type PreparedDecisionCardContent = {
  html: string;
  contentDigest: string;
  fields: DecisionFieldDefinition[];
  policy: {
    scripts: "blocked";
    eventHandlers: "blocked";
    externalNetwork: "blocked";
    images: "data-raster-only";
    generatedInteraction: "native-inputs-and-trusted-output-binding-only";
  };
};

export type SubmittedDecisionField = {
  name: string;
  values: string[];
};

export type CanonicalDecisionSelection = {
  name: string;
  label: string;
  kind: DecisionFieldKind;
  values: Array<{ value: string; label: string }>;
  unit?: string;
};

export type CanonicalDecision = {
  intent: DecisionIntent;
  selections: CanonicalDecisionSelection[];
  comment?: string;
  summary: string;
  digest: string;
};

type HtmlElement = DefaultTreeAdapterMap["element"];
type HtmlNode = DefaultTreeAdapterMap["node"];

const DECISION_STYLE_MAX_CHARACTERS = 8_192;
const DECISION_STYLE_MAX_DECLARATIONS = 64;
const DECISION_STYLE_VALUE_MAX_CHARACTERS = 500;
const ALLOWED_STYLE_PROPERTIES = [
  "align-items", "background", "background-color", "border", "border-color", "border-radius",
  "border-style", "border-width", "color", "display", "flex", "flex-basis", "flex-direction",
  "flex-grow", "flex-shrink", "flex-wrap", "font-family", "font-size", "font-style",
  "font-weight", "gap", "grid-column", "grid-row", "grid-template-columns", "height",
  "justify-content", "line-height", "margin", "margin-bottom", "margin-left", "margin-right",
  "margin-top", "max-height", "max-width", "min-height", "min-width", "object-fit", "opacity",
  "overflow", "overflow-wrap", "padding", "padding-bottom", "padding-left", "padding-right",
  "padding-top", "text-align", "text-decoration", "vertical-align", "white-space", "width"
] as const;
const ALLOWED_STYLE_PROPERTY_SET = new Set<string>(ALLOWED_STYLE_PROPERTIES);
const SAFE_STYLE_VALUE = /^[\s\S]{0,500}$/;
const SAFE_CSS_COLOR_FUNCTIONS = new Set([
  "color", "color-mix", "hsl", "hsla", "hwb", "lab", "lch", "light-dark",
  "oklab", "oklch", "rgb", "rgba"
]);
const SAFE_CSS_STYLE_FUNCTIONS = new Set([
  ...SAFE_CSS_COLOR_FUNCTIONS,
  "abs", "calc", "clamp", "conic-gradient", "fit-content", "linear-gradient", "max", "min",
  "minmax", "mod", "radial-gradient", "rem", "repeat", "repeating-conic-gradient",
  "repeating-linear-gradient", "repeating-radial-gradient", "round", "sign"
]);
const UNSAFE_NORMALIZED_CSS = /(?:\b(?:url|image|image-set|-webkit-image-set|cross-fade|element|paint|expression)\s*\(|@import|javascript\s*:|behavior\s*:|-[a-z0-9-]+-binding)/i;
const SAFE_DATA_RASTER_IMAGE = /^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/]+={0,2}$/i;
const DECISION_FIELD_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const ALLOWED_INPUT_TYPES = new Set([
  "text",
  "email",
  "url",
  "tel",
  "date",
  "time",
  "datetime-local",
  "month",
  "week",
  "color",
  "number",
  "range",
  "radio",
  "checkbox"
]);

function decodeCssEscapes(value: string): string {
  let decoded = "";
  for (let index = 0; index < value.length;) {
    if (value[index] !== "\\") {
      decoded += value[index];
      index += 1;
      continue;
    }
    index += 1;
    if (index >= value.length) {
      decoded += "\uFFFD";
      break;
    }
    const next = value[index]!;
    if (next === "\r" || next === "\n" || next === "\f") {
      if (next === "\r" && value[index + 1] === "\n") index += 1;
      index += 1;
      continue;
    }
    if (/[0-9a-f]/i.test(next)) {
      let hex = "";
      while (index < value.length && hex.length < 6 && /[0-9a-f]/i.test(value[index]!)) {
        hex += value[index];
        index += 1;
      }
      if (index < value.length && /[\t\n\f\r ]/.test(value[index]!)) {
        if (value[index] === "\r" && value[index + 1] === "\n") index += 1;
        index += 1;
      }
      const codePoint = Number.parseInt(hex, 16);
      decoded += codePoint === 0 || codePoint > 0x10FFFF || codePoint >= 0xD800 && codePoint <= 0xDFFF
        ? "\uFFFD"
        : String.fromCodePoint(codePoint);
      continue;
    }
    decoded += next;
    index += 1;
  }
  return decoded;
}

function cssWithoutComments(value: string): string | undefined {
  const parsed = valueParser(value);
  let malformed = false;
  parsed.walk((node) => {
    if ("unclosed" in node && node.unclosed) malformed = true;
  });
  if (malformed) return undefined;
  return valueParser.stringify(parsed.nodes, (node) => node.type === "comment" ? "" : undefined);
}

function sanitizeCssValue(
  rawValue: string,
  allowedFunctions: ReadonlySet<string>
): string | undefined {
  if (rawValue.length > DECISION_STYLE_VALUE_MAX_CHARACTERS) return undefined;
  const uncommented = cssWithoutComments(rawValue);
  if (uncommented === undefined) return undefined;
  const parsed = valueParser(uncommented);
  let unsafe = false;
  parsed.walk((node) => {
    if ("unclosed" in node && node.unclosed) {
      unsafe = true;
      return;
    }
    if (node.type === "function") {
      const name = decodeCssEscapes(node.value).toLowerCase();
      if (!/^[a-z][a-z0-9-]*$/.test(name) || !allowedFunctions.has(name)) {
        unsafe = true;
        return;
      }
      node.value = name;
      return;
    }
    if (node.type === "word" || node.type === "unicode-range") {
      const normalizedWord = decodeCssEscapes(node.value);
      if (/[\u0000-\u0008\u000B\u000E-\u001F\u007F]/.test(normalizedWord) ||
        UNSAFE_NORMALIZED_CSS.test(normalizedWord)) unsafe = true;
    }
  });
  if (unsafe) return undefined;
  const canonical = valueParser.stringify(parsed.nodes).trim();
  if (!canonical || canonical.length > DECISION_STYLE_VALUE_MAX_CHARACTERS) return undefined;
  const normalized = decodeCssEscapes(canonical);
  if (UNSAFE_NORMALIZED_CSS.test(normalized)) return undefined;
  return canonical;
}

function sanitizeInlineStyle(style: string): string | undefined {
  if (style.length > DECISION_STYLE_MAX_CHARACTERS) return undefined;
  try {
    const root = postcss.parse(`decision-card{${style}}`, { from: undefined });
    if (root.nodes.length !== 1 || root.first?.type !== "rule" ||
      root.first.selector !== "decision-card" ||
      root.first.nodes.length > DECISION_STYLE_MAX_DECLARATIONS) return undefined;
    const declarations: string[] = [];
    for (const node of root.first.nodes) {
      if (node.type !== "decl") continue;
      const property = decodeCssEscapes(node.prop).trim().toLowerCase();
      if (!ALLOWED_STYLE_PROPERTY_SET.has(property)) continue;
      const value = sanitizeCssValue(node.value, SAFE_CSS_STYLE_FUNCTIONS);
      if (value !== undefined) declarations.push(`${property}:${value}`);
    }
    return declarations.join(";") || undefined;
  } catch {
    return undefined;
  }
}

function sanitizeStyleAttribute(
  tagName: string,
  attributes: sanitizeHtml.Attributes
): sanitizeHtml.Tag {
  const attribs: sanitizeHtml.Attributes = { ...attributes };
  if (attribs.style !== undefined) {
    const style = sanitizeInlineStyle(attribs.style);
    if (style) attribs.style = style;
    else delete attribs.style;
  }
  return { tagName, attribs };
}

function sanitizeSvgPaint(value: string): string | undefined {
  const uncommented = cssWithoutComments(value);
  if (uncommented === undefined) return undefined;
  const normalized = decodeCssEscapes(uncommented).trim();
  const localReference = /^url\(\s*#([A-Za-z][A-Za-z0-9_.:-]{0,127})\s*\)$/i.exec(normalized);
  if (localReference) return `url(#${localReference[1]})`;
  return sanitizeCssValue(value, SAFE_CSS_COLOR_FUNCTIONS);
}

function sanitizeSvgPaintAttributes(
  tagName: string,
  attributes: sanitizeHtml.Attributes
): sanitizeHtml.Tag {
  const attribs: sanitizeHtml.Attributes = {};
  for (const [name, value] of Object.entries(attributes)) {
    if (name === "fill" || name === "stroke") {
      const paint = sanitizeSvgPaint(value);
      if (paint !== undefined) attribs[name] = paint;
    } else attribs[name] = value;
  }
  return { tagName, attribs };
}

const DECISION_HTML_POLICY: sanitizeHtml.IOptions = {
  allowedTags: [
    "article", "aside", "blockquote", "br", "caption", "code", "col", "colgroup",
    "dd", "details", "div", "dl", "dt", "em", "fieldset", "figcaption", "figure",
    "form", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "img", "input", "label",
    "legend", "li", "mark", "meter", "ol", "optgroup", "option", "output", "p",
    "pre", "progress", "section", "select", "small", "span", "strong", "sub", "summary",
    "sup", "table", "tbody", "td", "textarea", "tfoot", "th", "thead", "tr", "ul",
    "svg", "g", "defs", "lineargradient", "radialgradient", "stop", "path", "circle",
    "ellipse", "line", "polyline", "polygon", "rect", "text", "tspan", "title", "desc"
  ],
  allowedAttributes: {
    "*": [
      "class", "id", "role", "style", "title", "dir", "lang", "aria-*",
      "data-decision-label", "data-decision-unit", "data-decision-output-for"
    ],
    col: ["span", "width"],
    colgroup: ["span", "width"],
    details: ["open"],
    img: ["src", "alt", "width", "height"],
    input: [
      "type", "name", "value", "placeholder", "checked", "required", "min", "max",
      "step", "minlength", "maxlength", "autocomplete", "inputmode", "disabled", "readonly"
    ],
    label: ["for"],
    meter: ["value", "min", "max", "low", "high", "optimum"],
    option: ["value", "selected", "disabled", "label"],
    optgroup: ["label", "disabled"],
    output: ["for", "name"],
    progress: ["value", "max"],
    select: ["name", "multiple", "required", "disabled"],
    td: ["colspan", "rowspan", "headers"],
    textarea: [
      "name", "placeholder", "required", "minlength", "maxlength", "rows", "cols",
      "autocomplete", "disabled", "readonly"
    ],
    th: ["colspan", "rowspan", "headers", "scope"],
    svg: ["viewbox", "width", "height", "preserveaspectratio", "aria-label"],
    g: ["transform", "fill", "stroke", "stroke-width", "opacity"],
    lineargradient: ["id", "x1", "x2", "y1", "y2", "gradientunits"],
    radialgradient: ["id", "cx", "cy", "r", "fx", "fy", "gradientunits"],
    stop: ["offset", "stop-color", "stop-opacity"],
    path: ["d", "fill", "stroke", "stroke-width", "opacity", "transform"],
    circle: ["cx", "cy", "r", "fill", "stroke", "stroke-width", "opacity"],
    ellipse: ["cx", "cy", "rx", "ry", "fill", "stroke", "stroke-width", "opacity"],
    line: ["x1", "x2", "y1", "y2", "stroke", "stroke-width", "opacity"],
    polyline: ["points", "fill", "stroke", "stroke-width", "opacity"],
    polygon: ["points", "fill", "stroke", "stroke-width", "opacity"],
    rect: ["x", "y", "width", "height", "rx", "ry", "fill", "stroke", "stroke-width", "opacity"],
    text: ["x", "y", "dx", "dy", "fill", "font-size", "font-weight", "text-anchor", "transform"],
    tspan: ["x", "y", "dx", "dy", "fill", "font-size", "font-weight", "text-anchor"]
  },
  allowedStyles: {
    "*": Object.fromEntries(ALLOWED_STYLE_PROPERTIES.map((property) => [property, [SAFE_STYLE_VALUE]]))
  },
  allowedSchemes: ["data"],
  allowedSchemesByTag: { img: ["data"] },
  allowedSchemesAppliedToAttributes: ["src"],
  allowProtocolRelative: false,
  disallowedTagsMode: "completelyDiscard",
  nestingLimit: 40,
  parseStyleAttributes: true,
  exclusiveFilter: (frame) => frame.tag === "img" && !SAFE_DATA_RASTER_IMAGE.test(frame.attribs.src || ""),
  transformTags: {
    "*": sanitizeStyleAttribute,
    input: (tagName, attributes): sanitizeHtml.Tag => {
      const type = String(attributes.type || "text").toLowerCase();
      if (ALLOWED_INPUT_TYPES.has(type)) {
        const attribs: sanitizeHtml.Attributes = { ...attributes, type };
        return { tagName, attribs };
      }
      return { tagName: "span", attribs: {} };
    },
    form: (tagName, attributes) => ({
      tagName,
      attribs: Object.fromEntries(Object.entries(attributes).filter(([name]) =>
        name === "class" || name === "id" || name === "role" || name === "style" ||
        name === "title" || name.startsWith("aria-") || name.startsWith("data-decision-")
      ))
    }),
    g: sanitizeSvgPaintAttributes,
    path: sanitizeSvgPaintAttributes,
    circle: sanitizeSvgPaintAttributes,
    ellipse: sanitizeSvgPaintAttributes,
    line: sanitizeSvgPaintAttributes,
    polyline: sanitizeSvgPaintAttributes,
    polygon: sanitizeSvgPaintAttributes,
    rect: sanitizeSvgPaintAttributes,
    text: sanitizeSvgPaintAttributes,
    tspan: sanitizeSvgPaintAttributes
  }
};

export function prepareDecisionCardContent(rawHtml: string): PreparedDecisionCardContent {
  assertWellFormedUnicode(rawHtml, "Decision card HTML");
  if (Buffer.byteLength(rawHtml, "utf8") > DECISION_CARD_HTML_MAX_BYTES) {
    throw new Error(`DECISION_HTML_TOO_LARGE: HTML must be at most ${DECISION_CARD_HTML_MAX_BYTES} UTF-8 bytes.`);
  }
  const html = sanitizeHtml(rawHtml, DECISION_HTML_POLICY).trim();
  if (!html) throw new Error("DECISION_HTML_EMPTY: The sanitized decision card is empty.");
  if (Buffer.byteLength(html, "utf8") > DECISION_CARD_HTML_MAX_BYTES) {
    throw new Error(`DECISION_HTML_TOO_LARGE: Sanitized HTML must be at most ${DECISION_CARD_HTML_MAX_BYTES} UTF-8 bytes.`);
  }
  const fields = extractDecisionFields(html);
  const contentDigest = createHash("sha256").update(html).update("\0")
    .update(stableJson(fields)).digest("hex");
  const prepared: PreparedDecisionCardContent = {
    html,
    contentDigest,
    fields,
    policy: {
      scripts: "blocked",
      eventHandlers: "blocked",
      externalNetwork: "blocked",
      images: "data-raster-only",
      generatedInteraction: "native-inputs-and-trusted-output-binding-only"
    }
  };
  assertJsonTextIntegrity(prepared, "Prepared decision card content");
  return prepared;
}

export function canonicalizeDecisionSubmission(
  definitions: readonly DecisionFieldDefinition[],
  input: {
    intent: DecisionIntent;
    fields: readonly SubmittedDecisionField[];
    comment?: string;
  }
): CanonicalDecision {
  if (!DECISION_INTENTS.includes(input.intent)) {
    throw new Error("DECISION_INTENT_INVALID: Choose a supported decision action.");
  }
  const supplied = new Map<string, string[]>();
  for (const field of input.fields) {
    if (supplied.has(field.name)) throw new Error(`DECISION_FIELD_DUPLICATE: ${field.name}.`);
    if (!definitions.some((definition) => definition.name === field.name)) {
      throw new Error(`DECISION_FIELD_UNKNOWN: ${field.name}.`);
    }
    if (!Array.isArray(field.values) || field.values.length > DECISION_CARD_MAX_OPTIONS) {
      throw new Error(`DECISION_FIELD_INVALID: ${field.name} has too many values.`);
    }
    supplied.set(field.name, field.values.map((value) => boundedDecisionText(value, field.name)));
  }

  const selections: CanonicalDecisionSelection[] = definitions.map((definition) => {
    const values = supplied.get(definition.name) || [];
    if (definition.required && input.intent === "confirm" && values.length === 0) {
      throw new Error(`DECISION_FIELD_REQUIRED: ${definition.label}.`);
    }
    if (values.some((value) => value.trim().length === 0)) {
      throw new Error(`DECISION_FIELD_INVALID: ${definition.label} contains an empty value.`);
    }
    let canonicalValues: Array<{ value: string; label: string }>;
    if (definition.kind === "choice" || definition.kind === "multi-choice") {
      if (definition.kind === "choice" && values.length > 1) {
        throw new Error(`DECISION_FIELD_INVALID: ${definition.label} accepts one value.`);
      }
      if (new Set(values).size !== values.length) {
        throw new Error(`DECISION_FIELD_INVALID: ${definition.label} contains duplicate values.`);
      }
      canonicalValues = values.map((value) => {
        const option = definition.options?.find((candidate) => candidate.value === value);
        if (!option) throw new Error(`DECISION_OPTION_INVALID: ${definition.label}.`);
        return { value, label: option.label };
      });
    } else if (definition.kind === "boolean") {
      if (values.length > 1 || values.some((value) => value !== "true")) {
        throw new Error(`DECISION_FIELD_INVALID: ${definition.label} must be selected or clear.`);
      }
      canonicalValues = values.length ? [{ value: "true", label: "Yes" }] : [{ value: "false", label: "No" }];
    } else if (definition.kind === "number" || definition.kind === "range") {
      if (values.length > 1) throw new Error(`DECISION_FIELD_INVALID: ${definition.label} accepts one value.`);
      canonicalValues = values.map((value) => {
        const number = Number(value);
        if (!Number.isFinite(number) || definition.min !== undefined && number < definition.min ||
          definition.max !== undefined && number > definition.max) {
          throw new Error(`DECISION_NUMBER_INVALID: ${definition.label}.`);
        }
        if (definition.step !== undefined && !matchesNumericStep(number, definition.min ?? 0, definition.step)) {
          throw new Error(`DECISION_NUMBER_STEP_INVALID: ${definition.label}.`);
        }
        return { value, label: value };
      });
    } else {
      if (values.length > 1) throw new Error(`DECISION_FIELD_INVALID: ${definition.label} accepts one value.`);
      if (values.some((value) => value.length > (definition.maxLength || DECISION_CARD_TEXT_VALUE_MAX_CHARACTERS))) {
        throw new Error(`DECISION_TEXT_TOO_LONG: ${definition.label}.`);
      }
      canonicalValues = values.map((value) => ({ value, label: value }));
    }
    return {
      name: definition.name,
      label: definition.label,
      kind: definition.kind,
      values: canonicalValues,
      ...(definition.unit ? { unit: definition.unit } : {})
    };
  });

  const comment = input.comment === undefined ? undefined : boundedDecisionText(
    input.comment.trim(), "comment", DECISION_CARD_COMMENT_MAX_CHARACTERS
  ) || undefined;
  const summaryLines = [`Intent: ${intentLabel(input.intent)}`];
  for (const selection of selections) {
    const rendered = selection.values.map((value) => value.label).join(", ") || "Not provided";
    summaryLines.push(`${selection.label}: ${rendered}${selection.unit && rendered !== "Not provided" ? ` ${selection.unit}` : ""}`);
  }
  if (comment) summaryLines.push(`User note: ${comment}`);
  const canonical = { intent: input.intent, selections, ...(comment ? { comment } : {}) };
  return {
    ...canonical,
    summary: summaryLines.join("\n"),
    digest: createHash("sha256").update(stableJson(canonical)).digest("hex")
  };
}

function extractDecisionFields(html: string): DecisionFieldDefinition[] {
  const fragment = parseFragment(html);
  const labelsByFor = new Map<string, string>();
  walk(fragment, (element) => {
    if (element.tagName !== "label") return;
    const target = attribute(element, "for");
    if (target) labelsByFor.set(target, normalizedVisibleText(element));
  });

  const ordinary: DecisionFieldDefinition[] = [];
  const grouped = new Map<string, Array<{ element: HtmlElement; label: string; type: "radio" | "checkbox" }>>();
  const fieldPositions = new Map<string, number>();
  let controlCount = 0;
  walk(fragment, (element) => {
    if (!["input", "select", "textarea"].includes(element.tagName)) return;
    if (hasAttribute(element, "disabled")) return;
    const name = attribute(element, "name");
    if (!name) {
      throw new Error(
        `DECISION_FIELD_NAME_REQUIRED: Every enabled ${element.tagName} needs a stable name starting with a letter so the user's visible input is included in the decision result.`
      );
    }
    controlCount += 1;
    if (controlCount > DECISION_CARD_MAX_FIELDS * 2) {
      throw new Error(`DECISION_FIELD_LIMIT: A card can contain at most ${DECISION_CARD_MAX_FIELDS * 2} named controls.`);
    }
    if (!DECISION_FIELD_NAME.test(name)) {
      throw new Error(
        `DECISION_FIELD_NAME_INVALID: ${JSON.stringify(name)}. Use 1-64 ASCII letters, digits, underscores, periods, or hyphens, starting with a letter.`
      );
    }
    if (!fieldPositions.has(name)) fieldPositions.set(name, controlCount);
    const label = fieldLabel(element, labelsByFor);
    if (!label) {
      throw new Error(
        `DECISION_FIELD_LABEL_REQUIRED: ${name}. Add a human-visible wrapping <label>, a <label for="..."> matching the control id, or data-decision-label.`
      );
    }

    if (element.tagName === "input") {
      const type = (attribute(element, "type") || "text").toLowerCase();
      if (type === "radio" || type === "checkbox") {
        const values = grouped.get(name) || [];
        values.push({ element, label, type });
        grouped.set(name, values);
        return;
      }
      const numeric = type === "number" || type === "range";
      ordinary.push({
        name,
        label,
        kind: type === "range" ? "range" : numeric ? "number" : "text",
        required: hasAttribute(element, "required"),
        ...numericBounds(element),
        ...unitDefinition(element),
        ...(!numeric ? { maxLength: boundedMaxLength(attribute(element, "maxlength")) } : {})
      });
      return;
    }

    if (element.tagName === "textarea") {
      ordinary.push({
        name,
        label,
        kind: "text",
        required: hasAttribute(element, "required"),
        maxLength: boundedMaxLength(attribute(element, "maxlength")),
        ...unitDefinition(element)
      });
      return;
    }

    const options: DecisionOptionDefinition[] = [];
    walk(element, (candidate) => {
      if (candidate.tagName !== "option" || hasAttribute(candidate, "disabled")) return;
      const label = normalizedBoundedText(attribute(candidate, "label") || normalizedVisibleText(candidate), "option label", 200);
      const value = boundedDecisionText(attribute(candidate, "value") ?? normalizedVisibleText(candidate), "option value", 500);
      if (!label || !value) throw new Error(`DECISION_OPTION_INVALID: ${name}.`);
      options.push({ value, label });
    });
    validateOptions(name, options);
    ordinary.push({
      name,
      label,
      kind: hasAttribute(element, "multiple") ? "multi-choice" : "choice",
      required: hasAttribute(element, "required"),
      options,
      ...unitDefinition(element)
    });
  });

  for (const [name, controls] of grouped) {
    const types = new Set(controls.map((control) => control.type));
    if (types.size !== 1) throw new Error(`DECISION_FIELD_KIND_CONFLICT: ${name}.`);
    const type = controls[0]!.type;
    if (type === "checkbox" && controls.length === 1) {
      ordinary.push({
        name,
        label: controls[0]!.label,
        kind: "boolean",
        required: hasAttribute(controls[0]!.element, "required"),
        ...unitDefinition(controls[0]!.element)
      });
      continue;
    }
    const options = controls.map(({ element, label }) => {
      const value = attribute(element, "value");
      if (!value) {
        throw new Error(
          `DECISION_OPTION_VALUE_REQUIRED: ${name}. Give every radio or multi-checkbox option a non-empty value that matches its visible meaning.`
        );
      }
      return { value: boundedDecisionText(value, "option value", 500), label };
    });
    validateOptions(name, options);
    const label = groupLabel(controls.map((control) => control.element), labelsByFor);
    if (!label) {
      throw new Error(
        `DECISION_FIELD_GROUP_LABEL_REQUIRED: ${name}. Wrap radio or multi-checkbox options in <fieldset><legend>Human-visible group label</legend>...</fieldset>, or add data-decision-label.`
      );
    }
    ordinary.push({
      name,
      label,
      kind: type === "radio" ? "choice" : "multi-choice",
      required: controls.some((control) => hasAttribute(control.element, "required")),
      options,
      ...unitDefinition(controls[0]!.element)
    });
  }

  const seen = new Set<string>();
  for (const field of ordinary) {
    if (seen.has(field.name)) throw new Error(`DECISION_FIELD_DUPLICATE: ${field.name}.`);
    seen.add(field.name);
  }
  if (ordinary.length > DECISION_CARD_MAX_FIELDS) {
    throw new Error(`DECISION_FIELD_LIMIT: A card can contain at most ${DECISION_CARD_MAX_FIELDS} fields.`);
  }
  ordinary.sort((left, right) => (fieldPositions.get(left.name) || 0) - (fieldPositions.get(right.name) || 0));
  return ordinary;
}

function walk(node: HtmlNode, visit: (element: HtmlElement) => void): void {
  if ("tagName" in node) visit(node);
  if ("childNodes" in node) for (const child of node.childNodes) walk(child, visit);
  if ("content" in node) walk(node.content, visit);
}

function attribute(element: HtmlElement, name: string): string | undefined {
  return element.attrs.find((candidate) => candidate.name.toLowerCase() === name)?.value;
}

function hasAttribute(element: HtmlElement, name: string): boolean {
  return element.attrs.some((candidate) => candidate.name.toLowerCase() === name);
}

function fieldLabel(element: HtmlElement, labelsByFor: ReadonlyMap<string, string>): string {
  const explicit = attribute(element, "data-decision-label") || attribute(element, "aria-label");
  const byFor = attribute(element, "id") ? labelsByFor.get(attribute(element, "id")!) : undefined;
  const wrapping = closestLabel(element);
  return normalizedBoundedText(explicit || byFor || wrapping || "", "field label", 200);
}

function closestLabel(element: HtmlElement): string {
  let parent = element.parentNode;
  while (parent && "tagName" in parent) {
    if (parent.tagName === "label") return normalizedVisibleText(parent);
    parent = parent.parentNode;
  }
  return "";
}

function groupLabel(elements: readonly HtmlElement[], labelsByFor: ReadonlyMap<string, string>): string {
  const explicit = elements.map((element) => attribute(element, "data-decision-label")).find(Boolean);
  if (explicit) return normalizedBoundedText(explicit, "field label", 200);
  for (const element of elements) {
    let parent = element.parentNode;
    while (parent && "tagName" in parent) {
      if (parent.tagName === "fieldset") {
        const legend = parent.childNodes.find((child): child is HtmlElement =>
          "tagName" in child && child.tagName === "legend"
        );
        if (legend) return normalizedBoundedText(normalizedVisibleText(legend), "field label", 200);
      }
      parent = parent.parentNode;
    }
    const id = attribute(element, "id");
    if (id && labelsByFor.get(id)) return normalizedBoundedText(labelsByFor.get(id)!, "field label", 200);
  }
  return "";
}

function normalizedVisibleText(node: HtmlNode): string {
  const values: string[] = [];
  const collect = (candidate: HtmlNode): void => {
    if (candidate.nodeName === "#text" && "value" in candidate) values.push(candidate.value);
    if ("tagName" in candidate && ["input", "select", "textarea", "svg"].includes(candidate.tagName)) return;
    if ("childNodes" in candidate) for (const child of candidate.childNodes) collect(child);
  };
  collect(node);
  return values.join(" ").replace(/\s+/g, " ").trim();
}

function normalizedBoundedText(value: string, label: string, maxCharacters: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return boundedDecisionText(normalized, label, maxCharacters);
}

function boundedDecisionText(value: string, label: string, maxCharacters = DECISION_CARD_TEXT_VALUE_MAX_CHARACTERS): string {
  assertWellFormedUnicode(value, `Decision ${label}`);
  if (value.length > maxCharacters) throw new Error(`DECISION_TEXT_TOO_LONG: ${label}.`);
  return value;
}

function boundedMaxLength(value: string | undefined): number {
  const parsed = value === undefined ? DECISION_CARD_TEXT_VALUE_MAX_CHARACTERS : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return DECISION_CARD_TEXT_VALUE_MAX_CHARACTERS;
  return Math.min(parsed, DECISION_CARD_TEXT_VALUE_MAX_CHARACTERS);
}

function numericBounds(element: HtmlElement): Pick<DecisionFieldDefinition, "min" | "max" | "step"> {
  const result: Pick<DecisionFieldDefinition, "min" | "max" | "step"> = {};
  for (const name of ["min", "max", "step"] as const) {
    const raw = attribute(element, name);
    if (raw === undefined || raw === "any") continue;
    const value = Number(raw);
    if (Number.isFinite(value) && (name !== "step" || value > 0)) result[name] = value;
  }
  if (result.min !== undefined && result.max !== undefined && result.min > result.max) {
    throw new Error("DECISION_NUMBER_BOUNDS_INVALID: min cannot exceed max.");
  }
  return result;
}

function matchesNumericStep(value: number, base: number, step: number): boolean {
  const quotient = (value - base) / step;
  return Math.abs(quotient - Math.round(quotient)) <= Number.EPSILON * 16 * Math.max(1, Math.abs(quotient));
}

function unitDefinition(element: HtmlElement): Pick<DecisionFieldDefinition, "unit"> {
  const unit = attribute(element, "data-decision-unit");
  return unit ? { unit: normalizedBoundedText(unit, "unit", 40) } : {};
}

function validateOptions(name: string, options: readonly DecisionOptionDefinition[]): void {
  if (options.length < 1 || options.length > DECISION_CARD_MAX_OPTIONS) {
    throw new Error(`DECISION_OPTION_LIMIT: ${name}.`);
  }
  if (new Set(options.map((option) => option.value)).size !== options.length) {
    throw new Error(`DECISION_OPTION_DUPLICATE: ${name}.`);
  }
}

function intentLabel(intent: DecisionIntent): string {
  if (intent === "confirm") return "Confirmed";
  if (intent === "request-explanation") return "More explanation requested";
  return "Deferred";
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => entry && typeof entry === "object" && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right)))
    : entry);
}
