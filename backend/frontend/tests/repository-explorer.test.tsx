import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RepositoryExplorerDetail } from "@/features/repositories/repository-explorer-detail";
import { RepositoryExplorerList } from "@/features/repositories/repository-explorer-list";
import {
  extractRepositoryExplorerCategories,
  findRepositoryExplorerItem,
  normalizeRepositoryExplorerCategory,
  repositoryExplorerItemKey,
  sortRepositoryExplorerItems,
} from "@/lib/repository-explorer";
import type { RepositorySummary } from "@/types/api";

const summary: RepositorySummary = {
  repositoryId: "acme/platform",
  repositoryVersion: "job-1:1",
  generatedAt: "2026-07-18T00:00:00Z",
  purpose: "Repository intelligence",
  importantDirectories: [
    { name: "services", path: "src/services", kind: "directory", reason: "Service layer" },
    { name: "routes", path: "src/routes", kind: "directory", reason: "HTTP routes" },
  ],
  configFiles: [{ name: "package.json", path: "package.json", kind: "configuration" }],
  modules: [{ name: "createApp", path: "src/app.ts", kind: "function", reason: "Exported symbol" }],
  apiSurface: [],
  dependencyOverview: {
    totalNodes: 2,
    totalEdges: 1,
    centralModules: ["src/app.ts"],
    dependencyHotspots: [],
    circularDependencies: [["src/a.ts", "src/b.ts"]],
  },
};

describe("repository explorer helpers", () => {
  it("extracts and sorts real summary items with deterministic URL-safe keys", () => {
    const categories = extractRepositoryExplorerCategories("files", summary);
    expect(categories.map((category) => category.id)).toEqual(["importantDirectories", "configFiles"]);
    expect(categories[0]?.items.map((item) => item.path)).toEqual(["src/routes", "src/services"]);
    expect(categories[0]?.items[0]?.key).toBe(repositoryExplorerItemKey("importantDirectories", summary.importantDirectories?.[1] ?? { name: "routes" }));
    expect(categories[0]?.items[0]?.key).not.toMatch(/[\s/?#]/);
  });

  it("falls back safely for invalid category and item parameters", () => {
    const categories = extractRepositoryExplorerCategories("files", summary);
    const category = normalizeRepositoryExplorerCategory(categories, "unknown");
    const item = findRepositoryExplorerItem(category, "unknown");
    expect(category?.id).toBe("importantDirectories");
    expect(item?.path).toBe("src/routes");
  });

  it("normalizes dependency summary values without inventing detail fields", () => {
    const categories = extractRepositoryExplorerCategories("dependencies", summary);
    expect(categories[0]?.items[0]).toMatchObject({ name: "src/app.ts", category: "centralModules" });
    expect(categories[1]?.items[0]).toMatchObject({ name: "src/a.ts → src/b.ts", category: "circularDependencies" });
    expect(categories[1]?.items[0]?.path).toBeUndefined();
  });

  it("sorts without mutating the source items", () => {
    const source = [{ name: "zeta" }, { name: "alpha" }];
    expect(sortRepositoryExplorerItems(source).map((item) => item.name)).toEqual(["alpha", "zeta"]);
    expect(source.map((item) => item.name)).toEqual(["zeta", "alpha"]);
  });
});

describe("repository explorer components", () => {
  const categories = extractRepositoryExplorerCategories("files", summary);
  const selected = categories[0]?.items[0];

  it("exposes selected state and supports arrow-key selection", () => {
    const onSelect = vi.fn();
    render(<RepositoryExplorerList categories={categories} selectedKey={selected?.key} onSelect={onSelect} label="Important files and directories" />);
    const selectedRow = screen.getByRole("option", { name: /routes, src\/routes/ });
    expect(selectedRow).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(selectedRow, { key: "ArrowDown" });
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ path: "src/services" }));
  });

  it("renders only available detail fields", () => {
    if (!selected) throw new Error("Expected explorer fixture item");
    render(<RepositoryExplorerDetail item={selected} />);
    expect(screen.getByText("src/routes")).toBeInTheDocument();
    expect(screen.getByText("directory")).toBeInTheDocument();
    expect(screen.getByText("HTTP routes")).toBeInTheDocument();
    expect(screen.queryByText(/preview|documentation|relationships/i)).not.toBeInTheDocument();
  });
});
