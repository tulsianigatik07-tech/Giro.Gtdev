import fs from "node:fs";

export function extractImportsFromFile(
  filePath: string,
): string[] {
  const content = fs.readFileSync(
    filePath,
    "utf8",
  );

  const imports = content.match(
    /from\s+["']([^"']+)["']/g,
  ) ?? [];

  return imports.map((entry) =>
    entry.replace(/from\s+["']/, "")
      .replace(/["']$/, ""),
  );
}
