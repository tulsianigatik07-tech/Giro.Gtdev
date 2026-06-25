export interface ArchitectureHistoryEntry {
  repositoryId: string;
  generatedAt: string;
  report: unknown;
}

const historyStore = new Map<string, ArchitectureHistoryEntry[]>();

export function addArchitectureHistory(
  entry: ArchitectureHistoryEntry,
): void {
  const existing = historyStore.get(entry.repositoryId) ?? [];

  historyStore.set(entry.repositoryId, [
    ...existing,
    { ...entry },
  ]);
}

export function getArchitectureHistory(
  repositoryId: string,
): ArchitectureHistoryEntry[] {
  const history = historyStore.get(repositoryId) ?? [];

  return history.map((entry) => ({
    ...entry,
  }));
}

export function getLatestArchitectureHistory(
  repositoryId: string,
): ArchitectureHistoryEntry | null {
  const history = historyStore.get(repositoryId);

  if (!history || history.length === 0) {
    return null;
  }

  const latest = history.at(-1);

  if (!latest) {
    return null;
  }

  return {
    ...latest,
  };
}
export function getArchitectureHistoryCount(
  repositoryId: string,
): number {
  return historyStore.get(repositoryId)?.length ?? 0;
}

export function clearArchitectureHistory(
  repositoryId: string,
): void {
  historyStore.delete(repositoryId);
}