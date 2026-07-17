import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { ChatWorkspace } from "@/features/chat/chat-workspace";
import { citation, session } from "./fixtures";

const ask = vi.fn();
const inspect = vi.fn().mockResolvedValue({
  query: "Where does the application start?",
  repository: "acme/platform",
  results: [],
  stats: { semanticResults: 0, keywordResults: 0, symbolResults: 0, graphBoosted: 0, returned: 0 },
});
const refetch = vi.fn().mockResolvedValue(undefined);

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/features/auth/auth-context", () => ({ useAuth: () => ({ token: "token" }) }));
vi.mock("@/hooks/use-sessions", () => ({
  sessionKeys: { all: ["sessions"] },
  useSession: () => ({ data: session, isLoading: false, isError: false, refetch }),
  useSessions: () => ({ data: { sessions: [{
    id: session.id, userId: session.userId, owner: session.owner, repo: session.repo,
    title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt, messageCount: 0,
  }] } }),
  useCreateSession: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/services/api/sessions", () => ({ sessionsApi: { ask: (...args: unknown[]) => ask(...args) } }));
vi.mock("@/services/api/retrieval", () => ({ retrievalApi: { inspect: (...args: unknown[]) => inspect(...args) } }));

describe("session ask integration", () => {
  it("prevents duplicate ask requests while the first request is in flight", async () => {
    inspect.mockResolvedValue({
      query: "Where does the application start?",
      repository: "acme/platform",
      results: [],
      stats: { semanticResults: 0, keywordResults: 0, symbolResults: 0, graphBoosted: 0, returned: 0 },
    });
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
    const suggestion = screen.getByRole("button", { name: "Where does the application start?" });
    act(() => {
      fireEvent.click(suggestion);
      fireEvent.click(suggestion);
    });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith("token", session.id, "Where does the application start?");
    finish({
      answer: "Grounded answer",
      sources: [],
      citations: [citation],
      metadata: { retrievedFiles: 1, usedSummary: false, usedDependencyGraph: false, retrievalSourceCounts: { semantic: 1, keyword: 0, symbol: 0, graph: 0, fileSearch: 0 }, estimatedContextTokens: 100 },
    });
    await waitFor(() => expect(refetch).toHaveBeenCalled());
  });
});
