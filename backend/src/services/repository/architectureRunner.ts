import { runArchitectureEngine } from "./architectureEngine.js";
import { generateArchitectureReport } from "./architectureReportGenerator.js";

export function runArchitectureAnalysis(
  repoId: string,
  repoPath: string,
) {
  const architecture = runArchitectureEngine(repoId, repoPath);
  const report = generateArchitectureReport(architecture);

  return {
    architecture,
    report,
  };
}