import { runArchitectureEngine } from "./architectureEngine.js";
import { generateArchitectureReport } from "./architectureReportGenerator.js";
import type { TrustedRepositoryCheckoutPath } from "../security/repositoryPaths.js";

export function runArchitectureAnalysis(
  repoId: string,
  repoPath: TrustedRepositoryCheckoutPath,
) {
  const architecture = runArchitectureEngine(repoId, repoPath);
  const report = generateArchitectureReport(architecture);

  return {
    architecture,
    report,
  };
}
