import Link from "next/link";
import { MessageSquare, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import type { SessionSummary } from "@/types/api";

export function ConversationHistory({ sessions, activeId, onCreate, creating, createError }: { sessions: SessionSummary[]; activeId: string; onCreate(): void; creating: boolean; createError?: unknown }) {
  return (
    <aside className="flex h-full min-h-0 flex-col bg-panel" aria-label="Conversation history">
      <div className="space-y-2 border-b border-border p-3"><Button variant="secondary" className="w-full justify-start" size="sm" onClick={onCreate} disabled={creating}><Plus className="size-3.5" />New session</Button>{createError ? <ErrorState error={createError} compact /> : null}</div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2"><p className="px-2 pb-2 pt-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Repository sessions</p>{sessions.map((session) => <Link key={session.id} href={`/chat/${session.id}`} className={`mb-1 flex items-start gap-2 rounded-md p-2.5 text-xs transition-colors focus-ring ${session.id === activeId ? "border border-border bg-muted text-foreground" : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground"}`}><MessageSquare className={`mt-0.5 size-3.5 shrink-0 ${session.id === activeId ? "text-primary" : ""}`} /><span className="min-w-0"><span className="block truncate">{session.title}</span><span className="mt-1 block text-[10px] text-muted-foreground">{session.messageCount} messages</span></span></Link>)}</div>
    </aside>
  );
}
