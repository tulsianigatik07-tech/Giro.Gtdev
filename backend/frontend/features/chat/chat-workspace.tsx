"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Panel, PanelGroup } from "react-resizable-panels";
import { useQueryClient } from "@tanstack/react-query";
import { List, PanelRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { Drawer } from "@/components/ui/drawer";
import { ResizableHandle } from "@/components/ui/resizable-handle";
import { SegmentedControl } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { getRepositoryStatus } from "@/components/ui/status-badge";
import { useAuth } from "@/features/auth/auth-context";
import { RetrievalInspector } from "@/features/retrieval/retrieval-inspector";
import { useRepositories } from "@/hooks/use-repositories";
import { sessionKeys, useCreateSession, useDeleteSession, useSession, useSessions } from "@/hooks/use-sessions";
import { sessionsApi } from "@/services/api/sessions";
import { useUiStore } from "@/store/ui-store";
import type { HybridRetrievalResult } from "@/types/api";
import { ChatPanel, type LatestAnswer } from "./chat-panel";
import { ConversationHistory } from "./conversation-history";

export function ChatWorkspace({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchParamString = searchParams.toString();
  const draftParameter = searchParams.get("draft");
  const client = useQueryClient();
  const { token } = useAuth();
  const session = useSession(sessionId);
  const sessions = useSessions();
  const repositories = useRepositories();
  const create = useCreateSession();
  const remove = useDeleteSession();
  const inspectorOpen = useUiStore((state) => state.inspectorOpen);
  const setInspectorOpen = useUiStore((state) => state.setInspectorOpen);
  const historyOpen = useUiStore((state) => state.historyOpen);
  const setHistoryOpen = useUiStore((state) => state.setHistoryOpen);
  const chatView = useUiStore((state) => state.chatView);
  const setChatView = useUiStore((state) => state.setChatView);
  const [asking, setAsking] = useState(false);
  const [composerQuestion, setComposerQuestion] = useState("");
  const [draftFocusPending, setDraftFocusPending] = useState(false);
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const [latestAnswer, setLatestAnswer] = useState<LatestAnswer | null>(null);
  const [retrieval, setRetrieval] = useState<HybridRetrievalResult | null>(null);
  const [retrievalLoading, setRetrievalLoading] = useState(false);
  const [retrievalError, setRetrievalError] = useState<string | null>(null);
  const [askError, setAskError] = useState<unknown>(null);
  const [layout, setLayout] = useState<"wide" | "split" | "tablet" | "mobile">("mobile");
  const [selectedEvidencePath, setSelectedEvidencePath] = useState<string | null>(null);
  const askInFlight = useRef(false);
  const adoptedDraftRef = useRef<string | null>(null);
  const initialDraft = draftParameter && adoptedDraftRef.current !== draftParameter ? draftParameter : undefined;

  const removeAdoptedDraft = useCallback(() => {
    if (!draftParameter || adoptedDraftRef.current === draftParameter) return;
    adoptedDraftRef.current = draftParameter;
    setDraftFocusPending(true);
    const nextSearchParams = new URLSearchParams(searchParamString);
    nextSearchParams.delete("draft");
    const suffix = nextSearchParams.toString();
    router.replace(`${pathname}${suffix ? `?${suffix}` : ""}`, { scroll: false });
  }, [draftParameter, pathname, router, searchParamString]);
  const clearDraftFocus = useCallback(() => setDraftFocusPending(false), []);

  useEffect(() => {
    const update = () => setLayout(window.innerWidth >= 1400 ? "wide" : window.innerWidth >= 1081 ? "split" : window.innerWidth >= 821 ? "tablet" : "mobile");
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  async function ask(question: string) {
    if (!token || !session.data || askInFlight.current) return;
    const indexedRepository = repositories.data?.repositories.find((item) => item.owner === session.data?.owner && item.repo === session.data?.repo);
    if (!getRepositoryStatus(indexedRepository?.status).ready) return;
    askInFlight.current = true;
    setAsking(true);
    setPendingQuestion(question);
    setAskError(null);
    setRetrievalError(null);
    setRetrievalLoading(true);
    const start = performance.now();
    try {
      const result = await sessionsApi.ask(token, sessionId, question);
      setRetrieval(result.retrieval);
      setRetrievalLoading(false);
      setLatestAnswer({ result, durationMs: performance.now() - start });
      await client.invalidateQueries({ queryKey: sessionKeys.all });
      await session.refetch();
      setPendingQuestion(null);
    } catch (error) {
      setAskError(error);
      setRetrievalError("Evidence could not be retrieved for this answer.");
      setRetrievalLoading(false);
    } finally {
      askInFlight.current = false;
      setAsking(false);
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

  if (session.isLoading) return <div role="status" aria-live="polite" aria-label="Loading Ask Giro workspace" className="grid h-full grid-cols-1 gap-px bg-border-subtle laptop:grid-cols-[220px_1fr] min-[1400px]:grid-cols-[220px_1fr_360px]"><span className="sr-only">Loading Ask Giro workspace.</span><Skeleton /><Skeleton className="hidden laptop:block" /><Skeleton className="hidden min-[1400px]:block" /></div>;
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
  const indexedRepository = repositories.data?.repositories.find((item) => item.owner === session.data.owner && item.repo === session.data.repo);
  const repositoryStatus = getRepositoryStatus(indexedRepository?.status);
  const repositoryPath = `/repositories/${encodeURIComponent(session.data.owner)}/${encodeURIComponent(session.data.repo)}`;
  const blockedState = repositories.isLoading
    ? { message: "Checking repository readiness…" }
    : repositoryStatus.ready
      ? undefined
      : repositoryStatus.label === "Failed" || repositoryStatus.label === "Disconnected"
        ? { message: "Repository unavailable. Reconnect the repository before asking questions.", actionHref: "/repositories/connect", actionLabel: "Connect repository" }
        : { message: "Indexing required. Repository intelligence must be ready before asking questions.", actionHref: `${repositoryPath}/indexing`, actionLabel: "View indexing" };
  const chat = <ChatPanel session={session.data} latestAnswer={latestAnswer} pendingQuestion={pendingQuestion} asking={asking} error={askError} blockedState={blockedState} initialDraft={initialDraft} composerValue={composerQuestion} focusComposer={draftFocusPending} selectedEvidencePath={selectedEvidencePath} onSelectEvidence={setSelectedEvidencePath} onComposerChange={setComposerQuestion} onComposerFocused={clearDraftFocus} onDraftAdopted={removeAdoptedDraft} onAsk={(question) => void ask(question)} />;
  const inspector = <RetrievalInspector retrieval={retrieval} loading={retrievalLoading} error={retrievalError} selectedPath={selectedEvidencePath} onSelectPath={setSelectedEvidencePath} onClose={() => { setInspectorOpen(false); if (layout === "mobile") setChatView("conversation"); }} />;
  async function deleteSession(id: string) {
    await remove.mutateAsync(id);
    if (id === sessionId) router.push("/dashboard");
  }
  const history = <ConversationHistory sessions={repositorySessions} activeId={sessionId} onCreate={() => void newSession()} creating={create.isPending} createError={create.error} onDelete={(id) => void deleteSession(id)} deleting={remove.isPending} />;

  if (layout === "mobile") return <div className="flex h-full min-h-0 flex-col"><div className="border-b border-border-subtle p-1"><SegmentedControl label="Ask Giro workspace" items={[{ id: "sessions", label: "Sessions" }, { id: "conversation", label: "Conversation" }, { id: "inspector", label: "Evidence" }]} value={chatView} onValueChange={(value) => setChatView(value as typeof chatView)} /></div><div className="relative min-h-0 flex-1"><div className={chatView === "sessions" ? "absolute inset-0" : "hidden"}>{history}</div><div className={chatView === "conversation" ? "absolute inset-0" : "hidden"}>{chat}</div><div className={chatView === "inspector" ? "absolute inset-0" : "hidden"}>{inspector}</div></div></div>;

  if (layout === "tablet") return <div className="relative flex h-full min-h-0 flex-col"><div className="flex h-10 shrink-0 items-center gap-1 border-b border-border-subtle px-2"><Button variant="ghost" size="sm" onClick={() => { setInspectorOpen(false); setHistoryOpen(true); }}><List className="size-4" />Sessions</Button><Button variant="ghost" size="sm" className="ml-auto" onClick={() => { setHistoryOpen(false); setInspectorOpen(true); }}><PanelRight className="size-4" />Evidence</Button></div><div className="min-h-0 flex-1">{chat}</div><Drawer open={historyOpen} label="Session history" side="left" onClose={() => setHistoryOpen(false)}>{history}</Drawer><Drawer open={inspectorOpen} label="Repository evidence" side="right" onClose={() => setInspectorOpen(false)}>{inspector}</Drawer></div>;

  if (layout === "split") return <div className="relative h-full min-h-0"><PanelGroup direction="horizontal" autoSaveId="giro-chat-split"><Panel defaultSize={22} minSize={18} maxSize={30} collapsible>{history}</Panel><ResizableHandle /><Panel minSize={55}>{chat}</Panel></PanelGroup><Drawer open={inspectorOpen} label="Retrieval inspector" side="right" onClose={() => setInspectorOpen(false)}>{inspector}</Drawer></div>;
  return (
    <PanelGroup direction="horizontal" className="h-full" autoSaveId="giro-chat-wide">
      <Panel defaultSize={18} minSize={14} maxSize={25} collapsible>{history}</Panel>
      <ResizableHandle />
      <Panel minSize={40}>{chat}</Panel>
      {inspectorOpen ? <><ResizableHandle /><Panel defaultSize={30} minSize={26} maxSize={36} collapsible>{inspector}</Panel></> : null}
    </PanelGroup>
  );
}
