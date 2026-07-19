"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowDown, ArrowRight, ArrowUp, Clock3, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InlineAlert } from "@/components/ui/inline-alert";
import { Textarea } from "@/components/ui/textarea";
import { CitationList } from "@/features/retrieval/citation-list";
import { ConfidenceBadge } from "@/features/retrieval/confidence-badge";
import { formatDuration } from "@/lib/utils";
import { ApiClientError, getApiErrorMessage } from "@/services/api/client";
import { isGroundedCitation, type AskResult, type GroundedCitation, type Session } from "@/types/api";
import { MarkdownMessage } from "./markdown-message";

export interface LatestAnswer {
  result: AskResult;
  durationMs: number;
}

export function ChatPanel({ session, latestAnswer, pendingQuestion, asking, error, blockedState, blockedReason, initialDraft, composerValue, focusComposer, selectedEvidencePath, onSelectEvidence, onComposerChange, onComposerFocused, onDraftAdopted, onAsk }: {
  session: Session;
  latestAnswer: LatestAnswer | null;
  pendingQuestion: string | null;
  asking: boolean;
  error: unknown;
  blockedState?: { message: string; actionHref?: string; actionLabel?: string };
  /** @deprecated Compatibility for existing callers. */
  blockedReason?: string;
  initialDraft?: string;
  composerValue?: string;
  focusComposer?: boolean;
  selectedEvidencePath?: string | null;
  onSelectEvidence?(path: string): void;
  onComposerChange?(value: string): void;
  onComposerFocused?(): void;
  onDraftAdopted?(): void;
  onAsk(question: string): void;
}) {
  const [internalQuestion, setInternalQuestion] = useState("");
  const question = composerValue ?? internalQuestion;
  const [draftAnnouncement, setDraftAnnouncement] = useState("");
  const [showJump, setShowJump] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const questionRef = useRef(question);
  const handledDraftRef = useRef<string | null>(null);
  const stickToBottom = useRef(true);
  const latestAssistantIndex = session.messages.map((message) => message.role).lastIndexOf("assistant");
  const prompts = engineeringPrompts;
  const blockedMessage = blockedState?.message ?? blockedReason;

  useEffect(() => {
    questionRef.current = question;
  }, [question]);

  useEffect(() => {
    if (!focusComposer) return;
    textareaRef.current?.focus();
    onComposerFocused?.();
  }, [focusComposer, onComposerFocused]);

  const updateQuestion = useCallback((value: string) => {
    questionRef.current = value;
    if (onComposerChange) onComposerChange(value);
    else setInternalQuestion(value);
  }, [onComposerChange]);

  useEffect(() => {
    if (!initialDraft || handledDraftRef.current === initialDraft) return;
    handledDraftRef.current = initialDraft;
    if (questionRef.current) return;
    updateQuestion(initialDraft);
    setDraftAnnouncement("Repository draft inserted into the composer.");
    textareaRef.current?.focus();
    onDraftAdopted?.();
  }, [initialDraft, onDraftAdopted, updateQuestion]);

  useEffect(() => {
    const container = scrollRef.current;
    if (container && stickToBottom.current) {
      container.scrollTo({ top: container.scrollHeight, behavior: "auto" });
      setShowJump(false);
    }
  }, [asking, session.messages.length, latestAnswer]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const clean = question.trim();
    if (!clean || asking) return;
    updateQuestion("");
    onAsk(clean);
  }

  function jumpToLatest() {
    const container = scrollRef.current;
    if (!container) return;
    stickToBottom.current = true;
    setShowJump(false);
    container.scrollTo({ top: container.scrollHeight, behavior: "auto" });
  }

  function selectPrompt(prompt: string) {
    updateQuestion(prompt);
    setDraftAnnouncement("Example question inserted into the composer.");
    textareaRef.current?.focus();
  }

  return (
    <section className="relative flex h-full min-h-0 flex-col bg-background" aria-labelledby="ask-giro-heading">
      <header className="flex min-h-[58px] shrink-0 items-center gap-4 border-b border-border-subtle px-4 py-2"><div className="min-w-0 flex-1"><p className="type-metadata-label text-muted-foreground">Ask Giro · repository investigation</p><h1 id="ask-giro-heading" className="truncate type-panel-title">{session.title}</h1></div><p className="max-w-[40%] truncate type-mono text-muted-foreground" title={`${session.owner}/${session.repo}`}>{session.owner}/{session.repo}</p></header>
      <div ref={scrollRef} onScroll={(event) => { const node = event.currentTarget; const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight <= 48; stickToBottom.current = atBottom; setShowJump(!atBottom); }} className="min-h-0 flex-1 overflow-y-auto">
        <div className="layout-reading px-4 py-8">
          {session.messages.length === 0 && !pendingQuestion ? <div className="py-8 sm:py-12"><p className="type-metadata-label text-muted-foreground">Investigation starting point</p><h2 className="mt-2 type-panel-title">Question the indexed repository.</h2><p className="mt-2 max-w-[68ch] type-body text-text-secondary">Use concrete engineering questions. Giro answers from indexed repository context and exposes citations when the backend returns them.</p><div className="mt-6 divide-y divide-border-subtle border-y border-border-subtle" aria-label="Example engineering questions">{prompts.map((prompt) => <button key={prompt} type="button" onClick={() => selectPrompt(prompt)} className="flex min-h-11 w-full items-center px-3 py-2.5 text-left type-compact text-text-secondary transition-colors duration-[150ms] hover:bg-hover hover:text-foreground focus-ring"><span className="min-w-0 flex-1">{prompt}</span><ArrowRight className="ml-3 size-3.5 text-muted-foreground" /></button>)}</div></div> : null}
          <div className="space-y-9" role="log" aria-label="Conversation messages" aria-live="polite">{session.messages.map((message, index) => {
            const groundedCitations = message.citations.filter(isGroundedCitation);
            return <MessageBlock key={message.id} role={message.role} content={message.content} createdAt={message.createdAt} citations={groundedCitations} selectedEvidencePath={selectedEvidencePath} onSelectEvidence={onSelectEvidence}>{message.role === "assistant" && index === latestAssistantIndex && latestAnswer ? <AnswerMetadata answer={latestAnswer} session={session} selectedEvidencePath={selectedEvidencePath} onSelectEvidence={onSelectEvidence} /> : message.role === "assistant" && groundedCitations.length > 0 ? <div className="mt-4 space-y-4"><p className="type-metadata text-muted-foreground">Confidence not available for this historical answer.</p><div><h3 className="mb-2 type-compact-strong">Citations ({groundedCitations.length})</h3><CitationList citations={groundedCitations} context={session.selectedContext} selectedPath={selectedEvidencePath} onSelectPath={onSelectEvidence} /></div></div> : null}</MessageBlock>;
          })}
            {pendingQuestion && !session.messages.some((message) => message.role === "user" && message.content === pendingQuestion) ? <MessageBlock role="user" content={pendingQuestion} /> : null}
            {asking ? <div aria-live="polite" role="status" className="border-t border-border-subtle pt-7"><p className="type-metadata-label text-muted-foreground">GIRO · INVESTIGATING</p><div className="mt-2 flex items-center gap-2 type-body text-text-secondary"><LoaderCircle className="size-4 animate-spin text-info motion-reduce:animate-none" />Searching indexed repository…</div><p className="mt-1 type-metadata text-muted-foreground">GROUNDING RESPONSE IN {session.owner}/{session.repo}</p></div> : null}
            {error ? <ChatRequestError error={error} retry={pendingQuestion ? () => onAsk(pendingQuestion) : undefined} /> : null}
          </div>
        </div>
      </div>
      {showJump ? <Button variant="secondary" size="sm" className="absolute bottom-28 left-1/2 z-10 -translate-x-1/2 shadow-raised motion-reduce:transform-none" onClick={jumpToLatest}><ArrowDown className="size-3.5" />Jump to latest</Button> : null}
      <div className="shrink-0 bg-background px-3 pb-[max(12px,env(safe-area-inset-bottom))] pt-3">
        <p role="status" aria-live="polite" className="sr-only">{draftAnnouncement}</p>
        {blockedState?.actionHref ? <InlineAlert tone="warning" className="layout-reading mb-2"><div className="flex flex-wrap items-center gap-3"><p className="min-w-0 flex-1 type-compact-strong">{blockedMessage}</p><Link href={blockedState.actionHref} className="type-compact-strong text-foreground underline decoration-border-strong underline-offset-4 focus-ring">{blockedState.actionLabel}</Link></div></InlineAlert> : null}
        <form onSubmit={submit} className="layout-reading rounded-panel border border-border bg-panel p-3 shadow-raised transition-[border-color,box-shadow] duration-[150ms] focus-within:border-border-focus focus-within:ring-2 focus-within:ring-border-focus focus-within:ring-offset-2 focus-within:ring-offset-background"><label htmlFor="chat-question" className="sr-only">Ask a repository question</label><div className="flex items-end gap-2"><Textarea ref={textareaRef} id="chat-question" rows={1} value={question} disabled={Boolean(blockedMessage)} onChange={(event) => updateQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder={blockedMessage ?? "Ask about this repository…"} className="max-h-24 min-h-10 flex-1 resize-none border-0 bg-transparent px-1 py-2 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0" /><Button variant="accent" type="submit" size="icon-sm" disabled={asking || Boolean(blockedMessage) || !question.trim()} aria-label="Send question"><ArrowUp className="size-4" /></Button></div><div className="mt-2 flex items-center justify-between gap-3 type-metadata text-muted-foreground"><span className="truncate">{blockedMessage ?? `${session.owner}/${session.repo}`}</span>{!blockedMessage ? <span className="shrink-0">SHIFT+ENTER NEW LINE</span> : null}</div></form>
      </div>
    </section>
  );
}

function MessageBlock({ role, content, createdAt, children, citations = [], selectedEvidencePath, onSelectEvidence }: { role: "user" | "assistant"; content: string; createdAt?: string; children?: React.ReactNode; citations?: GroundedCitation[]; selectedEvidencePath?: string | null; onSelectEvidence?(path: string): void }) {
  if (role === "assistant") return <article className="border-t border-border-subtle pt-7" aria-label="Giro answer"><p className="mb-3 type-metadata-label text-primary">GIRO · GROUNDED ANSWER</p><MarkdownMessage>{content}</MarkdownMessage>{citations.length ? <CitationMarkers citations={citations} selectedPath={selectedEvidencePath} onSelect={onSelectEvidence} /> : null}{children}{createdAt ? <p className="mt-4 type-metadata text-muted-foreground">ANSWERED {new Date(createdAt).toLocaleTimeString()}</p> : null}</article>;
  return <article className="ml-auto max-w-[88%] border-l-2 border-border-strong bg-interactive px-4 py-3 sm:max-w-[80%]" aria-label="User question"><p className="mb-2 type-metadata-label text-muted-foreground">QUESTION</p><p className="whitespace-pre-wrap type-body text-foreground">{content}</p>{createdAt ? <p className="mt-2 text-right type-metadata text-muted-foreground">ASKED {new Date(createdAt).toLocaleTimeString()}</p> : null}</article>;
}

function CitationMarkers({ citations, selectedPath, onSelect }: { citations: GroundedCitation[]; selectedPath?: string | null; onSelect?(path: string): void }) {
  return <span className="mt-2 flex flex-wrap items-center gap-1" aria-label="Answer citations">{citations.map((citation, index) => <button key={`${citation.chunkId}-${citation.startLine}`} type="button" aria-label={`Citation ${index + 1}: ${citation.relativeFilePath}, lines ${citation.startLine} to ${citation.endLine}`} aria-pressed={selectedPath === citation.relativeFilePath} onClick={() => onSelect?.(citation.relativeFilePath)} className={`inline-flex min-h-[18px] items-center rounded-badge px-1.5 type-metadata focus-ring ${selectedPath === citation.relativeFilePath ? "bg-selection text-primary" : "bg-inset text-muted-foreground hover:text-foreground"}`}>[{index + 1}]</button>)}</span>;
}

function AnswerMetadata({ answer, session, selectedEvidencePath, onSelectEvidence }: { answer: LatestAnswer; session: Session; selectedEvidencePath?: string | null; onSelectEvidence?(path: string): void }) {
  const version = answer.result.citations[0]?.repositoryVersion;
  const confidence = answer.result.metadata.confidence;
  return <div className="mt-4 space-y-4">{confidence ? <ConfidenceBadge confidence={confidence} /> : <p className="type-metadata text-muted-foreground">Confidence was not persisted for this answer.</p>}{confidence?.level === "low" ? <InlineAlert tone="warning">Limited repository evidence supports this answer. Verify the cited files before relying on it.</InlineAlert> : null}<div className="flex flex-wrap items-center gap-x-4 gap-y-2 type-metadata text-muted-foreground"><span className="flex items-center gap-1.5"><Clock3 className="size-3" />{formatDuration(answer.durationMs)}</span><span>{answer.result.metadata.retrievedFiles} files</span>{version ? <span className="max-w-52 truncate">VERSION {version}</span> : null}</div><div><h3 className="mb-2 type-compact-strong">Citations ({answer.result.citations.length})</h3><CitationList citations={answer.result.citations} context={session.selectedContext} selectedPath={selectedEvidencePath} onSelectPath={onSelectEvidence} /></div></div>;
}

const engineeringPrompts = [
  "Where does authentication start?",
  "Which files define API routes?",
  "Explain the indexing pipeline.",
  "Show repository entry points.",
  "Which modules depend on X?",
];

function ChatRequestError({ error, retry }: { error: unknown; retry?: () => void }) {
  const apiError = error instanceof ApiClientError ? error : null;
  const title = apiError?.status === 0 ? "Request failed" : "Backend error";
  return <div role="alert" className="border-l-2 border-border-danger bg-danger/5 p-4"><p className="type-body-strong text-danger">{title}</p><p className="mt-1 type-compact text-text-secondary">{getApiErrorMessage(error)}</p>{apiError?.requestId ? <p className="mt-2 type-metadata text-muted-foreground">REQUEST {apiError.requestId}</p> : null}{retry ? <Button variant="secondary" size="sm" className="mt-3" onClick={retry}>Retry question</Button> : null}</div>;
}
