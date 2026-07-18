import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TopNav } from "@/components/layout/top-nav";
import { RepositorySearch } from "@/features/repositories/repository-search";
import { indexedEvidenceResultKey } from "@/features/repositories/repository-search-results";
import { repositoryKeys } from "@/hooks/use-repositories";
import { ApiClientError } from "@/services/api/client";
import type { HybridRetrievalResult, RepositorySummary } from "@/types/api";

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
vi.mock("@/hooks/use-repositories", () => ({
  repositoryKeys: {
    all: ["repositories"] as const,
    summary: (owner: string, repo: string) =>
      ["repository", owner, repo, "summary"] as const,
  },
  useRepositories: () => mocks.repositoriesState,
}));
vi.mock("@/hooks/use-sessions", () => ({ useSessions: () => ({ data: { sessions: [] } }) }));
vi.mock("@/services/api/retrieval", () => ({ retrievalApi: { inspect: mocks.retrievalInspect } }));

const cachedSummary: RepositorySummary = {
  repositoryId: "acme/platform",
  repositoryVersion: "job-1:1",
  generatedAt: "2026-07-18T00:00:00Z",
  purpose: "Repository intelligence",
  services: [{ name: "authentication", path: "src/auth.ts", kind: "service", reason: "Authentication service" }],
  entrypoints: [{ name: "server", path: "src/index.ts", kind: "entrypoint" }],
};

function wrapper(summary: RepositorySummary | undefined = cachedSummary) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (summary) client.setQueryData(repositoryKeys.summary("acme", "platform"), { summary });
  return function TestProvider({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const successfulSearch: HybridRetrievalResult = {
  query: "authentication",
  repository: "acme/platform",
  results: [
    { repository: "acme/platform", filePath: "src/auth.ts", language: "typescript", content: "AUTHENTICATION_EVIDENCE", startLine: 1, endLine: 4, score: 0.8, source: "semantic", signals: { semantic: 0.8 }, chunkId: "auth-chunk" },
    { repository: "acme/platform", filePath: "src/session.ts", language: "typescript", content: "SESSION_SYMBOL_EVIDENCE", startLine: 8, endLine: 12, score: 0.7, source: "symbol", signals: { symbol: 0.7 }, chunkId: "session-chunk", symbol: "createSession" },
  ],
  stats: { semanticResults: 1, keywordResults: 0, symbolResults: 1, graphBoosted: 0, returned: 2 },
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
    expect(await screen.findByRole("heading", { name: "Repository Intelligence" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Indexed Evidence" })).toBeInTheDocument();
    expect(screen.getByText("AUTHENTICATION_EVIDENCE")).toBeInTheDocument();
    expect(screen.getAllByText("authentication")).not.toHaveLength(0);
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

  it("preserves backend evidence ordering and filters without reranking", async () => {
    mocks.currentSearchParams = "q=authentication";
    const initialView = render(<RepositorySearch owner="acme" repo="platform" />, { wrapper: wrapper() });
    const evidenceList = await screen.findByRole("listbox", { name: "Indexed Evidence results" });
    expect(within(evidenceList).getAllByRole("option").map((option) => option.getAttribute("aria-label"))).toEqual([
      "src/auth.ts, lines 1 to 4, score 0.800",
      "src/session.ts, lines 8 to 12, score 0.700",
    ]);
    initialView.unmount();

    mocks.currentSearchParams = "q=authentication&kind=symbol";
    const view = render(<RepositorySearch owner="acme" repo="platform" />, { wrapper: wrapper() });
    const symbolEvidenceList = await screen.findByRole("listbox", { name: "Indexed Evidence results" });
    expect(within(symbolEvidenceList).getByRole("option", { name: /src\/session.ts/ })).toBeInTheDocument();
    expect(within(symbolEvidenceList).queryByRole("option", { name: /src\/auth.ts/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Code Evidence" }));
    const filterTarget = new URL(mocks.routerPush.mock.calls.at(-1)?.[0] as string, "http://giro.test");
    expect(filterTarget.searchParams.get("kind")).toBe("code");
    view.unmount();
  });

  it("stores evidence selection in the URL and restores its detail", async () => {
    mocks.currentSearchParams = "q=authentication";
    const view = render(<RepositorySearch owner="acme" repo="platform" />, { wrapper: wrapper() });
    const evidenceRow = await screen.findByRole("option", { name: /src\/session.ts/ });
    fireEvent.click(evidenceRow);
    const target = new URL(mocks.routerPush.mock.calls.at(-1)?.[0] as string, "http://giro.test");
    expect(target.searchParams.get("result")).toBe(indexedEvidenceResultKey(successfulSearch.results[1]!));
    view.unmount();

    mocks.currentSearchParams = new URLSearchParams({
      q: "authentication",
      result: indexedEvidenceResultKey(successfulSearch.results[1]!),
    }).toString();
    render(<RepositorySearch owner="acme" repo="platform" />, { wrapper: wrapper() });
    const restored = await screen.findByRole("option", { name: /src\/session.ts/ });
    expect(restored).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("src/session.ts evidence details")).toHaveTextContent("SESSION_SYMBOL_EVIDENCE");
    await waitFor(() => expect(restored).toHaveFocus());
  });

  it("falls back safely for an invalid result value", async () => {
    mocks.currentSearchParams = "q=authentication&result=unknown";
    render(<RepositorySearch owner="acme" repo="platform" />, { wrapper: wrapper() });
    expect(await screen.findByRole("option", { name: /Services: authentication/ })).toHaveAttribute("aria-selected", "true");
  });

  it("handles summary, evidence, and overall empty states independently", async () => {
    mocks.currentSearchParams = "q=unmatched";
    mocks.retrievalInspect.mockResolvedValueOnce({ ...successfulSearch, query: "unmatched", results: [] });
    render(<RepositorySearch owner="acme" repo="platform" />, { wrapper: wrapper() });
    expect(await screen.findByText("No repository summary items matched this query.")).toBeInTheDocument();
    expect(screen.getByText("No indexed evidence was returned for this query.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "No repository results" })).toBeInTheDocument();
  });

  it("shows a repository-scoped header launcher without duplicating query state", () => {
    render(<TopNav />, { wrapper: wrapper() });
    expect(screen.getByRole("link", { name: "Search repository" })).toHaveAttribute(
      "href",
      "/repositories/acme/platform/search",
    );
  });
});
