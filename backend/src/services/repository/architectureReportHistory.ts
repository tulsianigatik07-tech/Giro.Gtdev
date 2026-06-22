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

  existing.push(entry);

  historyStore.set(entry.repositoryId, existing);
}

export function getArchitectureHistory(
  repositoryId: string,
): ArchitectureHistoryEntry[] {
  return historyStore.get(repositoryId) ?? [];
}

export function clearArchitectureHistory(
  repositoryId: string,
): void {
  historyStore.delete(repositoryId);
}