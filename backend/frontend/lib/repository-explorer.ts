import type { RepositorySummary, RepositorySummaryItem } from "@/types/api";

export type RepositoryExplorerTab = "architecture" | "files" | "symbols" | "dependencies";

export interface RepositoryExplorerItem extends RepositorySummaryItem {
  category: string;
  categoryLabel: string;
  key: string;
}

export interface RepositoryExplorerCategory {
  id: string;
  label: string;
  items: RepositoryExplorerItem[];
}

type SummaryItemField = Exclude<keyof RepositorySummary, "repositoryId" | "repositoryVersion" | "generatedAt" | "purpose" | "dependencyOverview">;

const CATEGORY_DEFINITIONS: Record<Exclude<RepositoryExplorerTab, "dependencies">, Array<{ id: string; label: string; field: SummaryItemField }>> = {
  architecture: [
    { id: "languages", label: "Languages", field: "languages" },
    { id: "frameworks", label: "Frameworks", field: "frameworks" },
    { id: "packageManagers", label: "Package managers", field: "packageManagers" },
    { id: "applications", label: "Applications", field: "applications" },
    { id: "libraries", label: "Libraries", field: "libraries" },
    { id: "services", label: "Services", field: "services" },
    { id: "entrypoints", label: "Entry points", field: "entrypoints" },
    { id: "backgroundWorkers", label: "Background workers", field: "backgroundWorkers" },
    { id: "dataStores", label: "Data stores", field: "dataStores" },
    { id: "authentication", label: "Authentication", field: "authentication" },
    { id: "retrieval", label: "Retrieval", field: "retrieval" },
    { id: "indexing", label: "Indexing", field: "indexing" },
    { id: "testing", label: "Testing", field: "testing" },
    { id: "build", label: "Build", field: "build" },
    { id: "deployment", label: "Deployment", field: "deployment" },
  ],
  files: [
    { id: "importantDirectories", label: "Important directories", field: "importantDirectories" },
    { id: "configFiles", label: "Configuration files", field: "configFiles" },
  ],
  symbols: [
    { id: "modules", label: "Modules", field: "modules" },
    { id: "apiSurface", label: "API surface", field: "apiSurface" },
  ],
};

export function repositoryExplorerItemKey(category: string, item: RepositorySummaryItem): string {
  return [category, item.path ?? "", item.name, item.kind ?? "", item.reason ?? ""]
    .map((part) => encodeURIComponent(part))
    .join("~");
}

export function sortRepositoryExplorerItems(items: readonly RepositorySummaryItem[]): RepositorySummaryItem[] {
  return [...items].sort(
    (left, right) =>
      (left.path ?? left.name).localeCompare(right.path ?? right.name) ||
      left.name.localeCompare(right.name) ||
      (left.kind ?? "").localeCompare(right.kind ?? "") ||
      (left.reason ?? "").localeCompare(right.reason ?? ""),
  );
}

export function extractRepositoryExplorerCategories(
  tab: RepositoryExplorerTab,
  summary: RepositorySummary | undefined,
): RepositoryExplorerCategory[] {
  if (!summary) return [];

  if (tab === "dependencies") {
    const dependencyOverview = summary.dependencyOverview;
    if (!dependencyOverview) return [];
    return [
      dependencyCategory("centralModules", "Central modules", dependencyOverview.centralModules),
      dependencyCategory("dependencyHotspots", "Dependency hotspots", dependencyOverview.dependencyHotspots),
      dependencyCategory(
        "circularDependencies",
        "Circular dependencies",
        dependencyOverview.circularDependencies.map((cycle) => cycle.join(" → ")),
      ),
    ].filter((category) => category.items.length > 0);
  }

  return CATEGORY_DEFINITIONS[tab]
    .map(({ id, label, field }) => category(id, label, summary[field] ?? []))
    .filter((entry) => entry.items.length > 0);
}

export function normalizeRepositoryExplorerCategory(
  categories: readonly RepositoryExplorerCategory[],
  requestedCategory: string | null,
): RepositoryExplorerCategory | undefined {
  return categories.find((category) => category.id === requestedCategory) ?? categories[0];
}

export function findRepositoryExplorerItem(
  category: RepositoryExplorerCategory | undefined,
  requestedItem: string | null,
): RepositoryExplorerItem | undefined {
  if (!category) return undefined;
  return category.items.find((item) => item.key === requestedItem) ?? category.items[0];
}

function category(id: string, label: string, items: readonly RepositorySummaryItem[]): RepositoryExplorerCategory {
  return {
    id,
    label,
    items: sortRepositoryExplorerItems(items).map((item) => ({
      ...item,
      category: id,
      categoryLabel: label,
      key: repositoryExplorerItemKey(id, item),
    })),
  };
}

function dependencyCategory(id: string, label: string, values: readonly string[]): RepositoryExplorerCategory {
  return category(id, label, values.map((name) => ({ name })));
}
