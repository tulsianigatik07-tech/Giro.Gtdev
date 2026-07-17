"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useQueryClient } from "@tanstack/react-query";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/features/auth/auth-context";
import { RetrievalInspector } from "@/features/retrieval/retrieval-inspector";
import { sessionKeys, useCreateSession, useSession, useSessions } from "@/hooks/use-sessions";
import { getApiErrorMessage } from "@/services/api/client";
import { retrievalApi } from "@/services/api/retrieval";
import { sessionsApi } from "@/services/api/sessions";
import { useUiStore } from "@/store/ui-store";
import type { HybridRetrievalResult } from "@/types/api";
import { ChatPanel, type LatestAnswer } from "./chat-panel";
import { ConversationHistory } from "./conversation-history";

export function ChatWorkspace({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const client = useQueryClient();
  const { token } = useAuth();
  const session = useSession(sessionId);
  const sessions = useSessions();
  const create = useCreateSession();
  const inspectorOpen = useUiStore((state) => state.inspectorOpen);
  const [asking, setAsking] = useState(false);
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const [latestAnswer, setLatestAnswer] = useState<LatestAnswer | null>(null);
  const [retrieval, setRetrieval] = useState<HybridRetrievalResult | null>(null);
  const [retrievalLoading, setRetrievalLoading] = useState(false);
  const [retrievalError, setRetrievalError] = useState<string | null>(null);
  const [askError, setAskError] = useState<unknown>(null);
  const [desktop, setDesktop] = useState(false);
  const askInFlight = useRef(false);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 1024px)");
    const update = () => setDesktop(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  async function ask(question: string) {
    if (!token || !session.data || askInFlight.current) return;
    askInFlight.current = true;
    setAsking(true);
    setPendingQuestion(question);
    setAskError(null);
    setRetrievalError(null);
    setRetrievalLoading(true);
    const start = performance.now();
    const inspection = retrievalApi.inspect(token, { query: question, owner: session.data.owner, repo: session.data.repo, limit: 25 })
      .then((result) => setRetrieval(result))
      .catch((error: unknown) => setRetrievalError(getApiErrorMessage(error)))
      .finally(() => setRetrievalLoading(false));
    try {
      const result = await sessionsApi.ask(token, sessionId, question);
      setLatestAnswer({ result, durationMs: performance.now() - start });
      await client.invalidateQueries({ queryKey: sessionKeys.all });
      await session.refetch();
      setPendingQuestion(null);
    } catch (error) {
      setAskError(error);
    } finally {
      askInFlight.current = false;
      setAsking(false);
      await inspection;
    }
  }

  async function newSession() {
    if (!session.data) return;
    try {
      const created = await create.mutateAsync({ owner: session.data.owner, repo: session.data.repo, title: `${session.data.repo} exploration` });
      router.push(`/chat/${created.id}`);
    } catch {
      // The mutation error is shown in conversation history.
    }
  }

  if (session.isLoading) return <div className="grid h-full grid-cols-[220px_1fr_320px] gap-px bg-border"><Skeleton /><Skeleton /><Skeleton /></div>;
  if (session.isError || !session.data) return <div className="p-6"><ErrorState error={session.error} retry={() => void session.refetch()} /></div>;
  const repositorySessions = sessions.data?.sessions.filter((item) => item.owner === session.data.owner && item.repo === session.data.repo) ?? [{
    id: session.data.id,
    userId: session.data.userId,
    owner: session.data.owner,
    repo: session.data.repo,
    title: session.data.title,
    createdAt: session.data.createdAt,
    updatedAt: session.data.updatedAt,
    messageCount: session.data.messages.length,
  }];
  const chat = <ChatPanel session={session.data} latestAnswer={latestAnswer} pendingQuestion={pendingQuestion} asking={asking} error={askError} onAsk={(question) => void ask(question)} />;
  const inspector = <RetrievalInspector retrieval={retrieval} loading={retrievalLoading} error={retrievalError} />;

  if (!desktop) return <div className="h-full min-h-0">{chat}{inspectorOpen ? <div className="fixed inset-x-0 bottom-0 top-28 z-30 border-t border-border shadow-2xl">{inspector}</div> : null}</div>;
  return (
    <PanelGroup direction="horizontal" className="h-full">
      <Panel defaultSize={18} minSize={14} maxSize={25} collapsible><ConversationHistory sessions={repositorySessions} activeId={sessionId} onCreate={() => void newSession()} creating={create.isPending} createError={create.error} /></Panel>
      <PanelResizeHandle className="w-px bg-border transition-colors hover:bg-primary/50 focus-visible:bg-primary" />
      <Panel minSize={40}>{chat}</Panel>
      {inspectorOpen ? <><PanelResizeHandle className="w-px bg-border transition-colors hover:bg-primary/50 focus-visible:bg-primary" /><Panel defaultSize={27} minSize={20} maxSize={40} collapsible>{inspector}</Panel></> : null}
    </PanelGroup>
  );
}
