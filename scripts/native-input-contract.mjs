import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A structural guard, not an IME test or a Swift type checker. Tokenizing avoids
// treating translated labels, comments, or nested modifiers as input controls.
function tokens(source) {
  const result = [];
  const pattern = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|#*"""[\s\S]*?"""#*|#*"(?:\\.|[^"\\])*"#*|[A-Za-z_][A-Za-z_0-9]*|[^\s]/g;
  for (const match of source.matchAll(pattern)) {
    if (/^(?:\/\/|\/\*|#*")/.test(match[0])) continue;
    result.push({ value: match[0], offset: match.index });
  }
  return result;
}

function endGroup(input, start) {
  const pairs = { "(": ")", "{": "}", "[": "]" };
  const stack = [];
  for (let index = start; index < input.length; index++) {
    const value = input[index].value;
    if (pairs[value]) stack.push(pairs[value]);
    else if ([")", "}", "]"].includes(value)) {
      if (stack.pop() !== value) throw new Error("Unbalanced Swift input expression");
      if (!stack.length) return index;
    }
  }
  throw new Error("Unterminated Swift input expression");
}

export function inspectInputs(source, file = "Fixture.swift") {
  const input = tokens(source);
  const entries = [];
  let owner = "file";
  for (let index = 0; index < input.length; index++) {
    const value = input[index].value;
    if (value === "struct") owner = input[index + 1]?.value ?? owner;
    if (["NSTextField", "NSSecureTextField", "NSSearchField", "NSTextView", "BridgeEditableTextView"].includes(value) &&
        input[index + 1]?.value === "(" && file !== "TextInputViews.swift") {
      throw new Error(`${file}:${owner}: direct native input constructor requires an explicit adapter review`);
    }
    if (value === "searchable" && input[index - 1]?.value === ".") {
      throw new Error(`${file}:${owner}: use BridgeSearchField for composition-safe native search`);
    }
    const kind = value === "BridgeSearchField" ? "search" : value;
    if (!["TextField", "SecureField", "BridgeTextEditor", "TextEditor", "search"].includes(kind) || input[index + 1]?.value !== "(") continue;
    if (kind === "TextEditor") throw new Error(`${file}: use BridgeTextEditor for multiline input`);
    const end = endGroup(input, index + 1);
    const args = input.slice(index + 2, end).map((token) => token.value).join("");
    const binding = args.match(/(?:^|[:,])([A-Za-z_][A-Za-z_0-9]*)\.binding\(\.([A-Za-z_][A-Za-z_0-9]*)\)/);
    if (!binding) throw new Error(`${file}:${owner}: input must use an edit-session binding`);
    if (kind === "search" && binding[2] !== "query") throw new Error(`${file}:${owner}: search must bind the query field`);
    let next = end + 1;
    // TextField(text: ...) { label } and modifiers with trailing content.
    if (input[next]?.value === "{") next = endGroup(input, next) + 1;
    const modifiers = [];
    while (input[next]?.value === ".") {
      const method = input[next + 1]?.value;
      if (input[next + 2]?.value === "(") {
        const last = endGroup(input, next + 2);
        modifiers.push([method, input.slice(next + 3, last).map((token) => token.value).join("")]);
        next = last + 1;
      } else if (input[next + 2]?.value === "{") {
        next = endGroup(input, next + 2) + 1;
      } else break;
      if (input[next]?.value === "{") next = endGroup(input, next) + 1;
    }
    const expected = kind === "search" ? ["bridgeSearchInput", binding[1]] : ["bridgeInput", `${binding[1]},field:.${binding[2]}`];
    if (!modifiers.some(([method, args]) => method === expected[0] && (args === expected[1] || args.startsWith(`${expected[1]},`)))) {
      throw new Error(`${file}:${owner}:${binding[2]}: missing or mismatched native owner`);
    }
    entries.push({ id: `${file}:${owner}:${binding[2]}`, kind, session: binding[1], field: binding[2] });
    index = end;
  }
  if (input.some((token, index) => token.value === "BridgeTextInput" && input[index + 1]?.value === "." && input[index + 2]?.value === "commitPendingComposition")) {
    throw new Error(`${file}: global composition commits are forbidden`);
  }
  return entries;
}

export function checkInventory(actual, expected) {
  const compact = (entries) => entries.map(({ id, kind, session, field }) => ({ id, kind, session, field })).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(actual.map((entry) => entry.id)).size !== actual.length) throw new Error("Duplicate native input inventory identity");
  if (JSON.stringify(compact(actual)) !== JSON.stringify(compact(expected))) {
    throw new Error("Native input inventory changed: review policies, submission/exit paths and update macos/input-contract.json");
  }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = path.join(root, "macos/Sources/CodexBridgeMenuBar");
  function sources(folder) {
    return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
      const filename = path.join(folder, entry.name);
      return entry.isDirectory() ? sources(filename) : entry.name.endsWith(".swift") ? [filename] : [];
    });
  }
  const actual = sources(directory)
    .flatMap((filename) => inspectInputs(readFileSync(filename, "utf8"), path.relative(directory, filename)));
  const inventory = JSON.parse(readFileSync(path.join(root, "macos/input-contract.json"), "utf8"));
  checkInventory(actual, inventory.inputs);
  console.log(`Native input contract: ${actual.length} declarations checked; ${inventory.systemExceptions.length} system-owned exceptions documented.`);
}
