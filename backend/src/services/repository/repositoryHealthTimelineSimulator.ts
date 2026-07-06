import type {
  RepositoryAiReadinessLevel,
  RepositoryAiReadinessResult,
} from "./repositoryAiReadinessEngine.js";
import type { RepositoryHealthEngineResult } from "./repositoryHealthEngine.js";
import type { RepositoryHotspotReport } from "./repositoryHotspotAnalyzer.js";
import type { RepositoryRiskLevel, RepositoryRiskReport } from "./repositoryRiskAnalyzer.js";

export type RepositoryHealthSimulationAction =
  | "index_repository"
  | "resolve_blocker"
  | "remove_circular_dependency"
  | "reduce_complexity"
  | "remove_hotspot"
  | "improve_ai_readiness"
  | "cleanup_stale_repository"
  | "resolve_architecture_warning";

export interface RepositoryHealthTimelineReport {
  repositoryId?: string;
  health: RepositoryHealthEngineResult;
  aiReadiness: RepositoryAiReadinessResult;
  risk: RepositoryRiskReport;
  hotspots?: RepositoryHotspotReport;
}

export interface RepositoryHealthTimelineSimulatorInput {
  report: RepositoryHealthTimelineReport;
  actions: readonly RepositoryHealthSimulationAction[];
}

export interface RepositoryHealthTimelineStep {
  step: number;
  action: RepositoryHealthSimulationAction;
  score: number;
  riskLevel: RepositoryRiskLevel;
  aiReadiness: RepositoryAiReadinessLevel;
  summary: string;
}

export interface RepositoryHealthTimelineSimulation {
  repositoryId: string;
  initialScore: number;
  finalScore: number;
  timeline: RepositoryHealthTimelineStep[];
  improvements: string[];
  remainingBlockers: string[];
  estimatedReadiness: RepositoryAiReadinessLevel;
  summary: string;
}

interface SimulationState {
  score: number;
  riskScore: number;
  readinessScore: number;
  blockers: string[];
  stale: boolean;
  indexed: boolean;
  hotspotCount: number;
  circularDependencyCount: number;
  architectureWarnings: number;
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function riskLevel(score: number): RepositoryRiskLevel {
  if (score >= 80) return "CRITICAL";
  if (score >= 55) return "HIGH";
  if (score >= 25) return "MEDIUM";
  return "LOW";
}

function readinessLevel(score: number, blockers: readonly string[]): RepositoryAiReadinessLevel {
  if (blockers.length > 0 || score < 40) return "blocked";
  if (score < 70) return "degraded";
  return "ready";
}

function removeFirstBlocker(blockers: readonly string[]): string[] {
  return blockers.slice(1);
}

function removeBlockersMatching(
  blockers: readonly string[],
  patterns: readonly string[],
): string[] {
  return blockers.filter((blocker) => {
    const normalized = blocker.toLowerCase();
    return !patterns.some((pattern) => normalized.includes(pattern));
  });
}

function repositoryIdFor(report: RepositoryHealthTimelineReport): string {
  return (
    report.repositoryId ??
    report.health.repositoryId ??
    report.aiReadiness.repositoryId ??
    report.risk.repositoryId ??
    report.hotspots?.repositoryId ??
    "unknown"
  );
}

function initialState(report: RepositoryHealthTimelineReport): SimulationState {
  return {
    score: report.health.score,
    riskScore: report.risk.score,
    readinessScore: report.aiReadiness.score,
    blockers: sortedUnique([...report.risk.blockers, ...report.aiReadiness.blockers]),
    stale: report.health.signals.stale || report.aiReadiness.signals.stale,
    indexed: report.health.signals.indexed && report.aiReadiness.signals.indexed,
    hotspotCount: report.hotspots?.hotspots.length ?? 0,
    circularDependencyCount: report.risk.signals.circularDependencyCount,
    architectureWarnings: report.risk.signals.warningInsights,
  };
}

function applyAction(
  state: SimulationState,
  action: RepositoryHealthSimulationAction,
): { state: SimulationState; improvement: string } {
  const next: SimulationState = {
    ...state,
    blockers: [...state.blockers],
  };

  switch (action) {
    case "index_repository":
      next.indexed = true;
      next.score = clampScore(next.score + 25);
      next.riskScore = clampScore(next.riskScore - 28);
      next.readinessScore = clampScore(next.readinessScore + 30);
      next.blockers = removeBlockersMatching(next.blockers, ["index", "metadata"]);
      return { state: next, improvement: "Repository indexing simulated." };
    case "resolve_blocker":
      next.score = clampScore(next.score + 8);
      next.riskScore = clampScore(next.riskScore - 12);
      next.readinessScore = clampScore(next.readinessScore + 10);
      next.blockers = removeFirstBlocker(next.blockers);
      return { state: next, improvement: "One blocker resolved." };
    case "remove_circular_dependency":
      next.circularDependencyCount = Math.max(0, next.circularDependencyCount - 1);
      next.score = clampScore(next.score + 10);
      next.riskScore = clampScore(next.riskScore - 16);
      next.blockers = removeBlockersMatching(next.blockers, ["circular", "hotspot"]);
      return { state: next, improvement: "Circular dependency risk reduced." };
    case "reduce_complexity":
      next.score = clampScore(next.score + 7);
      next.riskScore = clampScore(next.riskScore - 10);
      return { state: next, improvement: "Architecture complexity reduced." };
    case "remove_hotspot":
      next.hotspotCount = Math.max(0, next.hotspotCount - 1);
      next.score = clampScore(next.score + 6);
      next.riskScore = clampScore(next.riskScore - 9);
      next.blockers = removeBlockersMatching(next.blockers, ["hotspot"]);
      return { state: next, improvement: "One hotspot removed." };
    case "improve_ai_readiness":
      next.score = clampScore(next.score + 6);
      next.riskScore = clampScore(next.riskScore - 8);
      next.readinessScore = clampScore(next.readinessScore + 35);
      next.blockers = removeBlockersMatching(next.blockers, ["readiness", "retrieval"]);
      return { state: next, improvement: "AI readiness improved." };
    case "cleanup_stale_repository":
      next.stale = false;
      next.score = clampScore(next.score + 12);
      next.riskScore = clampScore(next.riskScore - 14);
      next.readinessScore = clampScore(next.readinessScore + 8);
      next.blockers = removeBlockersMatching(next.blockers, ["stale"]);
      return { state: next, improvement: "Stale repository metadata cleaned up." };
    case "resolve_architecture_warning":
      next.architectureWarnings = Math.max(0, next.architectureWarnings - 1);
      next.score = clampScore(next.score + 5);
      next.riskScore = clampScore(next.riskScore - 6);
      return { state: next, improvement: "Architecture warning resolved." };
  }
}

function stepSummary(
  action: RepositoryHealthSimulationAction,
  state: SimulationState,
): string {
  return `${action} projected score ${state.score} with ${riskLevel(state.riskScore)} risk.`;
}

function finalSummary(initialScore: number, finalScore: number): string {
  if (finalScore > initialScore) {
    return `Repository health improves by ${finalScore - initialScore} points.`;
  }
  if (finalScore < initialScore) {
    return `Repository health declines by ${initialScore - finalScore} points.`;
  }
  return "Repository health remains stable.";
}

export function simulateRepositoryHealthTimeline(
  input: RepositoryHealthTimelineSimulatorInput,
): RepositoryHealthTimelineSimulation {
  let state = initialState(input.report);
  const initialScore = state.score;
  const timeline: RepositoryHealthTimelineStep[] = [];
  const improvements: string[] = [];

  input.actions.forEach((action, index) => {
    const result = applyAction(state, action);
    state = result.state;
    improvements.push(result.improvement);
    timeline.push({
      step: index + 1,
      action,
      score: state.score,
      riskLevel: riskLevel(state.riskScore),
      aiReadiness: readinessLevel(state.readinessScore, state.blockers),
      summary: stepSummary(action, state),
    });
  });

  return {
    repositoryId: repositoryIdFor(input.report),
    initialScore,
    finalScore: state.score,
    timeline,
    improvements: sortedUnique(improvements),
    remainingBlockers: sortedUnique(state.blockers),
    estimatedReadiness: readinessLevel(state.readinessScore, state.blockers),
    summary: finalSummary(initialScore, state.score),
  };
}
