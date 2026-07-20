// Regex-based symbol + import extraction. No AST parser, no new dependencies.

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { logger } from "../../lib/logger.js";
import { shouldIgnorePath, shouldIgnoreFile } from "../repository/ignore.js";
import { resolveRepositoryPath, type TrustedRepositoryCheckoutPath } from "../security/repositoryPaths.js";
import type {
  ExtractedSymbol,
  FileImport,
  FileSymbolMap,
  SymbolKind,
} from "./types.js";

const MAX_FILE_SIZE = 1024 * 1024; // 1MB
const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx"]);

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function languageOf(ext: string): "typescript" | "javascript" {
  return ext === ".ts" || ext === ".tsx" ? "typescript" : "javascript";
}

// Ordered so the most specific keyword wins per line.
const SYMBOL_RULES: Array<{ re: RegExp; kind: SymbolKind }> = [
  { re: /\bexport\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/, kind: "function" },
  { re: /\bexport\s+(?:default\s+)?class\s+([A-Za-z0-9_$]+)(?:\s+extends\s+([A-Za-z0-9_$.]+))?(?:\s+implements\s+([^<{]+))?/, kind: "class" },
  { re: /\bexport\s+interface\s+([A-Za-z0-9_$]+)(?:\s+extends\s+([^<{]+))?/, kind: "interface" },
  { re: /\bexport\s+type\s+([A-Za-z0-9_$]+)/, kind: "type" },
  { re: /\bexport\s+enum\s+([A-Za-z0-9_$]+)/, kind: "enum" },
  { re: /\bexport\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/, kind: "variable" },
];

function namesFromList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim().split(/[<\s.]/)[0]?.trim())
    .filter((part): part is string => Boolean(part))
    .sort((a, b) => a.localeCompare(b));
}

function extractImport(line: string, lineNumber: number): FileImport | null {
  const from = /\bimport\s+(?:type\s+)?(.+?)\s+from\s+["']([^"']+)["']/.exec(line);
  if (from) {
    const clause = from[1] ?? "";
    const source = from[2] ?? "";
    const specifiers: string[] = [];
    const named = /\{([^}]*)\}/.exec(clause);
    if (named && named[1]) {
      for (const part of named[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/)[0]?.trim();
        if (name) specifiers.push(name);
      }
    }
    const star = /\*\s+as\s+([A-Za-z0-9_$]+)/.exec(clause);
    if (star && star[1]) specifiers.push(star[1]);
    const def = /^([A-Za-z0-9_$]+)\s*,?/.exec(clause.trim());
    if (def && def[1] && !clause.trim().startsWith("{") && !clause.trim().startsWith("*")) {
      specifiers.push(def[1]);
    }
    return { source, specifiers, isRelative: source.startsWith("."), line: lineNumber };
  }
  const bare = /\bimport\s+["']([^"']+)["']/.exec(line);
  if (bare && bare[1]) {
    return { source: bare[1], specifiers: [], isRelative: bare[1].startsWith("."), line: lineNumber };
  }
  return null;
}

export async function extractFileSymbols(
  relativeFilePath: string,
  repoRoot: TrustedRepositoryCheckoutPath,
): Promise<FileSymbolMap> {
  const relative = toPosix(relativeFilePath);
  const ext = path.extname(relative).toLowerCase();
  const empty: FileSymbolMap = {
    filePath: relative,
    language: languageOf(ext),
    symbols: [],
    imports: [],
  };

  let content: string;
  try {
    const filePath = await resolveRepositoryPath(repoRoot, relative, {
      mustExist: true,
      requireFile: true,
    });
    if ((await stat(filePath)).size > MAX_FILE_SIZE) return empty;
    content = await readFile(filePath, "utf8");
  } catch (err) {
    logger.debug("symbol_extraction_read_failed", {
      file: relative,
      reasonCode: "repository_file_read_failed",
    });
    return empty;
  }

  const symbols: ExtractedSymbol[] = [];
  const imports: FileImport[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    for (const rule of SYMBOL_RULES) {
      const m = rule.re.exec(line);
      if (m && m[1]) {
        const symbol: ExtractedSymbol = {
          name: m[1],
          kind: rule.kind,
          exported: true,
          line: i + 1,
        };
        if (rule.kind === "class") {
          symbol.extends = namesFromList(m[2]);
          symbol.implements = namesFromList(m[3]);
        }
        if (rule.kind === "interface") {
          symbol.extends = namesFromList(m[2]);
        }
        symbols.push(symbol);
        break;
      }
    }
    if (/\bimport\b/.test(line)) {
      const imp = extractImport(line, i + 1);
      if (imp) imports.push(imp);
    }
  }

  return { filePath: relative, language: languageOf(ext), symbols, imports };
}

export async function extractRepoSymbols(
  repoRoot: TrustedRepositoryCheckoutPath,
): Promise<FileSymbolMap[]> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = toPosix(path.relative(repoRoot, abs));
      if (entry.isDirectory()) {
        if (entry.name === ".git" || shouldIgnorePath(rel)) continue;
        try {
          await walk(await resolveRepositoryPath(repoRoot, rel, { mustExist: true, requireDirectory: true }));
        } catch { /* skip unsafe or raced directories */ }
        continue;
      }
      if (!entry.isFile()) continue;
      if (shouldIgnorePath(rel) || shouldIgnoreFile(entry.name)) continue;
      if (!SOURCE_EXTS.has(path.extname(entry.name).toLowerCase())) continue;
      try {
        const safeFile = await resolveRepositoryPath(repoRoot, rel, { mustExist: true, requireFile: true });
        if ((await stat(safeFile)).size > MAX_FILE_SIZE) continue;
        files.push(rel);
      } catch {
        continue;
      }
    }
  }

  await walk(repoRoot);

  const maps: FileSymbolMap[] = [];
  for (let i = 0; i < files.length; i++) {
    maps.push(await extractFileSymbols(files[i] as string, repoRoot));
    logger.debug("symbol_extraction_progress", {
      processed: i + 1,
      total: files.length,
    });
  }

  return maps;
}
