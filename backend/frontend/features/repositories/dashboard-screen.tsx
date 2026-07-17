"use client";

import Link from "next/link";
import { Activity, ArrowRight, FolderGit2, GitBranch, MessageSquare, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useRepositories } from "@/hooks/use-repositories";
import { useSessions } from "@/hooks/use-sessions";
import { formatDate } from "@/lib/utils";
import { RepositoryCard } from "./repository-card";

export function DashboardScreen() {
  const repositories = useRepositories();
  const sessions = useSessions();

  return (
    <div className="mx-auto w-full max-w-[1500px] p-4 sm:p-6 lg:p-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div><p className="font-mono text-[11px] uppercase tracking-[0.18em] text-primary">Workspace</p><h1 className="mt-2 font-display text-4xl italic tracking-tight sm:text-5xl">Repository intelligence</h1><p className="mt-2 text-sm text-muted-foreground">Connect codebases, inspect evidence, and continue grounded conversations.</p></div>
        <Button asChild><Link href="/repositories/connect"><Plus className="size-4" />Quick connect</Link></Button>
      </div>
      <section aria-labelledby="repositories-heading" className="mt-10">
        <div className="mb-4 flex items-center justify-between"><div><h2 id="repositories-heading" className="text-sm font-medium">Repositories</h2><p className="mt-1 text-xs text-muted-foreground">Indexed and ready for questions</p></div><span className="font-mono text-xs text-muted-foreground">{repositories.data?.count ?? 0}</span></div>
        {repositories.isError ? <ErrorState error={repositories.error} retry={() => void repositories.refetch()} /> : null}
        {repositories.isLoading ? <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 3 }, (_, index) => <Skeleton key={index} className="h-44" />)}</div> : null}
        {repositories.data?.repositories.length ? <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{repositories.data.repositories.map((repository) => <RepositoryCard key={`${repository.owner}/${repository.repo}`} repository={repository} />)}</div> : null}
        {repositories.data?.repositories.length === 0 ? <EmptyState icon={FolderGit2} title="Connect your first repository" description="Index a GitHub repository to unlock summaries, grounded Q&A, and retrieval inspection." action={<Button asChild size="sm"><Link href="/repositories/connect"><GitBranch className="size-4" />Connect repository</Link></Button>} /> : null}
      </section>
      <div className="mt-10 grid gap-6 xl:grid-cols-2">
        <section aria-labelledby="sessions-heading"><div className="mb-4"><h2 id="sessions-heading" className="text-sm font-medium">Recent sessions</h2><p className="mt-1 text-xs text-muted-foreground">Continue where you left off</p></div><Card className="divide-y divide-border">
          {sessions.isError ? <div className="p-3"><ErrorState error={sessions.error} retry={() => void sessions.refetch()} compact /></div> : null}
          {sessions.isLoading ? <div className="space-y-3 p-4"><Skeleton className="h-12" /><Skeleton className="h-12" /></div> : null}
          {sessions.data?.sessions.slice(0, 5).map((session) => <Link key={session.id} href={`/chat/${session.id}`} className="flex items-center gap-3 p-4 transition-colors hover:bg-foreground/[0.025] focus-ring"><span className="grid size-8 shrink-0 place-items-center rounded-md bg-foreground/5"><MessageSquare className="size-3.5 text-muted-foreground" /></span><span className="min-w-0 flex-1"><span className="block truncate text-sm">{session.title}</span><span className="mt-0.5 block text-xs text-muted-foreground">{session.owner}/{session.repo} · {session.messageCount} messages</span></span><ArrowRight className="size-3.5 text-muted-foreground" /></Link>)}
          {!sessions.isLoading && sessions.data?.sessions.length === 0 ? <p className="p-6 text-sm text-muted-foreground">No sessions yet. Open a repository to begin.</p> : null}
        </Card></section>
        <section aria-labelledby="activity-heading"><div className="mb-4"><h2 id="activity-heading" className="text-sm font-medium">Recent activity</h2><p className="mt-1 text-xs text-muted-foreground">Derived from repository and session updates</p></div><Card className="divide-y divide-border">
          {sessions.data?.sessions.slice(0, 4).map((session) => <div key={session.id} className="flex items-center gap-3 p-4"><Activity className="size-3.5 text-primary" /><div className="min-w-0 flex-1"><p className="truncate text-sm">Session updated in {session.repo}</p><p className="mt-0.5 text-xs text-muted-foreground">{formatDate(session.updatedAt)}</p></div></div>)}
          {!sessions.isLoading && sessions.data?.sessions.length === 0 ? <p className="p-6 text-sm text-muted-foreground">Activity will appear as you use Giro.</p> : null}
        </Card></section>
      </div>
    </div>
  );
}
