// Deterministic, pure symbol extraction for source files.
//
// Lightweight regex/string-based only:
// - No filesystem writes, no database, no AI, no AST libraries
// - No mutation of inputs, no side effects
// - Same (filePath, content) always yields identical, sorted output
//
// Supported TypeScript/JavaScript declaration patterns (one symbol per line,
// first match wins):
//   export function foo() | function foo()
//   export class User     | class User
//   export interface User | interface User
//   export type User =    | type User =
//   export const foo =    | const foo =  (also let/var)

export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "variable";

export interface ExtractedSymbol {
  name: string;
  kind: SymbolKind;
  exported: boolean;
  line: number;
}

const IDENT = "[A-Za-z0-9_$]+";

// Rules are evaluated in priority order against the line with any leading
// `export` / `export default` prefix already stripped.
const RULES: Array<{ re: RegExp; kind: SymbolKind }> = [
  { re: new RegExp(`^(?:async\\s+)?function\\s+(${IDENT})`), kind: "function" },
  { re: new RegExp(`^(?:abstract\\s+)?class\\s+(${IDENT})`), kind: "class" },
  { re: new RegExp(`^interface\\s+(${IDENT})`), kind: "interface" },
  { re: new RegExp(`^type\\s+(${IDENT})\\s*[=<]`), kind: "type" },
  { re: new RegExp(`^(?:const|let|var)\\s+(${IDENT})`), kind: "variable" },
];

const EXPORT_PREFIX = /^\s*export\s+(?:default\s+)?/;
const HAS_EXPORT = /^\s*export\b/;

export function extractSymbols(
  _filePath: string,
  content: string,
): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const exported = HAS_EXPORT.test(raw);
    const rest = raw.replace(EXPORT_PREFIX, "").trimStart();

    for (const rule of RULES) {
      const match = rule.re.exec(rest);
      if (match && match[1]) {
        symbols.push({
          name: match[1],
          kind: rule.kind,
          exported,
          line: i + 1,
        });
        break;
      }
    }
  }

  // Deterministic ordering: by line, then by name.
  return symbols.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
}
