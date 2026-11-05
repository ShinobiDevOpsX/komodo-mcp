// Looks up a request's parameter definition (with its doc comments) in the
// komodo_client type definitions, so Claude can see what params a call takes.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
let typesSrc: string | undefined;

function source(): string {
  typesSrc ??= readFileSync(join(dirname(require.resolve("komodo_client")), "types.d.ts"), "utf8");
  return typesSrc;
}

/** Returns the `export interface Name {...}` / `export type Name = ...;` block with its doc comment. */
export function findDefinition(name: string): string | undefined {
  const src = source();
  const match = new RegExp(`^export (?:declare )?(interface|type|enum) ${name}\\b`, "m").exec(src);
  if (!match) return undefined;
  let start = match.index;

  // Include the doc comment directly above, if any.
  const before = src.slice(0, start).trimEnd();
  if (before.endsWith("*/")) {
    const docStart = before.lastIndexOf("/**");
    if (docStart !== -1) start = docStart;
  }

  // Find the end: matching closing brace for interfaces/enums, or `;` at depth 0 for types.
  let depth = 0;
  let i = match.index;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") {
      depth--;
      if (depth === 0 && match[1] !== "type") { i++; break; }
    } else if (c === ";" && depth === 0 && match[1] === "type") { i++; break; }
  }
  return src.slice(start, i);
}
