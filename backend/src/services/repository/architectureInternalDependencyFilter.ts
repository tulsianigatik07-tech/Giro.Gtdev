import type {
    ArchitectureResolvedImportMapEntry,
  } from "./architectureResolvedImportMap.js";
  
  export interface ArchitectureInternalDependency {
    sourceFile: string;
    targetFile: string;
  }
  
  export function extractInternalDependencies(
    importMap: readonly ArchitectureResolvedImportMapEntry[],
  ): readonly ArchitectureInternalDependency[] {
    const dependencies: ArchitectureInternalDependency[] = [];
  
    for (const file of importMap) {
      for (const imported of file.imports) {
        if (!imported.isRelative) {
          continue;
        }
  
        dependencies.push({
          sourceFile: file.filePath,
          targetFile: imported.resolvedImport,
        });
      }
    }
  
    return dependencies;
  }