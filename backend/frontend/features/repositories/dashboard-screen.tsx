"use client";

import Link from "next/link";
import { Braces, GitBranch, MessageSquare, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useRepositories } from "@/hooks/use-repositories";
import { useSessions } from "@/hooks/use-sessions";
import { SessionTimeline } from "@/features/sessions/session-timeline";
import { RepositoryCard } from "./repository-card";

export function DashboardScreen() {
  const repositories = useRepositories();
  const sessions = useSessions();
  const hasRepositories = Boolean(repositories.data?.repositories.length);
  const empty = !repositories.isLoading && !repositories.isError && repositories.data?.repositories.length === 0;
  const firstRepository = repositories.data?.repositories[0];
  const investigationStartHref = firstRepository ? `/repositories/${encodeURIComponent(firstRepository.owner)}/${encodeURIComponent(firstRepository.repo)}` : "/repositories/connect";

  return (
    <div className="layout-standard layout-gutter py-10 max-[820px]:py-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div><p className="type-section-eyebrow text-muted-foreground">Workspace</p><h1 className="mt-2 type-page-title">Repository <span className="italic text-primary">intelligence</span><span className="not-italic">.</span></h1><p className="mt-2 type-body text-text-secondary">Connect codebases, inspect evidence, and continue grounded conversations.</p></div>
        {hasRepositories ? <Button variant="accent" asChild><Link href="/repositories/connect"><Plus className="size-4" />Connect repository</Link></Button> : null}
      </div>
      {empty ? <EmptyDashboardOnboarding /> : <><section aria-labelledby="repositories-heading" className="mt-7">
        <div className="mb-3 flex items-end justify-between"><div><h2 id="repositories-heading" className="type-section-eyebrow text-muted-foreground">Repositories</h2><p className="mt-2 type-compact text-text-secondary">Indexed repositories available for grounded questions</p></div><span className="type-metadata text-muted-foreground">{repositories.data?.count ?? 0} total</span></div>
        {repositories.isError ? <ErrorState error={repositories.error} retry={() => void repositories.refetch()} /> : null}
        {repositories.isLoading ? <div role="status" aria-live="polite" aria-label="Loading repositories" className="divide-y divide-border-subtle border-y border-border-subtle">{Array.from({ length: 3 }, (_, index) => <Skeleton key={index} className="h-20" />)}</div> : null}
        {repositories.data?.repositories.length ? <div className="divide-y divide-border-subtle border-y border-border-subtle">{repositories.data.repositories.map((repository) => <RepositoryCard key={`${repository.owner}/${repository.repo}`} repository={repository} />)}</div> : null}
      </section>
      <SessionTimeline sessions={sessions.data?.sessions} loading={sessions.isLoading} error={sessions.isError ? sessions.error : undefined} onRetry={() => void sessions.refetch()} startHref={investigationStartHref} /></>}
    </div>
  );
}

const onboardingSteps = [
  { icon: GitBranch, title: "Connect a repository", detail: "Provide one complete GitHub repository URL." },
  { icon: Braces, title: "Giro indexes repository knowledge", detail: "The backend clones, parses, chunks, embeds, and stores repository context." },
  { icon: Braces, title: "Explore architecture", detail: "Review the generated summary, entry points, modules, symbols, and dependencies that are available." },
  { icon: Search, title: "Search repository evidence", detail: "Retrieve ranked excerpts with source paths, line ranges, symbols, and scores." },
  { icon: MessageSquare, title: "Ask repository-scoped questions", detail: "Start a session after indexing is ready and inspect citations attached to answers." },
];

function EmptyDashboardOnboarding() {
  return <section aria-labelledby="first-repository-heading" className="mt-10 grid items-start gap-10 laptop:grid-cols-[300px_minmax(0,1fr)]"><div><p className="type-section-eyebrow text-muted-foreground">No repositories connected</p><h2 id="first-repository-heading" className="mt-2 type-section-title">Establish repository context first.</h2><p className="mt-3 type-body text-text-secondary">Giro needs an indexed repository before architecture, search evidence, sessions, or repository-scoped questions are available.</p><Button asChild variant="accent" className="mt-6 w-full mobile:w-auto"><Link href="/repositories/connect"><GitBranch className="size-4" />Connect repository</Link></Button></div><ol aria-label="Repository onboarding steps" className="divide-y divide-border-subtle border-y border-border-subtle">{onboardingSteps.map(({ icon: Icon, title, detail }, index) => <li key={title} className="grid gap-3 px-3 py-4 mobile:grid-cols-[32px_28px_minmax(0,1fr)] mobile:items-start"><span className="type-metadata text-muted-foreground">0{index + 1}</span><Icon className={index === 0 ? "size-4 text-primary" : "size-4 text-muted-foreground"} /><div><h3 className="type-compact-strong">{title}</h3><p className="mt-1 type-compact text-muted-foreground">{detail}</p></div></li>)}</ol></section>;
}
