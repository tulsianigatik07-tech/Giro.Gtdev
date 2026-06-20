import type { ArchitectureImportMapEntry }
from "./architectureImportMap.js";

export interface ArchitectureDependency {
  source: string;
  target: string;
}

export function buildArchitectureDependencyGraph(
  importMap: readonly ArchitectureImportMapEntry[],
): readonly ArchitectureDependency[] {
  const dependencies: ArchitectureDependency[] = [];

  for (const file of importMap) {
    for (const imported of file.imports) {
      dependencies.push({
        source: file.filePath,
        target: imported,
      });
    }
  }

  return dependencies;
}