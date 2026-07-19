import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  createSession: vi.fn(),
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
vi.mock("@/hooks/use-sessions", () => ({
  useSessions: () => ({ data: { sessions: [] }, isLoading: false, isError: false }),
  useCreateSession: () => ({ mutateAsync: mocks.createSession, isPending: false, isError: false }),
}));
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
  beforeAll(() => {
    HTMLDialogElement.prototype.showModal = function showModal() { this.setAttribute("open", ""); };
    HTMLDialogElement.prototype.close = function close() { this.removeAttribute("open"); this.dispatchEvent(new Event("close")); };
  });

  beforeEach(() => {
    mocks.currentPathname = "/repositories/acme/platform/search";
    mocks.currentSearchParams = "";
    mocks.routerPush.mockReset();
    mocks.retrievalInspect.mockReset().mockResolvedValue(successfulSearch);
    mocks.createSession.mockReset().mockResolvedValue({ id: "new-session" });
    vi.mocked(window.matchMedia).mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
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

  it("populates the field from realistic query examples without submitting", () => {
    render(<RepositorySearch owner="acme" repo="platform" />, { wrapper: wrapper() });
    fireEvent.click(screen.getByRole("button", { name: "authentication flow" }));
    expect(screen.getByLabelText("Search repository")).toHaveValue("authentication flow");
    expect(screen.getByLabelText("Search repository")).toHaveFocus();
    expect(mocks.routerPush).not.toHaveBeenCalled();
    expect(mocks.retrievalInspect).not.toHaveBeenCalled();
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
    expect(await screen.findByRole("heading", { name: "Repository intelligence" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Indexed evidence" })).toBeInTheDocument();
    expect(screen.getByText("AUTHENTICATION_EVIDENCE")).toBeInTheDocument();
    expect(screen.getAllByText("authentication")).not.toHaveLength(0);
    expect(screen.getByRole("button", { name: "Ask Giro about this result" })).toBeInTheDocument();
  });

  it("stays idle for an empty query", () => {
    render(<RepositorySearch owner="acme" repo="platform" />, { wrapper: wrapper() });
    expect(screen.getByRole("heading", { name: "Ready to search this repository" })).toBeInTheDocument();
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
    expect(screen.getByRole("link", { name: "View indexing" })).toHaveAttribute(
      "href",
      "/repositories/acme/platform/indexing",
    );
    expect(screen.queryByRole("button", { name: "Ask Giro about this" })).not.toBeInTheDocument();
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
    expect(await screen.findByRole("heading", { name: "Repository search unavailable" })).toBeInTheDocument();
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
    expect(screen.getByLabelText("src/session.ts evidence details")).toHaveTextContent("lines 8–12");
    expect(screen.getByLabelText("src/session.ts evidence details")).toHaveTextContent("createSession");
    expect(screen.getByLabelText("src/session.ts evidence details")).toHaveTextContent("score 0.700");
    await waitFor(() => expect(restored).toHaveFocus());
  });

  it("opens selected evidence in a narrow detail sheet and restores focus on Escape", async () => {
    vi.mocked(window.matchMedia).mockImplementation((query) => ({
      matches: query === "(max-width: 1080px)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    mocks.currentSearchParams = "q=authentication";
    render(<RepositorySearch owner="acme" repo="platform" />, { wrapper: wrapper() });
    const result = await screen.findByRole("option", { name: /src\/session.ts/ });
    result.focus();
    fireEvent.click(result);
    const sheet = screen.getByRole("dialog", { name: "Selected search result" });
    expect(sheet).toHaveTextContent("SESSION_SYMBOL_EVIDENCE");
    fireEvent(sheet, new Event("cancel", { cancelable: true }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Selected search result" })).not.toBeInTheDocument());
    expect(result).toHaveFocus();
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
    expect(await screen.findByRole("heading", { name: "Refine the search, not the repository" })).toBeInTheDocument();
    expect(screen.getByText(/simpler terms, a file or symbol name/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Return to search field" }));
    expect(screen.getByLabelText("Search repository")).toHaveFocus();
  });

  it("renders a result-shaped skeleton while retrieval is pending", async () => {
    mocks.currentSearchParams = "q=authentication";
    mocks.retrievalInspect.mockReturnValueOnce(new Promise(() => undefined));
    render(<RepositorySearch owner="acme" repo="platform" />, { wrapper: wrapper() });
    expect(await screen.findByRole("status", { name: "Searching acme/platform" })).toBeInTheDocument();
    expect(screen.queryByText("Checking repository readiness…")).not.toBeInTheDocument();
  });

  it("hands the selected evidence to Ask Giro", async () => {
    mocks.currentSearchParams = new URLSearchParams({
      q: "authentication",
      result: indexedEvidenceResultKey(successfulSearch.results[1]!),
    }).toString();
    render(<RepositorySearch owner="acme" repo="platform" />, { wrapper: wrapper() });
    fireEvent.click(await screen.findByRole("button", { name: "Ask Giro about this evidence" }));
    fireEvent.click(await screen.findByRole("radio", { name: /New session/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(mocks.createSession).toHaveBeenCalledWith({ owner: "acme", repo: "platform", title: "createSession" }));
    expect(mocks.routerPush.mock.calls.at(-1)?.[0]).toContain("draft=Explain+how+createSession+in+src%2Fsession.ts+works.");
  });

  it("shows a repository-scoped header launcher without duplicating query state", () => {
    render(<TopNav />, { wrapper: wrapper() });
    expect(screen.getByRole("link", { name: "Search repository" })).toHaveAttribute(
      "href",
      "/repositories/acme/platform/search",
    );
  });
});
