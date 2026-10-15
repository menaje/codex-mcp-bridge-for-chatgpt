// Structural check for literal lookup keys and local key mappings. This is not
// a Swift type checker; interpolated keys still need runtime coverage.
export function swiftLocalizationReferences(source, localFunctions = []) {
  const input = [];
  const pattern = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|#*"""[\s\S]*?"""#*|#*"(?:\\.|[^"\\])*"#*|[A-Za-z_][A-Za-z_0-9]*|[^\s]/g;
  for (const match of source.matchAll(pattern)) {
    const value = match[0];
    if (/^(?:\/\/|\/\*)/.test(value)) continue;
    let literal;
    if (value.startsWith('"') && !value.startsWith('"""')) {
      try { literal = JSON.parse(value); } catch { /* Swift interpolation/escapes. */ }
    }
    input.push({ value, literal, offset: match.index });
  }

  const root = { parent: null, bindings: new Map() };
  let scope = root;
  for (let index = 0; index < input.length; index++) {
    const token = input[index];
    token.scope = scope;
    if (token.value === "{") scope = { parent: scope, bindings: new Map() };
    else if (token.value === "}") scope = scope.parent ?? root;
    else if (["let", "var"].includes(token.value)) {
      const name = input[index + 1]?.value;
      if (name) scope.bindings.set(name, { values: [], aliases: [] });
    }
  }
  function binding(token) {
    for (let current = token.scope; current; current = current.parent) {
      if (current.bindings.has(token.value)) return current.bindings.get(token.value);
    }
  }

  for (let index = 0; index < input.length; index++) {
    const token = input[index];
    let next = index + 1;
    if (input[next]?.value === ":" && input[next + 1]?.value === "String") next += 2;
    if (input[next]?.value !== "=") continue;
    const target = binding(token), value = input[next + 1];
    if (!target || !value) continue;
    if (typeof value.literal === "string") target.values.push(value);
    else if (/^[A-Za-z_]\w*$/.test(value.value)) {
      const following = input[next + 2];
      if (!following || [",", ";", "}"].includes(following.value) ||
          source.slice(value.offset + value.value.length, following.offset).includes("\n")) {
        const alias = binding(value);
        if (alias) target.aliases.push(alias);
      }
    }
  }

  const references = new Map();
  function add(token) {
    if (typeof token?.literal === "string") {
      references.set(token.offset, { key: token.literal, offset: token.offset });
    }
  }
  function addBinding(value, visited = new Set()) {
    if (!value || visited.has(value)) return;
    visited.add(value);
    value.values.forEach(add);
    value.aliases.forEach((alias) => addBinding(alias, visited));
  }
  for (let index = 0; index < input.length; index++) {
    const token = input[index];
    const helper = token.value === "BridgeAppLocalization" && input[index + 1]?.value === "." &&
      ["string", "format"].includes(input[index + 2]?.value);
    const local = localFunctions.includes(token.value) && input[index - 1]?.value !== "func";
    const opening = index + (helper ? 3 : 1);
    if ((!helper && !local) || input[opening]?.value !== "(") continue;
    const argument = input[opening + 1];
    if (typeof argument?.literal === "string") add(argument);
    else if ([",", ")"].includes(input[opening + 2]?.value)) addBinding(binding(argument));
    else {
      // Only the result arms of a conditional are keys; comparison literals
      // such as `bucket == "idle"` are ordinary data.
      let depth = 0;
      for (let at = opening + 1; at < input.length; at++) {
        const item = input[at];
        if (["(", "[", "{"].includes(item.value)) depth++;
        else if ([")", "]", "}"].includes(item.value)) {
          if (!depth) break;
          depth--;
        } else if (item.value === "," && !depth) break;
        if (["?", ":"].includes(input[at - 1]?.value)) add(item);
      }
    }
  }
  return [...references.values()].sort((left, right) => left.offset - right.offset);
}
