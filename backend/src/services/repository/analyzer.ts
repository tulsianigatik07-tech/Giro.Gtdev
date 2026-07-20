// Aggregates all detectors into a single repository analysis result.

import type { Framework } from "./frameworks.js";
import type { PackageManager } from "./packageManagers.js";
import {
  detectFramework,
  detectPackageManager,
  detectPrimaryLanguage,
  detectMonorepo,
  detectFrontend,
  detectBackend,
  detectImportantFiles,
  detectEntrypoints,
} from "./detectors.js";
import { collectContainedDirectories, type TrustedRepositoryCheckoutPath } from "../security/repositoryPaths.js";

export interface AnalysisResult {
  framework: Framework;
  packageManager: PackageManager;
  primaryLanguage: string;
  monorepo: boolean;
  hasFrontend: boolean;
  hasBackend: boolean;
  importantFiles: string[];
  entrypoints: string[];
}

export async function analyzeRepository(
  clonePath: TrustedRepositoryCheckoutPath,
  scanResult: { languages: Record<string, number>; tree: string[] },
): Promise<AnalysisResult> {
  const topLevelFiles = scanResult.tree.filter((e) => !e.includes("/"));
  const topLevelDirs = scanResult.tree
    .filter((e) => e.endsWith("/"))
    .map((e) => e.slice(0, -1));

  const allDirs = await collectContainedDirectories(clonePath, { ignore: (_relative, name) => name === ".git" });

  const [framework, importantFiles, entrypoints] = await Promise.all([
    detectFramework(clonePath, topLevelFiles),
    detectImportantFiles(clonePath),
    detectEntrypoints(clonePath),
  ]);

  return {
    framework,
    packageManager: detectPackageManager(topLevelFiles),
    primaryLanguage: detectPrimaryLanguage(scanResult.languages),
    monorepo: detectMonorepo(topLevelFiles, topLevelDirs),
    hasFrontend: detectFrontend(allDirs),
    hasBackend: detectBackend(allDirs),
    importantFiles,
    entrypoints,
  };
}
