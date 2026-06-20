import { extractImportsFromFile } from "./architectureImportExtractor.js";

export interface ArchitectureImportMapEntry {
  filePath: string;
  imports: readonly string[];
}

export function buildArchitectureImportMap(
  filePaths: readonly string[],
): readonly ArchitectureImportMapEntry[] {
  return filePaths.map((filePath) => ({
    filePath,
    imports: extractImportsFromFile(filePath),
  }));
}