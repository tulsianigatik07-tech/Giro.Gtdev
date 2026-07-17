import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RepositoryOverview } from "@/features/repositories/repository-overview";
import { repository } from "./fixtures";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/use-sessions", () => ({ useCreateSession: () => ({ mutateAsync: vi.fn(), isPending: false, isError: false }) }));
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
  it("renders overview, intelligence, entrypoints, and indexing metadata", () => {
    render(<RepositoryOverview owner="acme" repo="platform" />);
    expect(screen.getByRole("heading", { name: "platform" })).toBeInTheDocument();
    expect(screen.getByText("A repository intelligence platform")).toBeInTheDocument();
    expect(screen.getByText("TypeScript")).toBeInTheDocument();
    expect(screen.getByText("src/index.ts")).toBeInTheDocument();
    expect(screen.getByText("job-1:1")).toBeInTheDocument();
  });

  it("gracefully renders a summary with optional sections omitted", () => {
    render(<RepositoryOverview owner="acme" repo="platform" />);
    expect(screen.getAllByText("Not detected").length).toBeGreaterThan(0);
    expect(screen.getByText("A repository intelligence platform")).toBeInTheDocument();
  });
});
