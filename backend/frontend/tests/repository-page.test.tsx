import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RepositoryOverview } from "@/features/repositories/repository-overview";
import { repositoryExplorerItemKey } from "@/lib/repository-explorer";
import { repository } from "./fixtures";

const routerPush = vi.fn();
let currentSearchParams = "";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush }),
  useSearchParams: () => new URLSearchParams(currentSearchParams),
}));
vi.mock("@/hooks/use-sessions", () => ({
  useCreateSession: () => ({ mutateAsync: vi.fn(), isPending: false, isError: false }),
  useSessions: () => ({ data: { sessions: [] }, isLoading: false, isError: false, refetch: vi.fn() }),
}));
vi.mock("@/hooks/use-repositories", () => ({
  useRepositories: () => ({ data: { repositories: [repository], count: 1 } }),
  useRepository: () => ({
    isLoading: false,
    isError: false,
      data: {
        summary: {
          repositoryVersion: "job-1:1",
          purpose: "A repository intelligence platform",
          languages: [{ name: "TypeScript" }],
          frameworks: [{ name: "Hono" }],
          apiSurface: [{ name: "sessions" }],
          entrypoints: [{ name: "server", path: "src/index.ts", kind: "server" }],
          packageManagers: undefined,
          dependencyOverview: {
            centralModules: ["retrieval"],
            totalNodes: 57,
            totalEdges: 93,
            dependencyHotspots: [],
            circularDependencies: [],
          },
        },
      },
    refetch: vi.fn(),
  }),
}));

describe("repository page", () => {
  beforeEach(() => {
    currentSearchParams = "";
    routerPush.mockReset();
  });

  it("renders overview, intelligence, entrypoints, and indexing metadata", () => {
    currentSearchParams = "tab=architecture";
    render(<RepositoryOverview owner="acme" repo="platform" />);
    expect(screen.getByRole("heading", { name: "platform" })).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(7);
    expect(screen.getByText("A repository intelligence platform")).toBeInTheDocument();
    expect(screen.getByText(/job-1:1/)).toBeInTheDocument();
    expect(screen.getAllByText("TypeScript")).not.toHaveLength(0);
    expect(screen.getByText("src/index.ts")).toBeInTheDocument();
  });

  it("gracefully renders a summary with optional sections omitted", () => {
    render(<RepositoryOverview owner="acme" repo="platform" />);
    expect(screen.queryByText("Package managers")).not.toBeInTheDocument();
    expect(screen.queryByText("Not detected")).not.toBeInTheDocument();
    expect(screen.getByText("A repository intelligence platform")).toBeInTheDocument();
  });

  it("restores the active repository tab from the URL", () => {
    currentSearchParams = "tab=architecture";
    render(<RepositoryOverview owner="acme" repo="platform" />);
    expect(screen.getByRole("tab", { name: "Architecture" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("src/index.ts")).toBeInTheDocument();
  });

  it("falls back to Summary for an unsupported tab value", () => {
    currentSearchParams = "tab=unknown";
    render(<RepositoryOverview owner="acme" repo="platform" />);
    expect(screen.getByRole("tab", { name: "Summary" })).toHaveAttribute("aria-selected", "true");
  });

  it("navigates tab changes while preserving other URL parameters", () => {
    currentSearchParams = "view=compact&tab=summary";
    render(<RepositoryOverview owner="acme" repo="platform" />);
    fireEvent.click(screen.getByRole("tab", { name: "Symbols" }));
    expect(routerPush).toHaveBeenCalledWith(
      "/repositories/acme/platform?view=compact&tab=symbols",
      { scroll: false },
    );
  });

  it("restores an explorer item from category and item URL parameters", () => {
    const entrypoint = { name: "server", path: "src/index.ts", kind: "server" };
    currentSearchParams = new URLSearchParams({
      tab: "architecture",
      category: "entrypoints",
      item: repositoryExplorerItemKey("entrypoints", entrypoint),
    }).toString();
    render(<RepositoryOverview owner="acme" repo="platform" />);
    expect(screen.getByRole("option", { name: "Entry points: server, src/index.ts" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("server details")).toHaveTextContent("src/index.ts");
  });
});
