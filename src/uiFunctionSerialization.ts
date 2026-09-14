/**
 * Card HTML contains a small set of shared helpers. Function#toString() is
 * useful for keeping those helpers colocated with their server equivalents,
 * but TypeScript changes insignificant whitespace in emitted JavaScript. Make
 * that whitespace deterministic so a UI resource has the same bytes in the
 * source renderer and in the compiled bridge.
 */
export function serializeUiFunction(value: Function): string {
  const source = value.toString();
  let output = "";
  let pendingSpace = false;

  for (let index = 0; index < source.length;) {
    const current = source[index]!;
    const next = source[index + 1];
    if (/\s/.test(current)) {
      pendingSpace = true;
      index += 1;
      continue;
    }
    if (current === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      pendingSpace = true;
      continue;
    }
    if (current === "/" && next === "*") {
      const close = source.indexOf("*/", index + 2);
      index = close < 0 ? source.length : close + 2;
      pendingSpace = true;
      continue;
    }

    if (current === "'" || current === '"' || current === "`") {
      const end = endOfLiteral(source, index, current);
      append(source.slice(index, end));
      index = end;
      continue;
    }

    append(current);
    index += 1;
  }

  return canonicalizeTranspilerSyntax(output.trim());

  function append(token: string): void {
    if (pendingSpace && requiresSeparator(output.at(-1), token[0])) output += " ";
    pendingSpace = false;
    output += token;
  }
}

/**
 * TypeScript and the source test runner spell a few equivalent JavaScript
 * forms differently. Keep the generated browser function valid while making
 * those spellings byte-stable. String and template literals stay opaque so
 * UI-visible text is never rewritten.
 */
function canonicalizeTranspilerSyntax(source: string): string {
  const literals: string[] = [];
  let code = "";

  for (let index = 0; index < source.length;) {
    const current = source[index]!;
    if (current === "'" || current === '"' || current === "`") {
      const end = endOfLiteral(source, index, current);
      code += `\u0000${literals.length}\u0000`;
      literals.push(source.slice(index, end));
      index = end;
      continue;
    }
    code += current;
    index += 1;
  }

  const normalized = code
    // esbuild avoids an outer binding collision with this local; tsc does not.
    .replace(/\bmessage2\b/g, "message")
    // tsc prints empty constructor calls that the source runner omits.
    .replace(/\bnew\s+([A-Za-z_$][\w$]*)\(\)/g, "new $1")
    // tsc wraps a single arrow parameter; both forms have the same meaning.
    .replace(/\(([A-Za-z_$][\w$]*)\)=>/g, "$1=>")
    // tsc adds semicolons before a closing block or expression.
    .replace(/;(?=[})])/g, "");

  return removeEmptyBlockStatementTerminators(normalized)
    .replace(/\u0000(\d+)\u0000/g, (_match, index: string) => literals[Number(index)]!);
}

const CONTROL_BLOCK_KEYWORDS = new Set([
  "catch", "do", "else", "finally", "for", "if", "switch", "try", "while", "with"
]);

function removeEmptyBlockStatementTerminators(code: string): string {
  const parentheses = new Map<number, number>();
  const openParentheses: number[] = [];
  const blocks: boolean[] = [];
  let output = "";

  for (let index = 0; index < code.length; index += 1) {
    const current = code[index]!;
    if (current === "(") {
      openParentheses.push(index);
    } else if (current === ")") {
      const opening = openParentheses.pop();
      if (opening !== undefined) parentheses.set(index, opening);
    } else if (current === "{") {
      blocks.push(opensControlBlock(code, index, parentheses));
    } else if (current === "}") {
      const closesBlock = blocks.pop() === true;
      output += current;
      if (closesBlock && code[index + 1] === ";") index += 1;
      continue;
    }
    output += current;
  }
  return output;
}

function opensControlBlock(
  code: string,
  openingBrace: number,
  parentheses: ReadonlyMap<number, number>
): boolean {
  const previous = previousWord(code, openingBrace);
  if (previous && CONTROL_BLOCK_KEYWORDS.has(previous.word)) return true;
  if (code[openingBrace - 1] === ">" && code[openingBrace - 2] === "=") return true;
  if (code[openingBrace - 1] !== ")") return false;

  const openingParenthesis = parentheses.get(openingBrace - 1);
  if (openingParenthesis === undefined) return false;
  const beforeParameters = previousWord(code, openingParenthesis);
  if (!beforeParameters) return false;
  if (CONTROL_BLOCK_KEYWORDS.has(beforeParameters.word) || beforeParameters.word === "function") return true;
  return previousWord(code, beforeParameters.start)?.word === "function";
}

function previousWord(code: string, end: number): { word: string; start: number } | undefined {
  let cursor = end - 1;
  while (cursor >= 0 && /\s/.test(code[cursor]!)) cursor -= 1;
  if (cursor < 0 || !/[A-Za-z0-9_$]/.test(code[cursor]!)) return undefined;
  const endOfWord = cursor + 1;
  while (cursor >= 0 && /[A-Za-z0-9_$]/.test(code[cursor]!)) cursor -= 1;
  return { word: code.slice(cursor + 1, endOfWord), start: cursor + 1 };
}

function endOfLiteral(source: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === quote) return index + 1;
    index += 1;
  }
  return source.length;
}

function requiresSeparator(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  if (/[A-Za-z0-9_$]/.test(left) && /[A-Za-z0-9_$]/.test(right)) return true;
  return (
    (left === "+" && right === "+") ||
    (left === "-" && right === "-") ||
    (left === "/" && (right === "/" || right === "*")) ||
    (left === "*" && right === "/") ||
    (left === "?" && right === "?")
  );
}
