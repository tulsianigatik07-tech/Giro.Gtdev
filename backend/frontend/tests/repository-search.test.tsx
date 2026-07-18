import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TopNav } from "@/components/layout/top-nav";
import { RepositorySearch } from "@/features/repositories/repository-search";
import { ApiClientError } from "@/services/api/client";

const mocks = vi.hoisted(() => ({
  currentPathname: "/repositories/acme/platform/search",
  currentSearchParams: "",
  routerPush: vi.fn(),
  retrievalInspect: vi.fn(),
  repositoriesState: {} as Record<string, unknown>,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.currentPathname,
  useRouter: () => ({ push: mocks.routerPush }),
  useSearchParams: () => new URLSearchParams(mocks.currentSearchParams),
}));
vi.mock("@/features/auth/auth-context", () => ({ useAuth: () => ({ token: "token" }) }));
vi.mock("@/hooks/use-repositories", () => ({ useRepositories: () => mocks.repositoriesState }));
vi.mock("@/hooks/use-sessions", () => ({ useSessions: () => ({ data: { sessions: [] } }) }));
vi.mock("@/services/api/retrieval", () => ({ retrievalApi: { inspect: mocks.retrievalInspect } }));

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function TestProvider({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const successfulSearch = {
  query: "authentication",
  repository: "acme/platform",
  results: [{ repository: "acme/platform", filePath: "src/auth.ts", language: "typescript", content: "UNRENDERED_EVIDENCE", startLine: 1, endLine: 4, score: 0.8, source: "semantic", signals: { semantic: 0.8 } }],
  stats: { semanticResults: 1, keywordResults: 0, symbolResults: 0, graphBoosted: 0, returned: 1 },
};

describe("repository search foundation", () => {
  beforeEach(() => {
    mocks.currentPathname = "/repositories/acme/platform/search";
    mocks.currentSearchParams = "";
    mocks.routerPush.mockReset();
    mocks.retrievalInspect.mockReset().mockResolvedValue(successfulSearch);
    mocks.repositoriesState = {
      data: { repositories: [{ owner: "acme", repo: "platform", status: "indexed", lastIndexedAt: "2026-07-18T00:00:00Z" }] },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    };
  });

  it("keeps typing local and writes the trimmed query only on submit", () => {
    render(<RepositorySearch owner="acme" repo="platform" />, { wrapper: wrapper() });
    const input = screen.getByLabelText("Search repository");
    fireEvent.change(input, { target: { value: "  authentication  " } });
    expect(mocks.routerPush).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(mocks.routerPush).toHaveBeenCalledWith(
      "/repositories/acme/platform/search?q=authentication",
      { scroll: false },
    );
  });

  it("restores a submitted query and executes repository-scoped retrieval", async () => {
    mocks.currentSearchParams = "q=authentication";
    render(<RepositorySearch owner="acme" repo="platform" />, { wrapper: wrapper() });
    expect(screen.getByLabelText("Search repository")).toHaveValue("authentication");
    await waitFor(() => expect(mocks.retrievalInspect).toHaveBeenCalledWith("token", {
      query: "authentication",
      owner: "acme",
      repo: "platform",
    }));
    expect(await screen.findByText("Repository search completed.")).toBeInTheDocument();
    expect(screen.queryByText("UNRENDERED_EVIDENCE")).not.toBeInTheDocument();
  });

  it("stays idle for an empty query", () => {
    render(<RepositorySearch owner="acme" repo="platform" />, { wrapper: wrapper() });
    expect(screen.getByText("Search indexed repository context")).toBeInTheDocument();
    expect(mocks.retrievalInspect).not.toHaveBeenCalled();
  });

  it("does not search before the repository is Ready", () => {
    mocks.currentSearchParams = "q=authentication";
    mocks.repositoriesState = {
      data: { repositories: [{ owner: "acme", repo: "platform", status: "indexing" }] },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    };
    render(<RepositorySearch owner="acme" repo="platform" />, { wrapper: wrapper() });
    expect(screen.getByText("Repository intelligence must be ready before searching.")).toBeInTheDocument();
    expect(mocks.retrievalInspect).not.toHaveBeenCalled();
  });

  it("rejects an over-limit URL query without issuing a request", () => {
    mocks.currentSearchParams = `q=${"x".repeat(501)}`;
    render(<RepositorySearch owner="acme" repo="platform" />, { wrapper: wrapper() });
    expect(screen.getByText("Search queries must contain at most 500 characters.")).toBeInTheDocument();
    expect(mocks.retrievalInspect).not.toHaveBeenCalled();
  });

  it("preserves an errored query and allows retry", async () => {
    mocks.currentSearchParams = "q=authentication";
    mocks.retrievalInspect.mockRejectedValueOnce(new ApiClientError({ code: "retrieval_error", message: "Retrieval unavailable", status: 500, retryable: true }));
    render(<RepositorySearch owner="acme" repo="platform" />, { wrapper: wrapper() });
    expect(screen.getByLabelText("Search repository")).toHaveValue("authentication");
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(mocks.retrievalInspect).toHaveBeenCalledTimes(2));
  });

  it("shows a repository-scoped header launcher without duplicating query state", () => {
    render(<TopNav />, { wrapper: wrapper() });
    expect(screen.getByRole("link", { name: "Search repository" })).toHaveAttribute(
      "href",
      "/repositories/acme/platform/search",
    );
  });
});
