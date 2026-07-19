"use client";

import Link from "next/link";
import { Braces, GitBranch, MessageSquare, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRepositories } from "@/hooks/use-repositories";
import { useSessions } from "@/hooks/use-sessions";
import { DashboardCommandCenter } from "./dashboard-command-center";

export function DashboardScreen() {
  const repositories = useRepositories();
  const sessions = useSessions();
  const hasRepositories = Boolean(repositories.data?.repositories.length);
  const empty = !repositories.isLoading && !repositories.isError && repositories.data?.repositories.length === 0;

  return (
    <div className="layout-standard layout-gutter py-10 max-[820px]:py-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div><p className="type-section-eyebrow text-muted-foreground">Workspace</p><h1 className="mt-2 type-page-title">Repository <span className="italic text-primary">intelligence</span><span className="not-italic">.</span></h1><p className="mt-2 type-body text-text-secondary">Connect codebases, inspect evidence, and continue grounded conversations.</p></div>
        {hasRepositories ? <Button variant="accent" asChild><Link href="/repositories/connect"><Plus className="size-4" />Connect repository</Link></Button> : null}
      </div>
      {empty ? <EmptyDashboardOnboarding /> : <DashboardCommandCenter repositories={repositories.data?.repositories} repositoryCount={repositories.data?.count} repositoriesLoading={repositories.isLoading} repositoryError={repositories.isError ? repositories.error : undefined} onRetryRepositories={() => void repositories.refetch()} sessions={sessions.data?.sessions} sessionsLoading={sessions.isLoading} sessionError={sessions.isError ? sessions.error : undefined} onRetrySessions={() => void sessions.refetch()} />}
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
