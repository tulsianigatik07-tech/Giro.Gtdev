import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatPanel } from "@/features/chat/chat-panel";
import { ConversationHistory } from "@/features/chat/conversation-history";
import { ApiClientError } from "@/services/api/client";
import { citation, session } from "./fixtures";

vi.mock("next/navigation", () => ({ usePathname: () => "/chat/session-1" }));

const retrieval = {
  query: "Explain authentication",
  repository: "acme/platform",
  results: [],
  citations: [citation],
  stats: { semanticResults: 1, keywordResults: 0, symbolResults: 0, graphBoosted: 0, returned: 0 },
};

describe("chat page", () => {
  it("renders engineering guidance and populates examples without submitting", () => {
    const onAsk = vi.fn();
    render(<ChatPanel session={session} latestAnswer={null} pendingQuestion={null} asking={false} error={null} onAsk={onAsk} />);
    expect(screen.getByRole("heading", { name: "Question the indexed repository." })).toBeInTheDocument();
    expect(screen.getByText("Where does authentication start?")).toBeInTheDocument();
    expect(screen.getByText("Which files define API routes?")).toBeInTheDocument();
    expect(screen.getByText("Explain the indexing pipeline.")).toBeInTheDocument();
    expect(screen.getByText("Show repository entry points.")).toBeInTheDocument();
    expect(screen.getByText("Which modules depend on X?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Where does authentication start?" }));
    expect(screen.getByLabelText("Ask a repository question")).toHaveValue("Where does authentication start?");
    expect(screen.getByLabelText("Ask a repository question")).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("Example question inserted into the composer.");
    expect(onAsk).not.toHaveBeenCalled();
  });

  it("submits an entered question and preserves the Enter shortcut", () => {
    const onAsk = vi.fn();
    render(<ChatPanel session={session} latestAnswer={null} pendingQuestion={null} asking={false} error={null} onAsk={onAsk} />);
    fireEvent.change(screen.getByLabelText("Ask a repository question"), { target: { value: "Where is auth handled?" } });
    fireEvent.keyDown(screen.getByLabelText("Ask a repository question"), { key: "Enter" });
    expect(onAsk).toHaveBeenCalledWith("Where is auth handled?");
  });

  it("renders loading state while grounded retrieval runs", () => {
    render(<ChatPanel session={session} latestAnswer={null} pendingQuestion="Explain auth" asking error={null} onAsk={vi.fn()} />);
    const loadingMessage = screen.getByText("Searching indexed repository…");
    expect(loadingMessage).toBeInTheDocument();
    expect(loadingMessage.closest('[role="status"]')).toHaveTextContent("GROUNDING RESPONSE IN acme/platform");
    expect(screen.getByRole("button", { name: "Send question" })).toBeDisabled();
  });

  it("blocks repository questions with an explicit readiness reason", () => {
    render(<ChatPanel session={session} latestAnswer={null} pendingQuestion={null} asking={false} error={null} blockedState={{ message: "Indexing required. Repository intelligence must be ready before asking questions.", actionHref: "/repositories/acme/platform/indexing", actionLabel: "View indexing" }} onAsk={vi.fn()} />);
    expect(screen.getByLabelText("Ask a repository question")).toBeDisabled();
    expect(screen.getByRole("link", { name: "View indexing" })).toHaveAttribute("href", "/repositories/acme/platform/indexing");
  });

  it("offers repository recovery without changing routes", () => {
    render(<ChatPanel session={session} latestAnswer={null} pendingQuestion={null} asking={false} error={null} blockedState={{ message: "Repository unavailable. Reconnect the repository before asking questions.", actionHref: "/repositories/connect", actionLabel: "Connect repository" }} onAsk={vi.fn()} />);
    expect(screen.getByRole("link", { name: "Connect repository" })).toHaveAttribute("href", "/repositories/connect");
  });

  it("adopts a repository draft once without submitting it", () => {
    const onAsk = vi.fn();
    const onDraftAdopted = vi.fn();
    const props = { session, latestAnswer: null, pendingQuestion: null, asking: false, error: null, initialDraft: "Explain how authenticate works.", onDraftAdopted, onAsk };
    const view = render(<ChatPanel {...props} />);
    const composer = screen.getByLabelText("Ask a repository question");
    expect(composer).toHaveValue("Explain how authenticate works.");
    expect(composer).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("Repository draft inserted into the composer.");
    expect(onDraftAdopted).toHaveBeenCalledTimes(1);
    expect(onAsk).not.toHaveBeenCalled();

    view.rerender(<ChatPanel {...props} />);
    expect(onDraftAdopted).toHaveBeenCalledTimes(1);
    expect(composer).toHaveValue("Explain how authenticate works.");
  });

  it("never overwrites text already entered in the composer", () => {
    const onDraftAdopted = vi.fn();
    const baseProps = { session, latestAnswer: null, pendingQuestion: null, asking: false, error: null, onAsk: vi.fn() };
    const view = render(<ChatPanel {...baseProps} />);
    const composer = screen.getByLabelText("Ask a repository question");
    fireEvent.change(composer, { target: { value: "My existing question" } });
    view.rerender(<ChatPanel {...baseProps} initialDraft="Repository handoff draft" onDraftAdopted={onDraftAdopted} />);
    expect(composer).toHaveValue("My existing question");
    expect(onDraftAdopted).not.toHaveBeenCalled();
  });

  it("renders historical assistant messages when confidence metadata is absent", () => {
    const historical = { ...session, messages: [{ id: "a-old", role: "assistant" as const, content: "Historical grounded answer.", citations: [citation], createdAt: "2026-07-16T00:00:00Z" }] };
    render(<ChatPanel session={historical} latestAnswer={null} pendingQuestion={null} asking={false} error={null} onAsk={vi.fn()} />);
    expect(screen.getByText("Historical grounded answer.")).toBeInTheDocument();
    expect(screen.queryByText(/Evidence supports an answer/)).not.toBeInTheDocument();
  });

  it("shows a limited-evidence notice for a low-confidence answer", () => {
    const answered = { ...session, messages: [{ id: "a-low", role: "assistant" as const, content: "Provisional answer.", citations: [citation], createdAt: "2026-07-17T00:00:00Z" }] };
    render(<ChatPanel session={answered} latestAnswer={{ durationMs: 100, result: { answer: "Provisional answer.", sources: [], citations: [citation], metadata: { retrievedFiles: 1, usedSummary: false, usedDependencyGraph: false, retrievalSourceCounts: { semantic: 1, keyword: 0, symbol: 0, graph: 0, fileSearch: 0 }, estimatedContextTokens: 100, confidence: { level: "low", score: 0.31, answerable: true, reasons: ["weak_top_match"] } }, retrieval } }} pendingQuestion={null} asking={false} error={null} onAsk={vi.fn()} />);
    expect(screen.getByText(/Limited repository evidence supports this answer/)).toBeInTheDocument();
  });

  it("renders the backend insufficient-evidence fallback faithfully", () => {
    const fallback = "I could not find enough repository evidence to answer this reliably.";
    const answered = { ...session, messages: [{ id: "a-none", role: "assistant" as const, content: fallback, citations: [], createdAt: "2026-07-17T00:00:00Z" }] };
    render(<ChatPanel session={answered} latestAnswer={{ durationMs: 100, result: { answer: fallback, sources: [], citations: [], metadata: { retrievedFiles: 0, usedSummary: false, usedDependencyGraph: false, retrievalSourceCounts: { semantic: 0, keyword: 0, symbol: 0, graph: 0, fileSearch: 0 }, estimatedContextTokens: 0, confidence: { level: "insufficient", score: 0, answerable: false, reasons: ["no_retrieval_evidence"] } }, retrieval: { ...retrieval, results: [], citations: [], stats: { semanticResults: 0, keywordResults: 0, symbolResults: 0, graphBoosted: 0, returned: 0 } } } }} pendingQuestion={null} asking={false} error={null} onAsk={vi.fn()} />);
    expect(screen.getByText(fallback)).toBeInTheDocument();
    expect(screen.getByText("insufficient")).toBeInTheDocument();
  });

  it("renders answer confidence, timing, version, and citations", () => {
    const onSelectEvidence = vi.fn();
    const answered = { ...session, messages: [{ id: "a-1", role: "assistant" as const, content: "Authentication is handled by `authenticate`.", citations: [citation], createdAt: "2026-07-17T00:00:00Z" }] };
    render(<ChatPanel session={answered} latestAnswer={{ durationMs: 1250, result: { answer: "Authentication is handled.", sources: [], citations: [citation], metadata: { retrievedFiles: 1, usedSummary: false, usedDependencyGraph: true, retrievalSourceCounts: { semantic: 1, keyword: 0, symbol: 1, graph: 1, fileSearch: 0 }, estimatedContextTokens: 400, confidence: { level: "high", score: 0.91, answerable: true, reasons: ["strong_top_match"] } }, retrieval } }} pendingQuestion={null} asking={false} error={null} onSelectEvidence={onSelectEvidence} onAsk={vi.fn()} />);
    expect(screen.getByText("high")).toBeInTheDocument();
    expect(screen.getByText("1.3 s")).toBeInTheDocument();
    expect(screen.getByText("VERSION job-1:1")).toBeInTheDocument();
    expect(screen.getByText("src/auth/login.ts")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Citation 1: src\/auth\/login.ts/ }));
    expect(onSelectEvidence).toHaveBeenCalledWith("src/auth/login.ts");
  });

  it("differentiates backend and request failures with retry", () => {
    const retry = vi.fn();
    const backend = new ApiClientError({ code: "ask_failed", message: "Answer service rejected the request.", status: 503, retryable: true, requestId: "req-1" });
    const view = render(<ChatPanel session={session} latestAnswer={null} pendingQuestion="Explain auth" asking={false} error={backend} onAsk={retry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Backend error");
    expect(screen.getByRole("alert")).toHaveTextContent("REQUEST req-1");
    fireEvent.click(screen.getByRole("button", { name: "Retry question" }));
    expect(retry).toHaveBeenCalledWith("Explain auth");
    view.rerender(<ChatPanel session={session} latestAnswer={null} pendingQuestion="Explain auth" asking={false} error={new ApiClientError({ code: "network_error", message: "Unable to reach the Giro API.", status: 0, retryable: true })} onAsk={retry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Request failed");
  });

  it("uses a labelled conversation log for long investigations", () => {
    const messages = Array.from({ length: 12 }, (_, index) => ({
      id: `message-${index}`,
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: `Investigation message ${index + 1}`,
      citations: index % 2 === 0 ? [] : [citation],
      createdAt: `2026-07-17T00:${String(index).padStart(2, "0")}:00Z`,
    }));
    render(<ChatPanel session={{ ...session, messages }} latestAnswer={null} pendingQuestion={null} asking={false} error={null} onAsk={vi.fn()} />);
    expect(screen.getByRole("log", { name: "Conversation messages" })).toBeInTheDocument();
    expect(screen.getAllByRole("article", { name: "User question" })).toHaveLength(6);
    expect(screen.getAllByRole("article", { name: "Giro answer" })).toHaveLength(6);
  });

  it("supports switching sessions through conversation history", () => {
    const first = { ...session, messageCount: session.messages.length };
    const second = { ...first, id: "session-2", title: "Second session" };
    render(<ConversationHistory sessions={[first, second]} activeId="session-1" onCreate={vi.fn()} creating={false} />);
    expect(screen.getByRole("link", { name: /Second session/ })).toHaveAttribute("href", "/chat/session-2");
  });
});
