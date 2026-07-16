import { repositoryRelativePath } from "../citations.js";
import type { EnrichedContextChunk } from "../../context/contextTypes.js";
import type {
  PublicRetrievalConfidence,
  RetrievalConfidenceCandidate,
  RetrievalConfidenceInput,
  RetrievalConfidenceReasonCode,
  RetrievalConfidenceResult,
  RetrievalConfidenceThresholds,
  RetrievalConfidenceWarningCode,
} from "./confidenceTypes.js";

const SUMMARY_PATH = "__repository_summary__";
const STRONG_SCORE = 0.75;
const WEAK_SCORE = 0.35;
const SIGNAL_AGREEMENT_THRESHOLD = 0.5;
const LOW_SCORE_GAP = 0.08;

function clamp01(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function boundedCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.min(1_000_000, Math.max(0, Math.trunc(value)));
}

function validateThresholds(
  thresholds: RetrievalConfidenceThresholds,
): RetrievalConfidenceThresholds {
  const values = Object.values(thresholds);
  if (values.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
    throw new TypeError("retrieval confidence thresholds must be between zero and one");
  }
  if (!(thresholds.high >= thresholds.medium && thresholds.medium >= thresholds.low)) {
    throw new TypeError("retrieval confidence thresholds must be ordered high >= medium >= low");
  }
  return thresholds;
}

function normalizedModule(candidate: RetrievalConfidenceCandidate): string {
  if (candidate.moduleName?.trim()) return candidate.moduleName.trim();
  const normalized = candidate.filePath.replaceAll("\\", "/").replace(/^\.\//, "");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? "unknown";
  return parts.slice(0, Math.min(2, parts.length - 1)).join("/");
}

function sources(candidate: RetrievalConfidenceCandidate): string[] {
  const explicit = candidate.retrievalSources?.filter((source) => source.trim()) ?? [];
  if (explicit.length > 0) return [...new Set(explicit)];
  const signals = candidate.signals ?? {};
  return (["semantic", "keyword", "symbol", "graph"] as const)
    .filter((key) => clamp01(signals[key]) > 0);
}

function signalAgreement(candidate: RetrievalConfidenceCandidate): number {
  const signals = candidate.signals ?? {};
  const strengths = (["semantic", "keyword", "symbol", "graph"] as const)
    .map((key) => clamp01(signals[key]));
  const strongest = Math.max(0, ...strengths);
  const agreeing = strengths.filter((value) => value >= SIGNAL_AGREEMENT_THRESHOLD).length;
  return clamp01(strongest * (agreeing / 4));
}

function hasValidCitation(
  candidate: RetrievalConfidenceCandidate,
  citation: RetrievalConfidenceInput["citations"][number],
): boolean {
  if (candidate.repositorySummary || candidate.filePath === SUMMARY_PATH) return false;
  const relativePath = repositoryRelativePath(candidate.filePath, candidate.repositoryId);
  if (!relativePath || citation.repositoryId !== candidate.repositoryId) return false;
  if (citation.relativeFilePath !== relativePath) return false;
  if (citation.startLine < candidate.startLine || citation.endLine > candidate.endLine) return false;
  if (!citation.repositoryVersion.trim()) return false;
  if (
    candidate.repositoryVersion?.trim() &&
    citation.repositoryVersion !== candidate.repositoryVersion
  ) return false;
  return true;
}

function confidenceLevel(
  score: number,
  thresholds: RetrievalConfidenceThresholds,
): RetrievalConfidenceResult["level"] {
  if (score >= thresholds.high) return "high";
  if (score >= thresholds.medium) return "medium";
  if (score >= thresholds.low) return "low";
  return "insufficient";
}

function freezeResult(result: RetrievalConfidenceResult): RetrievalConfidenceResult {
  Object.freeze(result.reasons);
  Object.freeze(result.warnings);
  Object.freeze(result.evidence);
  return Object.freeze(result);
}

/**
 * Exact calibrated formula (all terms are normalized to 0..1):
 *
 * positive = 0.30*topScore + 0.15*topSignalAgreement
 *          + 0.20*citationCoverage + 0.10*secondBestScore
 *          + 0.05*crossFileSupport + 0.05*sourceDiversity
 *          + 0.05*scoreGap + 0.05*primaryQueryEvidence
 *          + 0.05*versionBackedEvidence
 *
 * penalty  = 0.15*expansionDependency + 0.20*summaryOnlyRatio
 *          + 0.08*duplicateSuppressionRatio + 0.12*budgetDropRatio
 *          + 0.15*unsafeCitationRatio + 0.10*conflictingSignalRatio
 *
 * finalScore = clamp01(positive - penalty)
 *
 * Candidate count never contributes directly. Additional evidence helps only
 * through a strong second candidate, grounded coverage, or bounded diversity.
 */
export function evaluateRetrievalConfidence(
  input: RetrievalConfidenceInput,
): RetrievalConfidenceResult {
  const thresholds = validateThresholds(input.thresholds);
  const candidates = input.candidates.map((candidate) => ({
    ...candidate,
    signals: candidate.signals ? { ...candidate.signals } : undefined,
    retrievalSources: candidate.retrievalSources
      ? [...candidate.retrievalSources]
      : undefined,
  }));
  const candidateCount = boundedCount(candidates.length);
  const budgetDropCount = boundedCount(input.budgetDropCount);
  const duplicateSuppressionCount = boundedCount(input.duplicateSuppressionCount);

  if (candidateCount === 0) {
    return freezeResult({
      level: "insufficient",
      score: 0,
      answerable: false,
      reasons: ["no_retrieval_evidence"],
      evidence: {
        candidateCount: 0,
        citationCount: boundedCount(input.citations.length),
        uniqueFileCount: 0,
        uniqueModuleCount: 0,
        retrievalSourceCount: 0,
        topScore: 0,
        scoreGap: 0,
        citationCoverage: 0,
        expansionDependencyRatio: 0,
        budgetDropCount,
      },
      warnings: ["limited_evidence"],
    });
  }

  const ordered = [...candidates].sort((left, right) =>
    clamp01(right.finalScore) - clamp01(left.finalScore) ||
    left.filePath.localeCompare(right.filePath) ||
    left.startLine - right.startLine ||
    left.endLine - right.endLine
  );
  const top = ordered[0]!;
  const topScore = clamp01(top.finalScore);
  const secondScore = clamp01(ordered[1]?.finalScore);
  const scoreGap = ordered.length > 1 ? clamp01(topScore - secondScore) : topScore;
  const uniqueFiles = new Set(candidates.map((candidate) => candidate.filePath));
  const uniqueModules = new Set(candidates.map(normalizedModule));
  const retrievalSources = new Set(candidates.flatMap(sources));
  const directCandidates = candidates.filter((candidate) => !candidate.repositorySummary);
  const coveredCandidates = directCandidates.filter((candidate) =>
    input.citations.some((citation) => hasValidCitation(candidate, citation))
  );
  const citationCoverage = directCandidates.length > 0
    ? coveredCandidates.length / directCandidates.length
    : 0;
  const expansionDependencyRatio = candidates.filter((candidate) =>
    candidate.queryExpansionMatch === true && candidate.primaryQueryMatch !== true
  ).length / candidateCount;
  const summaryOnlyRatio = candidates.filter((candidate) =>
    candidate.repositorySummary || candidate.filePath === SUMMARY_PATH
  ).length / candidateCount;
  const conflictingSignalRatio = candidates.filter((candidate) =>
    candidate.conflictingSignals === true
  ).length / candidateCount;
  const primaryQueryEvidence = candidates.some((candidate) =>
    candidate.primaryQueryMatch === true
  ) ? 1 : candidates.some((candidate) => candidate.queryExpansionMatch === true) ? 0 : 0.5;
  const allVersions = [
    ...candidates.map((candidate) => candidate.repositoryVersion),
    ...input.citations.map((citation) => citation.repositoryVersion),
  ].filter((version): version is string => Boolean(version?.trim()));
  const versionSet = new Set(allVersions);
  const repositorySet = new Set(candidates.map((candidate) => candidate.repositoryId));
  const versionAvailable = versionSet.size === 1 && ![
    "unversioned",
    "version_unavailable",
  ].includes(allVersions[0] ?? "");
  const versionConsistent = versionSet.size <= 1 && repositorySet.size <= 1;
  const safeCitationCount = input.citations.filter((citation) =>
    citation.repositoryId.trim() &&
    citation.relativeFilePath.trim() &&
    citation.language.trim() &&
    citation.repositoryVersion.trim() &&
    Number.isInteger(citation.startLine) &&
    Number.isInteger(citation.endLine) &&
    citation.startLine >= 1 &&
    citation.endLine >= citation.startLine
  ).length;
  const unsafeCitationRatio = input.citations.length > 0
    ? 1 - safeCitationCount / input.citations.length
    : 1;
  const duplicateRatio = duplicateSuppressionCount /
    Math.max(1, candidateCount + duplicateSuppressionCount);
  const budgetDropRatio = budgetDropCount /
    Math.max(1, candidateCount + budgetDropCount);
  const crossFileSupport = uniqueFiles.size >= 2 ? secondScore : 0;
  const sourceDiversity = retrievalSources.size >= 2 ? secondScore : 0;

  const positive =
    0.30 * topScore +
    0.15 * signalAgreement(top) +
    0.20 * citationCoverage +
    0.10 * secondScore +
    0.05 * crossFileSupport +
    0.05 * sourceDiversity +
    0.05 * scoreGap +
    0.05 * primaryQueryEvidence +
    0.05 * (versionAvailable ? 1 : 0);
  const penalty =
    0.15 * expansionDependencyRatio +
    0.20 * summaryOnlyRatio +
    0.08 * duplicateRatio +
    0.12 * budgetDropRatio +
    0.15 * unsafeCitationRatio +
    0.10 * conflictingSignalRatio;
  const score = round6(clamp01(positive - penalty));

  const reasons: RetrievalConfidenceReasonCode[] = [];
  if (topScore >= STRONG_SCORE) reasons.push("strong_top_match");
  if (signalAgreement(top) >= 0.25) reasons.push("multi_signal_agreement");
  if (citationCoverage >= thresholds.minimumCitationCoverage) {
    reasons.push("strong_citation_coverage");
  }
  if (uniqueFiles.size >= 2 && secondScore >= WEAK_SCORE) reasons.push("cross_file_support");
  if (candidates.some((candidate) =>
    clamp01(candidate.signals?.symbol) >= SIGNAL_AGREEMENT_THRESHOLD ||
    clamp01(candidate.signals?.graph) >= SIGNAL_AGREEMENT_THRESHOLD
  )) reasons.push("symbol_graph_support");
  if (retrievalSources.size >= 2) reasons.push("diverse_retrieval_sources");
  if (topScore < WEAK_SCORE) reasons.push("weak_top_match");
  if (ordered.length > 1 && scoreGap < LOW_SCORE_GAP) reasons.push("low_score_separation");
  if (uniqueFiles.size === 1) reasons.push("single_file_dependency");
  if (safeCitationCount === 0) reasons.push("missing_citations");
  else if (citationCoverage < thresholds.minimumCitationCoverage) {
    reasons.push("low_citation_coverage");
  }
  if (expansionDependencyRatio >= 0.5) reasons.push("expansion_dependent");
  if (summaryOnlyRatio === 1) reasons.push("summary_only_evidence");
  if (budgetDropRatio > 0.5) reasons.push("excessive_budget_trimming");
  if (conflictingSignalRatio > 0) reasons.push("conflicting_signals");
  if (!versionAvailable) reasons.push("repository_version_unavailable");

  const warnings: RetrievalConfidenceWarningCode[] = [];
  if (score < thresholds.medium) warnings.push("limited_evidence");
  if (unsafeCitationRatio > 0 || citationCoverage < thresholds.minimumCitationCoverage) {
    warnings.push("citation_metadata_incomplete");
  }
  if (expansionDependencyRatio >= 0.5) warnings.push("expansion_reliant");
  if (budgetDropRatio > 0.5) warnings.push("budget_constrained");
  if (!versionAvailable) warnings.push("repository_version_unverified");
  if (!versionConsistent) warnings.push("repository_version_inconsistent");

  const level = confidenceLevel(score, thresholds);
  const answerable = Boolean(
    score >= thresholds.minimumAnswerableScore &&
    level !== "insufficient" &&
    safeCitationCount > 0 &&
    citationCoverage >= thresholds.minimumCitationCoverage &&
    summaryOnlyRatio < 1 &&
    versionConsistent,
  );

  return freezeResult({
    level,
    score,
    answerable,
    reasons,
    evidence: {
      candidateCount,
      citationCount: safeCitationCount,
      uniqueFileCount: uniqueFiles.size,
      uniqueModuleCount: uniqueModules.size,
      retrievalSourceCount: retrievalSources.size,
      topScore: round6(topScore),
      scoreGap: round6(scoreGap),
      citationCoverage: round6(citationCoverage),
      expansionDependencyRatio: round6(expansionDependencyRatio),
      budgetDropCount,
    },
    warnings,
  });
}

export function toPublicRetrievalConfidence(
  result: RetrievalConfidenceResult,
): PublicRetrievalConfidence {
  return Object.freeze({
    level: result.level,
    score: result.score,
    answerable: result.answerable,
    reasons: Object.freeze([...result.reasons]),
  });
}

export function enrichedChunksToConfidenceCandidates(
  repositoryId: string,
  chunks: readonly EnrichedContextChunk[],
): RetrievalConfidenceCandidate[] {
  return chunks.map((chunk) => ({
    repositoryId,
    repositoryVersion: chunk.repositoryVersion,
    filePath: chunk.filePath,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    finalScore: chunk.score,
    signals: {
      semantic: chunk.signals.semantic,
      keyword: chunk.signals.keyword,
      symbol: chunk.signals.symbol,
      graph: chunk.signals.graph,
    },
    retrievalSources: [
      chunk.source,
      ...(["semantic", "keyword", "symbol", "graph"] as const)
        .filter((source) => clamp01(chunk.signals[source]) > 0),
    ],
    primaryQueryMatch: chunk.primaryQueryMatch,
    queryExpansionMatch: chunk.queryExpansionMatch,
    stitchedNeighborCount: chunk.stitchedNeighborCount,
    repositorySummary: chunk.filePath === SUMMARY_PATH,
  }));
}
