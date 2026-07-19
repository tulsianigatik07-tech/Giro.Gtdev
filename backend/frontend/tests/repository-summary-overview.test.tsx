import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RepositorySummaryOverview } from "@/features/repositories/repository-summary-overview";
import type { RepositorySummary, RepositoryWorkspace } from "@/types/api";
import { repository } from "./fixtures";

const summary: RepositorySummary = {
  repositoryId: "acme/platform",
  repositoryVersion: "job-1:1",
  generatedAt: "2026-07-18T00:00:00Z",
  purpose: "A repository intelligence platform for understanding unfamiliar codebases.",
  languages: [{ name: "TypeScript" }],
  frameworks: [{ name: "Hono" }, { name: "Next.js" }],
  packageManagers: [{ name: "pnpm" }],
  testing: [{ name: "Vitest" }],
  deployment: [{ name: "Railway" }],
  dataStores: [{ name: "PostgreSQL" }],
  entrypoints: [{ name: "API server", path: "src/index.ts", reason: "Starts the Hono application." }],
  importantDirectories: [{ name: "Routes", path: "src/routes", reason: "HTTP route definitions." }],
  modules: [{ name: "Retrieval", path: "src/services/retrieval" }],
  services: [{ name: "Indexing", path: "src/services/indexing", reason: "Builds repository context." }],
  dependencyOverview: { totalNodes: 57, totalEdges: 93, centralModules: ["Sessions"], dependencyHotspots: [], circularDependencies: [] },
};

const workspace: RepositoryWorkspace = {
  repositoryId: "acme/platform",
  health: { score: 88, grade: "good", healthy: true, warnings: [], recommendations: [] },
  aiReadiness: { ready: true, score: 91, level: "ready", blockers: [], warnings: [], recommendations: [] },
};

describe("repository summary overview", () => {
  it("renders a narrative overview and repository purpose", () => {
    render(<RepositorySummaryOverview owner="acme" repo="platform" summary={summary} repository={repository} workspace={workspace} onAsk={vi.fn()} />);
    expect(screen.getByText(summary.purpose)).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Repository status and primary actions" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Repository health" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Primary actions" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Where to start reading" })).toBeInTheDocument();
  });

  it("renders the detected technology stack", () => {
    render(<RepositorySummaryOverview owner="acme" repo="platform" summary={summary} repository={repository} workspace={workspace} onAsk={vi.fn()} />);
    for (const technology of ["TypeScript", "Hono", "Next.js", "pnpm", "Vitest", "Railway", "PostgreSQL"]) {
      expect(screen.getByText(technology)).toBeInTheDocument();
    }
  });

  it("renders entry points with a real explorer destination", () => {
    render(<RepositorySummaryOverview owner="acme" repo="platform" summary={summary} repository={repository} workspace={workspace} onAsk={vi.fn()} />);
    expect(screen.getByText("API server")).toBeInTheDocument();
    expect(screen.getByText("Starts the Hono application.")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Explore API server" });
    expect(link).toHaveAttribute("href", expect.stringContaining("tab=architecture"));
    expect(link).toHaveAttribute("href", expect.stringContaining("category=entrypoints"));
  });

  it("renders repository health and readiness from the workspace DTO", () => {
    render(<RepositorySummaryOverview owner="acme" repo="platform" summary={summary} repository={repository} workspace={workspace} onAsk={vi.fn()} />);
    expect(screen.getByText("88/100 health score")).toBeInTheDocument();
    expect(screen.getByText("91/100 readiness")).toBeInTheDocument();
    expect(screen.getByText("42 files")).toBeInTheDocument();
    expect(screen.getByText("120 chunks · 88 symbols")).toBeInTheDocument();
  });

  it("renders existing destinations and invokes the real Ask Giro action", () => {
    const onAsk = vi.fn();
    render(<RepositorySummaryOverview owner="acme" repo="platform" summary={summary} repository={repository} workspace={workspace} onAsk={onAsk} />);
    expect(screen.getByRole("link", { name: /Search repository/ })).toHaveAttribute("href", "/repositories/acme/platform/search");
    expect(screen.getByRole("link", { name: /Open sessions/ })).toHaveAttribute("href", "/repositories/acme/platform?tab=sessions");
    expect(screen.getByRole("link", { name: /Inspect dependencies/ })).toHaveAttribute("href", "/repositories/acme/platform?tab=dependencies");
    expect(screen.getByRole("link", { name: /Review symbols/ })).toHaveAttribute("href", "/repositories/acme/platform?tab=symbols");
    fireEvent.click(screen.getByRole("button", { name: "Ask Giro" }));
    expect(onAsk).toHaveBeenCalledOnce();
  });

  it("handles missing optional backend fields without inventing analysis", () => {
    render(<RepositorySummaryOverview owner="acme" repo="platform" summary={{ repositoryId: "acme/platform", repositoryVersion: "job-1:1", generatedAt: "2026-07-18T00:00:00Z", purpose: "Small service." }} repository={repository} workspaceUnavailable onAsk={vi.fn()} />);
    expect(screen.getByText("Technology analysis is not available from the current summary.")).toBeInTheDocument();
    expect(screen.getByText("Repository structure analysis is not available from the current summary.")).toBeInTheDocument();
    expect(screen.getByText(/Not exposed by the current summary: technology stack, entry points, important paths, major modules/)).toBeInTheDocument();
    expect(screen.getByText(/Detailed health and readiness are temporarily unavailable/)).toBeInTheDocument();
    expect(screen.queryByText("Unknown runtime")).not.toBeInTheDocument();
  });
});
