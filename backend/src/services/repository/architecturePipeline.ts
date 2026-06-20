import { scanRepositoryFiles } from "./architectureFileScanner.js";
import { collectArchitectureFiles } from "./architectureFileCollector.js";

export interface ArchitecturePipelineResult {
  files: readonly string[];
  ignored: readonly string[];
}

export function buildArchitectureInput(
  repositoryPath: string,
): ArchitecturePipelineResult {
  const discoveredFiles =
    scanRepositoryFiles(repositoryPath);

  const collected =
    collectArchitectureFiles({
      filePaths: discoveredFiles,
    });

  return {
    files: collected.files,
    ignored: collected.ignored,
  };
}