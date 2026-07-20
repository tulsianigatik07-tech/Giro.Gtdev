import { extractImportsFromFile } from "./architectureImportExtractor.js";
import type { TrustedRepositoryFilePath } from "../security/repositoryPaths.js";

export interface ArchitectureImportMapEntry {
  filePath: string;
  imports: readonly string[];
}

export function buildArchitectureImportMap(
  filePaths: readonly TrustedRepositoryFilePath[],
): readonly ArchitectureImportMapEntry[] {
  return filePaths.map((filePath) => ({
    filePath,
    imports: extractImportsFromFile(filePath),
  }));
}
