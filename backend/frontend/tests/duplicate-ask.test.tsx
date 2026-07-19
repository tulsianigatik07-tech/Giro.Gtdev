import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatWorkspace } from "@/features/chat/chat-workspace";
import { citation, session } from "./fixtures";

const ask = vi.fn();
const retrieval = {
  query: "Where does the application start?",
  repository: "acme/platform",
  results: [],
  stats: { semanticResults: 0, keywordResults: 0, symbolResults: 0, graphBoosted: 0, returned: 0 },
};
const refetch = vi.fn().mockResolvedValue(undefined);
const routerPush = vi.fn();
const routerReplace = vi.fn();
let currentSearchParams = "";

vi.mock("next/navigation", () => ({
  usePathname: () => `/chat/${session.id}`,
  useRouter: () => ({ push: routerPush, replace: routerReplace }),
  useSearchParams: () => new URLSearchParams(currentSearchParams),
}));
vi.mock("@/features/auth/auth-context", () => ({ useAuth: () => ({ token: "token" }) }));
vi.mock("@/hooks/use-sessions", () => ({
  sessionKeys: { all: ["sessions"] },
  useSession: () => ({ data: session, isLoading: false, isError: false, refetch }),
  useSessions: () => ({ data: { sessions: [{
    id: session.id, userId: session.userId, owner: session.owner, repo: session.repo,
    title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt, messageCount: 0,
  }] } }),
  useCreateSession: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteSession: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/use-repositories", () => ({ useRepository: () => ({ data: undefined }), useRepositories: () => ({ data: { repositories: [{ owner: "acme", repo: "platform", status: "indexed" }] }, isLoading: false }) }));
vi.mock("@/services/api/sessions", () => ({ sessionsApi: { ask: (...args: unknown[]) => ask(...args) } }));

describe("session ask integration", () => {
  beforeEach(() => {
    ask.mockReset();
    routerPush.mockReset();
    routerReplace.mockReset();
    currentSearchParams = "";
  });

  it("prevents duplicate ask requests while the first request is in flight", async () => {
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
    let finish!: (value: unknown) => void;
    ask.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><ChatWorkspace sessionId={session.id} /></QueryClientProvider>);
    const suggestion = screen.getByRole("button", { name: "Where does authentication start?" });
    fireEvent.click(suggestion);
    const composer = screen.getByLabelText("Ask a repository question");
    expect(composer).toHaveValue("Where does authentication start?");
    const form = composer.closest("form");
    expect(form).not.toBeNull();
    act(() => {
      fireEvent.submit(form as HTMLFormElement);
      fireEvent.submit(form as HTMLFormElement);
    });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith("token", session.id, "Where does authentication start?");
    finish({
      answer: "Grounded answer",
      sources: [],
      citations: [citation],
      metadata: { retrievedFiles: 1, usedSummary: false, usedDependencyGraph: false, retrievalSourceCounts: { semantic: 1, keyword: 0, symbol: 0, graph: 0, fileSearch: 0 }, estimatedContextTokens: 100 },
      retrieval,
    });
    await waitFor(() => expect(refetch).toHaveBeenCalled());
  });

  it("adopts a URL draft, preserves from, and removes draft without asking", async () => {
    const from = "/repositories/acme/platform?tab=architecture";
    currentSearchParams = new URLSearchParams({
      draft: "Explain how execution begins at src/index.ts.",
      from,
    }).toString();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<QueryClientProvider client={client}><ChatWorkspace sessionId={session.id} /></QueryClientProvider>);

    expect(screen.getByLabelText("Ask a repository question")).toHaveValue("Explain how execution begins at src/index.ts.");
    expect(ask).not.toHaveBeenCalled();
    expect(routerReplace).toHaveBeenCalledTimes(1);
    expect(routerReplace).toHaveBeenCalledWith(
      `/chat/${session.id}?${new URLSearchParams({ from }).toString()}`,
      { scroll: false },
    );

    view.unmount();
    currentSearchParams = new URLSearchParams({ from }).toString();
    render(<QueryClientProvider client={client}><ChatWorkspace sessionId={session.id} /></QueryClientProvider>);
    expect(screen.getByLabelText("Ask a repository question")).toHaveValue("");
    expect(ask).not.toHaveBeenCalled();
  });
});
