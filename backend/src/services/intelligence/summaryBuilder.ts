// Orchestrates repository intelligence: reuses the existing analyzer + scanner,
// then layers DB/auth/queue/testing/infra detection, directory scoring, and
// architecture classification. Deterministic and read-only.

import { scanRepo } from "../repository/scanner.js";
import { analyzeRepository } from "../repository/analyzer.js";
import { readPackageInfo } from "./packageInfo.js";
import {
  detectDatabases,
  detectAuth,
  detectQueues,
  detectTesting,
  detectInfrastructure,
} from "./techDetectors.js";
import { scoreDirectories } from "./directoryScoring.js";
import { classifyArchitecture } from "./architecture.js";
import type { RepositorySummary } from "./types.js";
import { collectContainedDirectories, type TrustedRepositoryCheckoutPath } from "../security/repositoryPaths.js";

export async function buildRepositorySummary(
  clonePath: TrustedRepositoryCheckoutPath,
  repository: string,
): Promise<RepositorySummary> {
  const indexStart = performance.now();
  const scan = await scanRepo(clonePath);
  const indexingDurationMs = Math.round(performance.now() - indexStart);

  const analysisStart = performance.now();
  let parsingFailures = 0;

  const [analysis, pkg, allDirs] = await Promise.all([
    analyzeRepository(clonePath, scan).catch(() => {
      parsingFailures += 1;
      return null;
    }),
    readPackageInfo(clonePath),
    collectContainedDirectories(clonePath, { ignore: (_relative, name) => name === ".git" }),
  ]);

  const topLevelFiles = new Set(scan.tree.filter((e) => !e.includes("/")));
  const signals = { deps: pkg.deps, files: topLevelFiles };

  const frameworks =
    analysis && analysis.framework !== "unknown" ? [analysis.framework] : [];
  const entrypoints = analysis?.entrypoints ?? [];

  const architectureType = classifyArchitecture({
    monorepo: analysis?.monorepo ?? false,
    hasBackend: analysis?.hasBackend ?? false,
    hasFrontend: analysis?.hasFrontend ?? false,
    hasBin: pkg.hasBin,
    isLibrary: pkg.isLibrary,
    entrypointCount: entrypoints.length,
  });

  const analysisDurationMs = Math.round(performance.now() - analysisStart);

  return {
    repository,
    frameworks,
    architectureType,
    primaryLanguage: analysis?.primaryLanguage ?? "unknown",
    packageManager: analysis?.packageManager ?? "unknown",
    importantDirectories: scoreDirectories(allDirs),
    entrypoints,
    dependencies: [...pkg.deps].sort(),
    separation: {
      hasBackend: analysis?.hasBackend ?? false,
      hasFrontend: analysis?.hasFrontend ?? false,
      monorepo: analysis?.monorepo ?? false,
    },
    databaseLayer: detectDatabases(signals),
    authLayer: detectAuth(signals),
    queueLayer: detectQueues(signals),
    testingFramework: detectTesting(signals),
    infrastructure: detectInfrastructure(signals),
    metrics: {
      indexingDurationMs,
      analysisDurationMs,
      parsingFailures,
      detectedFrameworks: frameworks,
    },
  };
}
