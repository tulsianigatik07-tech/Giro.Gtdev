import fs from "node:fs";
import type { TrustedRepositoryFilePath } from "../security/repositoryPaths.js";

export function extractImportsFromFile(
  filePath: TrustedRepositoryFilePath,
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
