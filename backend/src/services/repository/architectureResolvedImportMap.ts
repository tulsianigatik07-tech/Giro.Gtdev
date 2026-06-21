import { resolveArchitectureImport } from "./architectureImportResolver.js";
import type { ArchitectureImportMapEntry } from "./architectureImportMap.js";

export interface ArchitectureResolvedImportMapEntry {
  filePath: string;
  imports: readonly {
    rawImport: string;
    resolvedImport: string;
    isRelative: boolean;
  }[];
}

export function buildResolvedArchitectureImportMap(
  importMap: readonly ArchitectureImportMapEntry[],
): readonly ArchitectureResolvedImportMapEntry[] {
  return importMap.map((entry) => ({
    filePath: entry.filePath,
    imports: entry.imports.map((rawImport) => {
      const resolved = resolveArchitectureImport(entry.filePath, rawImport);

      return {
        rawImport: resolved.rawImport,
        resolvedImport: resolved.resolvedImport,
        isRelative: resolved.isRelative,
      };
    }),
  }));
}