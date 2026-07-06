import { getRepositoryHistory } from "./repositoryAnalysisHistory.js";
import {
  getSnapshot,
  type DeepReadonly,
  type RepositorySnapshot,
} from "./repositorySnapshotStore.js";

export type RepositoryComparisonTrend = "IMPROVING" | "STABLE" | "REGRESSING";

export interface RepositoryMetricComparison {
  before: number | null;
  after: number | null;
  delta: number | null;
  trend: RepositoryComparisonTrend;
}

export interface RepositoryStringSetChanges {
  added: readonly string[];
  removed: readonly string[];
  unchanged: readonly string[];
}

export interface RepositoryComparisonSummary {
  improvements: readonly string[];
  regressions: readonly string[];
  stable: readonly string[];
}

export interface RepositoryComparisonReport {
  repositoryId: string;
  beforeSnapshotId: string;
  afterSnapshotId: string;
  health: RepositoryMetricComparison;
  aiReadiness: RepositoryMetricComparison;
  risk: RepositoryMetricComparison;
  hotspotChanges: RepositoryStringSetChanges;
  blockerChanges: RepositoryStringSetChanges;
  recommendationChanges: RepositoryStringSetChanges;
  summary: RepositoryComparisonSummary;
  trend: RepositoryComparisonTrend;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRecord(value: unknown, key: string): UnknownRecord | null {
  if (!isRecord(value)) return null;
  const child = value[key];
  return isRecord(child) ? child : null;
}

function readArray(value: unknown, key: string): readonly unknown[] {
  if (!isRecord(value)) return [];
  const child = value[key];
  return Array.isArray(child) ? child : [];
}

function readNumberPath(value: unknown, path: readonly string[]): number | null {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return typeof current === "number" && Number.isFinite(current) ? current : null;
}

function firstNumber(value: unknown, paths: readonly (readonly string[])[]): number | null {
  for (const path of paths) {
    const found = readNumberPath(value, path);
    if (found !== null) return found;
  }
  return null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stableKey(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return null;

  return (
    stringValue(value.id) ??
    stringValue(value.title) ??
    stringValue(value.name) ??
    stringValue(value.description) ??
    null
  );
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort((a, b) => a.localeCompare(b)));
}

function extractHotspots(report: unknown): readonly string[] {
  const hotspots = readRecord(report, "hotspots");
  const items = hotspots ? readArray(hotspots, "hotspots") : readArray(report, "hotspots");
  return sortedUnique(items.map(stableKey).filter((value): value is string => value !== null));
}

function extractBlockers(report: unknown): readonly string[] {
  const risk = readRecord(report, "risk");
  const aiReadiness = readRecord(report, "aiReadiness");
  return sortedUnique([
    ...readArray(risk, "blockers").map(stableKey),
    ...readArray(aiReadiness, "blockers").map(stableKey),
    ...readArray(report, "blockers").map(stableKey),
  ].filter((value): value is string => value !== null));
}

function extractRecommendationValues(value: unknown): string[] {
  return readArray(value, "recommendations")
    .map(stableKey)
    .filter((item): item is string => item !== null);
}

function extractRecommendations(report: unknown): readonly string[] {
  return sortedUnique([
    ...extractRecommendationValues(report),
    ...extractRecommendationValues(readRecord(report, "recommendations")),
    ...extractRecommendationValues(readRecord(report, "aiReadiness")),
    ...extractRecommendationValues(readRecord(report, "health")),
  ]);
}

function setChanges(
  before: readonly string[],
  after: readonly string[],
): RepositoryStringSetChanges {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);

  return deepFreeze({
    added: sortedUnique(after.filter((item) => !beforeSet.has(item))),
    removed: sortedUnique(before.filter((item) => !afterSet.has(item))),
    unchanged: sortedUnique(after.filter((item) => beforeSet.has(item))),
  });
}

function trendForDelta(
  delta: number | null,
  higherIsBetter: boolean,
): RepositoryComparisonTrend {
  if (delta === null || delta === 0) return "STABLE";
  if (higherIsBetter) return delta > 0 ? "IMPROVING" : "REGRESSING";
  return delta < 0 ? "IMPROVING" : "REGRESSING";
}

function metricComparison(
  before: number | null,
  after: number | null,
  higherIsBetter: boolean,
): RepositoryMetricComparison {
  const delta = before === null || after === null ? null : after - before;
  return deepFreeze({
    before,
    after,
    delta,
    trend: trendForDelta(delta, higherIsBetter),
  });
}

function extractHealthScore(report: unknown): number | null {
  return firstNumber(report, [
    ["health", "score"],
    ["health", "summary", "healthScore"],
    ["summary", "healthScore"],
    ["healthScore"],
  ]);
}

function extractAiReadinessScore(report: unknown): number | null {
  return firstNumber(report, [
    ["aiReadiness", "score"],
    ["readiness", "score"],
    ["intelligence", "score"],
    ["aiReadinessScore"],
  ]);
}

function extractRiskScore(report: unknown): number | null {
  return firstNumber(report, [
    ["risk", "score"],
    ["riskScore"],
  ]);
}

function changeSignal(
  changes: RepositoryStringSetChanges,
  addedMessage: string,
  removedMessage: string,
): { improvements: string[]; regressions: string[] } {
  return {
    improvements: changes.removed.length > 0 ? [removedMessage] : [],
    regressions: changes.added.length > 0 ? [addedMessage] : [],
  };
}

function sortedSignals(values: readonly string[]): readonly string[] {
  return sortedUnique(values);
}

function buildSummary(input: {
  health: RepositoryMetricComparison;
  aiReadiness: RepositoryMetricComparison;
  risk: RepositoryMetricComparison;
  hotspotChanges: RepositoryStringSetChanges;
  blockerChanges: RepositoryStringSetChanges;
  recommendationChanges: RepositoryStringSetChanges;
}): RepositoryComparisonSummary {
  const improvements: string[] = [];
  const regressions: string[] = [];
  const stable: string[] = [];

  if (input.health.trend === "IMPROVING") improvements.push("Health improved.");
  if (input.health.trend === "REGRESSING") regressions.push("Health regressed.");
  if (input.health.trend === "STABLE") stable.push("Health is stable.");

  if (input.aiReadiness.trend === "IMPROVING") improvements.push("AI readiness improved.");
  if (input.aiReadiness.trend === "REGRESSING") regressions.push("AI readiness regressed.");
  if (input.aiReadiness.trend === "STABLE") stable.push("AI readiness is stable.");

  if (input.risk.trend === "IMPROVING") improvements.push("Risk decreased.");
  if (input.risk.trend === "REGRESSING") regressions.push("Risk increased.");
  if (input.risk.trend === "STABLE") stable.push("Risk is stable.");

  const hotspotSignals = changeSignal(
    input.hotspotChanges,
    "Hotspots were added.",
    "Hotspots were removed.",
  );
  improvements.push(...hotspotSignals.improvements);
  regressions.push(...hotspotSignals.regressions);

  const blockerSignals = changeSignal(
    input.blockerChanges,
    "Blockers were added.",
    "Blockers were removed.",
  );
  improvements.push(...blockerSignals.improvements);
  regressions.push(...blockerSignals.regressions);

  if (input.recommendationChanges.added.length > 0) {
    regressions.push("Recommendations were added.");
  }
  if (input.recommendationChanges.removed.length > 0) {
    improvements.push("Recommendations were removed.");
  }
  if (
    input.hotspotChanges.added.length === 0 &&
    input.hotspotChanges.removed.length === 0
  ) {
    stable.push("Hotspots are stable.");
  }
  if (
    input.blockerChanges.added.length === 0 &&
    input.blockerChanges.removed.length === 0
  ) {
    stable.push("Blockers are stable.");
  }
  if (
    input.recommendationChanges.added.length === 0 &&
    input.recommendationChanges.removed.length === 0
  ) {
    stable.push("Recommendations are stable.");
  }

  return deepFreeze({
    improvements: sortedSignals(improvements),
    regressions: sortedSignals(regressions),
    stable: sortedSignals(stable),
  });
}

function overallTrend(summary: RepositoryComparisonSummary): RepositoryComparisonTrend {
  if (summary.improvements.length > summary.regressions.length) return "IMPROVING";
  if (summary.regressions.length > summary.improvements.length) return "REGRESSING";
  return "STABLE";
}

function compareSnapshotOrder(
  a: DeepReadonly<RepositorySnapshot>,
  b: DeepReadonly<RepositorySnapshot>,
): number {
  return (
    a.sequence - b.sequence ||
    a.createdOrder - b.createdOrder ||
    a.snapshotId.localeCompare(b.snapshotId)
  );
}

function canonicalPair(
  snapshotA: DeepReadonly<RepositorySnapshot>,
  snapshotB: DeepReadonly<RepositorySnapshot>,
): [DeepReadonly<RepositorySnapshot>, DeepReadonly<RepositorySnapshot>] {
  if (snapshotA.snapshotId === snapshotB.snapshotId) return [snapshotA, snapshotB];

  const history = getRepositoryHistory(snapshotA.repositoryId);
  const byId = new Map(history.map((snapshot) => [snapshot.snapshotId, snapshot]));
  const canonicalA = byId.get(snapshotA.snapshotId) ?? snapshotA;
  const canonicalB = byId.get(snapshotB.snapshotId) ?? snapshotB;

  return compareSnapshotOrder(canonicalA, canonicalB) <= 0
    ? [canonicalA, canonicalB]
    : [canonicalB, canonicalA];
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): DeepReadonly<T> {
  if (typeof value !== "object" || value === null) {
    return value as DeepReadonly<T>;
  }

  if (seen.has(value)) {
    return value as DeepReadonly<T>;
  }

  seen.add(value);

  for (const key of Reflect.ownKeys(value)) {
    const child = (value as Record<PropertyKey, unknown>)[key];
    deepFreeze(child, seen);
  }

  return Object.freeze(value) as DeepReadonly<T>;
}

export function compareSnapshots(
  snapshotIdA: string,
  snapshotIdB: string,
): DeepReadonly<RepositoryComparisonReport> {
  const snapshotA = getSnapshot(snapshotIdA);
  const snapshotB = getSnapshot(snapshotIdB);

  if (!snapshotA) {
    throw new Error(`Snapshot not found: ${snapshotIdA}`);
  }
  if (!snapshotB) {
    throw new Error(`Snapshot not found: ${snapshotIdB}`);
  }
  if (snapshotA.repositoryId !== snapshotB.repositoryId) {
    throw new Error("Cannot compare snapshots from different repositories.");
  }

  const [before, after] = canonicalPair(snapshotA, snapshotB);
  const health = metricComparison(
    extractHealthScore(before.report),
    extractHealthScore(after.report),
    true,
  );
  const aiReadiness = metricComparison(
    extractAiReadinessScore(before.report),
    extractAiReadinessScore(after.report),
    true,
  );
  const risk = metricComparison(
    extractRiskScore(before.report),
    extractRiskScore(after.report),
    false,
  );
  const hotspotChanges = setChanges(
    extractHotspots(before.report),
    extractHotspots(after.report),
  );
  const blockerChanges = setChanges(
    extractBlockers(before.report),
    extractBlockers(after.report),
  );
  const recommendationChanges = setChanges(
    extractRecommendations(before.report),
    extractRecommendations(after.report),
  );
  const summary = buildSummary({
    health,
    aiReadiness,
    risk,
    hotspotChanges,
    blockerChanges,
    recommendationChanges,
  });

  return deepFreeze({
    repositoryId: before.repositoryId,
    beforeSnapshotId: before.snapshotId,
    afterSnapshotId: after.snapshotId,
    health,
    aiReadiness,
    risk,
    hotspotChanges,
    blockerChanges,
    recommendationChanges,
    summary,
    trend: overallTrend(summary),
  });
}
