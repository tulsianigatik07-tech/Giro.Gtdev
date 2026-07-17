import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatPanel } from "@/features/chat/chat-panel";
import { ConversationHistory } from "@/features/chat/conversation-history";
import { citation, session } from "./fixtures";

vi.mock("next/navigation", () => ({ usePathname: () => "/chat/session-1" }));

describe("chat page", () => {
  it("renders its empty state and submits a question", () => {
    const onAsk = vi.fn();
    render(<ChatPanel session={session} latestAnswer={null} pendingQuestion={null} asking={false} error={null} onAsk={onAsk} />);
    expect(screen.getByText("Explore platform")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Ask a repository question"), { target: { value: "Where is auth handled?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));
    expect(onAsk).toHaveBeenCalledWith("Where is auth handled?");
  });

  it("renders loading state while grounded retrieval runs", () => {
    render(<ChatPanel session={session} latestAnswer={null} pendingQuestion="Explain auth" asking error={null} onAsk={vi.fn()} />);
    expect(screen.getByText("Retrieving repository evidence…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send question" })).toBeDisabled();
  });

  it("renders historical assistant messages when confidence metadata is absent", () => {
    const historical = { ...session, messages: [{ id: "a-old", role: "assistant" as const, content: "Historical grounded answer.", citations: [citation], createdAt: "2026-07-16T00:00:00Z" }] };
    render(<ChatPanel session={historical} latestAnswer={null} pendingQuestion={null} asking={false} error={null} onAsk={vi.fn()} />);
    expect(screen.getByText("Historical grounded answer.")).toBeInTheDocument();
    expect(screen.queryByText(/Evidence supports an answer/)).not.toBeInTheDocument();
  });

  it("shows a limited-evidence notice for a low-confidence answer", () => {
    const answered = { ...session, messages: [{ id: "a-low", role: "assistant" as const, content: "Provisional answer.", citations: [citation], createdAt: "2026-07-17T00:00:00Z" }] };
    render(<ChatPanel session={answered} latestAnswer={{ durationMs: 100, result: { answer: "Provisional answer.", sources: [], citations: [citation], metadata: { retrievedFiles: 1, usedSummary: false, usedDependencyGraph: false, retrievalSourceCounts: { semantic: 1, keyword: 0, symbol: 0, graph: 0, fileSearch: 0 }, estimatedContextTokens: 100, confidence: { level: "low", score: 0.31, answerable: true, reasons: ["weak_top_match"] } } } }} pendingQuestion={null} asking={false} error={null} onAsk={vi.fn()} />);
    expect(screen.getByText(/Limited repository evidence supports this answer/)).toBeInTheDocument();
  });

  it("renders the backend insufficient-evidence fallback faithfully", () => {
    const fallback = "I could not find enough repository evidence to answer this reliably.";
    const answered = { ...session, messages: [{ id: "a-none", role: "assistant" as const, content: fallback, citations: [], createdAt: "2026-07-17T00:00:00Z" }] };
    render(<ChatPanel session={answered} latestAnswer={{ durationMs: 100, result: { answer: fallback, sources: [], citations: [], metadata: { retrievedFiles: 0, usedSummary: false, usedDependencyGraph: false, retrievalSourceCounts: { semantic: 0, keyword: 0, symbol: 0, graph: 0, fileSearch: 0 }, estimatedContextTokens: 0, confidence: { level: "insufficient", score: 0, answerable: false, reasons: ["no_retrieval_evidence"] } } } }} pendingQuestion={null} asking={false} error={null} onAsk={vi.fn()} />);
    expect(screen.getByText(fallback)).toBeInTheDocument();
    expect(screen.getByText("insufficient")).toBeInTheDocument();
  });

  it("renders answer confidence, timing, version, and citations", () => {
    const answered = { ...session, messages: [{ id: "a-1", role: "assistant" as const, content: "Authentication is handled by `authenticate`.", citations: [citation], createdAt: "2026-07-17T00:00:00Z" }] };
    render(<ChatPanel session={answered} latestAnswer={{ durationMs: 1250, result: { answer: "Authentication is handled.", sources: [], citations: [citation], metadata: { retrievedFiles: 1, usedSummary: false, usedDependencyGraph: true, retrievalSourceCounts: { semantic: 1, keyword: 0, symbol: 1, graph: 1, fileSearch: 0 }, estimatedContextTokens: 400, confidence: { level: "high", score: 0.91, answerable: true, reasons: ["strong_top_match"] } } } }} pendingQuestion={null} asking={false} error={null} onAsk={vi.fn()} />);
    expect(screen.getByText("high")).toBeInTheDocument();
    expect(screen.getByText("1.3 s")).toBeInTheDocument();
    expect(screen.getByText("version job-1:1")).toBeInTheDocument();
    expect(screen.getByText("src/auth/login.ts")).toBeInTheDocument();
  });

  it("supports switching sessions through conversation history", () => {
    const first = { ...session, messageCount: session.messages.length };
    const second = { ...first, id: "session-2", title: "Second session" };
    render(<ConversationHistory sessions={[first, second]} activeId="session-1" onCreate={vi.fn()} creating={false} />);
    expect(screen.getByRole("link", { name: /Second session/ })).toHaveAttribute("href", "/chat/session-2");
  });
});
