"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowUp, Bot, Clock3, LoaderCircle, PanelRight, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { CitationList } from "@/features/retrieval/citation-list";
import { ConfidenceBadge } from "@/features/retrieval/confidence-badge";
import { formatDuration } from "@/lib/utils";
import { useUiStore } from "@/store/ui-store";
import { isGroundedCitation, type AskResult, type Session } from "@/types/api";
import { MarkdownMessage } from "./markdown-message";

export interface LatestAnswer {
  result: AskResult;
  durationMs: number;
}

export function ChatPanel({ session, latestAnswer, pendingQuestion, asking, error, onAsk }: {
  session: Session;
  latestAnswer: LatestAnswer | null;
  pendingQuestion: string | null;
  asking: boolean;
  error: unknown;
  onAsk(question: string): void;
}) {
  const [question, setQuestion] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const toggleInspector = useUiStore((state) => state.toggleInspector);
  const latestAssistantIndex = session.messages.map((message) => message.role).lastIndexOf("assistant");

  useEffect(() => {
    const container = scrollRef.current;
    if (container) container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
  }, [asking, session.messages.length, latestAnswer]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const clean = question.trim();
    if (!clean || asking) return;
    setQuestion("");
    onAsk(clean);
  }

  return (
    <section className="flex h-full min-h-0 flex-col bg-background" aria-label="Chat">
      <header className="flex h-14 shrink-0 items-center border-b border-border px-4"><div className="min-w-0"><h1 className="truncate text-sm font-medium">{session.title}</h1><p className="mt-0.5 truncate text-[10px] text-muted-foreground">{session.owner}/{session.repo}</p></div><Button variant="ghost" size="icon" className="ml-auto" aria-label="Toggle retrieval inspector" onClick={toggleInspector}><PanelRight className="size-4" /></Button></header>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto scroll-smooth">
        <div className="mx-auto max-w-3xl px-4 py-8 sm:px-7">
          {session.messages.length === 0 && !pendingQuestion ? <div className="flex min-h-[48vh] flex-col items-center justify-center text-center"><div className="grid size-11 place-items-center rounded-xl border border-border bg-card"><Bot className="size-5 text-primary" /></div><h2 className="mt-5 font-display text-3xl italic">Explore {session.repo}</h2><p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">Ask about architecture, implementation details, symbols, routes, or how parts of the repository connect.</p><div className="mt-6 grid w-full max-w-xl gap-2 sm:grid-cols-2">{["Where does the application start?", "How is authentication structured?", "Explain the main service boundaries", "Which modules are most central?"].map((prompt) => <button key={prompt} onClick={() => onAsk(prompt)} className="rounded-lg border border-border bg-card p-3 text-left text-xs text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground focus-ring">{prompt}</button>)}</div></div> : null}
          <div className="space-y-8">{session.messages.map((message, index) => {
            const groundedCitations = message.citations.filter(isGroundedCitation);
            return <MessageBlock key={message.id} role={message.role} content={message.content}>{message.role === "assistant" && index === latestAssistantIndex && latestAnswer ? <AnswerMetadata answer={latestAnswer} session={session} /> : message.role === "assistant" && groundedCitations.length > 0 ? <div className="mt-5 border-t border-border pt-4"><h3 className="mb-2 text-xs font-medium">Citations ({groundedCitations.length})</h3><CitationList citations={groundedCitations} context={session.selectedContext} /></div> : null}</MessageBlock>;
          })}
            {pendingQuestion && !session.messages.some((message) => message.role === "user" && message.content === pendingQuestion) ? <MessageBlock role="user" content={pendingQuestion} /> : null}
            {asking ? <div className="flex gap-3"><Avatar role="assistant" /><div className="flex items-center gap-2 pt-1 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />Retrieving repository evidence…</div></div> : null}
            {error ? <div className="ml-10"><ErrorState error={error} compact retry={pendingQuestion ? () => onAsk(pendingQuestion) : undefined} /></div> : null}
          </div>
        </div>
      </div>
      <div className="shrink-0 border-t border-border bg-background/90 p-3 backdrop-blur sm:p-4"><form onSubmit={submit} className="mx-auto flex max-w-3xl items-end gap-2 rounded-xl border border-border bg-card p-2 focus-within:border-foreground/20"><label htmlFor="chat-question" className="sr-only">Ask a repository question</label><textarea id="chat-question" rows={1} value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder="Ask about this repository…" className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none placeholder:text-muted-foreground" disabled={asking} /><Button type="submit" size="icon" disabled={asking || !question.trim()} aria-label="Send question"><ArrowUp className="size-4" /></Button></form><p className="mx-auto mt-2 max-w-3xl text-center text-[10px] text-muted-foreground">Answers are grounded in indexed repository evidence. Verify critical details in citations.</p></div>
    </section>
  );
}

function Avatar({ role }: { role: "user" | "assistant" }) { return <span className={`grid size-7 shrink-0 place-items-center rounded-md ${role === "assistant" ? "bg-primary/10 text-primary" : "bg-foreground/[0.06] text-muted-foreground"}`}>{role === "assistant" ? <Bot className="size-3.5" /> : <User className="size-3.5" />}</span>; }
function MessageBlock({ role, content, children }: { role: "user" | "assistant"; content: string; children?: React.ReactNode }) { return <article className="flex gap-3"><Avatar role={role} /><div className="min-w-0 flex-1">{role === "assistant" ? <MarkdownMessage>{content}</MarkdownMessage> : <p className="pt-0.5 text-sm leading-7 text-foreground">{content}</p>}{children}</div></article>; }
function AnswerMetadata({ answer, session }: { answer: LatestAnswer; session: Session }) {
  const version = answer.result.citations[0]?.repositoryVersion;
  const confidence = answer.result.metadata.confidence;
  return <div className="mt-5 space-y-4 border-t border-border pt-4">{confidence ? <ConfidenceBadge confidence={confidence} /> : null}{confidence?.level === "low" ? <p role="status" className="rounded-md border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-200">Limited repository evidence supports this answer. Verify the cited files before relying on it.</p> : null}<div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[10px] text-muted-foreground"><span className="flex items-center gap-1.5"><Clock3 className="size-3" />{formatDuration(answer.durationMs)}</span><span>{answer.result.metadata.estimatedContextTokens.toLocaleString()} context tokens</span><span>{answer.result.metadata.retrievedFiles} files</span>{version ? <span className="max-w-52 truncate font-mono">version {version}</span> : null}</div><div><h3 className="mb-2 text-xs font-medium">Citations ({answer.result.citations.length})</h3><CitationList citations={answer.result.citations} context={session.selectedContext} /></div></div>;
}
