import Link from "next/link";
import { ArrowRight, Clock3, FolderOpen, GitBranch, MessageSquare, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { SessionTimeline, orderSessions } from "@/features/sessions/session-timeline";
import { formatDate } from "@/lib/utils";
import type { IndexedRepository, SessionSummary } from "@/types/api";
import { RepositoryCard } from "./repository-card";

interface DashboardCommandCenterProps {
  repositories?: IndexedRepository[];
  repositoryCount?: number;
  repositoriesLoading?: boolean;
  repositoryError?: unknown;
  onRetryRepositories?(): void;
  sessions?: SessionSummary[];
  sessionsLoading?: boolean;
  sessionError?: unknown;
  onRetrySessions?(): void;
}

const repositoryGroups = [
  { label: "Ready", statuses: new Set(["indexed"]) },
  { label: "Indexing", statuses: new Set(["indexing"]) },
  { label: "Needs attention", statuses: new Set(["failed", "stale"]) },
] as const;

export function DashboardCommandCenter({ repositories = [], repositoryCount, repositoriesLoading = false, repositoryError, onRetryRepositories, sessions = [], sessionsLoading = false, sessionError, onRetrySessions }: DashboardCommandCenterProps) {
  const orderedSessions = orderSessions(sessions);
  const latestSession = orderedSessions[0];
  const resumeRepository = selectResumeRepository(repositories, latestSession);
  const startHref = resumeRepository ? repositoryPath(resumeRepository) : "/repositories/connect";

  return (
    <section aria-label="Engineering command center" className="mt-8">
      <ContinueInvestigation session={latestSession} loading={sessionsLoading} />
      <RepositoryStatusSection repositories={repositories} count={repositoryCount} loading={repositoriesLoading} error={repositoryError} onRetry={onRetryRepositories} />
      <SessionTimeline sessions={sessions} loading={sessionsLoading} error={sessionError} onRetry={onRetrySessions} startHref={startHref} />
      <RepositoryActions repository={resumeRepository} session={latestSession} loading={repositoriesLoading || sessionsLoading} />
    </section>
  );
}

function ContinueInvestigation({ session, loading }: { session?: SessionSummary; loading: boolean }) {
  if (!loading && !session) return null;
  return <section aria-labelledby="continue-investigation-heading">{loading ? <div role="status" aria-live="polite" aria-label="Loading continue investigation" className="border-y border-border-subtle py-4"><h2 id="continue-investigation-heading" className="sr-only">Continue investigation</h2><span className="sr-only">Loading continue investigation.</span><Skeleton className="h-5 w-44" /><Skeleton className="mt-3 h-16" /></div> : session ? <div className="grid gap-4 border-y border-border-subtle bg-selection px-4 py-5 tablet:grid-cols-[minmax(0,1fr)_auto] tablet:items-center"><div className="min-w-0"><h2 id="continue-investigation-heading" className="type-section-eyebrow text-primary">Continue investigation</h2><h3 className="mt-2 truncate type-section-title">{session.title}</h3><p className="mt-2 truncate type-mono text-muted-foreground">{session.owner}/{session.repo}</p><p className="mt-3 inline-flex items-center gap-1.5 type-metadata text-muted-foreground"><Clock3 className="size-3" />Last updated <time dateTime={session.updatedAt}>{formatDate(session.updatedAt)}</time></p></div><Button asChild variant="accent" className="w-full tablet:w-auto"><Link href={`/chat/${encodeURIComponent(session.id)}`}><MessageSquare className="size-4" />Continue session</Link></Button></div> : null}</section>;
}

function RepositoryStatusSection({ repositories, count, loading, error, onRetry }: { repositories: IndexedRepository[]; count?: number; loading: boolean; error?: unknown; onRetry?(): void }) {
  return <section aria-labelledby="repository-status-heading" className="mt-9"><div className="mb-4 flex items-end justify-between gap-4"><div><h2 id="repository-status-heading" className="type-section-eyebrow text-muted-foreground">Repository status</h2><p className="mt-2 type-compact text-text-secondary">Backend indexing state for connected repositories.</p></div><span className="type-metadata text-muted-foreground">{count ?? repositories.length} total</span></div>{error ? <ErrorState error={error} retry={onRetry} /> : null}{loading ? <DashboardRepositorySkeleton /> : null}{!loading && !error ? <div data-testid="repository-status-layout" className="grid items-start gap-7 laptop:grid-cols-[repeat(auto-fit,minmax(260px,1fr))]">{repositoryGroups.map((group) => { const items = repositories.filter((repository) => group.statuses.has(repository.status)); if (!items.length) return null; return <section key={group.label} aria-label={`${group.label} repositories`}><div className="mb-2 flex items-center justify-between"><p className="type-metadata-label text-muted-foreground">{group.label}</p><span className="type-metadata text-muted-foreground">{items.length}</span></div><div className="divide-y divide-border-subtle border-y border-border-subtle">{items.map((repository) => <RepositoryCard key={`${repository.owner}/${repository.repo}`} repository={repository} />)}</div></section>; })}</div> : null}</section>;
}

function DashboardRepositorySkeleton() {
  return <div role="status" aria-live="polite" aria-label="Loading repository command center" className="grid gap-7 laptop:grid-cols-3"><span className="sr-only">Loading repository status and actions.</span>{Array.from({ length: 3 }, (_, index) => <div key={index} className="space-y-3 border-y border-border-subtle py-3"><Skeleton className="h-4 w-24" /><Skeleton className="h-20" /><Skeleton className="h-20" /></div>)}</div>;
}

function RepositoryActions({ repository, session, loading }: { repository?: IndexedRepository; session?: SessionSummary; loading: boolean }) {
  return <section aria-labelledby="repository-actions-heading" className="mt-9"><div className="mb-4"><h2 id="repository-actions-heading" className="type-section-eyebrow text-muted-foreground">Repository actions</h2><p className="mt-2 type-compact text-text-secondary">Open an existing engineering workflow without changing repository scope.</p></div>{loading ? <div role="status" aria-live="polite" aria-label="Loading repository actions" className="grid gap-2 mobile:grid-cols-2 laptop:grid-cols-4"><Skeleton className="h-16" /><Skeleton className="h-16" /><Skeleton className="h-16" /><Skeleton className="h-16" /></div> : <nav aria-label="Repository actions" data-testid="repository-actions-layout" className="grid gap-2 mobile:grid-cols-2 laptop:grid-cols-4">{repository ? <><CommandAction href={repositoryPath(repository)} icon={FolderOpen} title="Open overview" detail={`${repository.owner}/${repository.repo}`} />{repository.status === "indexed" ? <CommandAction href={`${repositoryPath(repository)}/search`} icon={Search} title="Search repository" detail="Inspect ranked evidence" /> : null}{repository.status === "indexing" ? <CommandAction href={`${repositoryPath(repository)}/indexing`} icon={GitBranch} title="View indexing" detail="Inspect backend progress" /> : null}{session ? <CommandAction href={`/chat/${encodeURIComponent(session.id)}`} icon={MessageSquare} title="Continue session" detail={session.title} /> : null}</> : null}<CommandAction href="/repositories/connect" icon={Plus} title="Connect repository" detail="Add another codebase" /></nav>}</section>;
}

function CommandAction({ href, icon: Icon, title, detail }: { href: string; icon: typeof FolderOpen; title: string; detail: string }) {
  return <Link href={href} className="group flex min-h-16 items-center gap-3 border-y border-border-subtle px-3 py-3 hover:bg-hover focus-ring"><Icon className="size-4 shrink-0 text-primary" /><span className="min-w-0 flex-1"><span className="block type-compact-strong">{title}</span><span className="mt-1 block truncate type-metadata text-muted-foreground">{detail}</span></span><ArrowRight className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-[150ms] group-hover:translate-x-0.5 motion-reduce:transition-none" /></Link>;
}

function selectResumeRepository(repositories: IndexedRepository[], session?: SessionSummary): IndexedRepository | undefined {
  const sessionRepository = session ? repositories.find((repository) => repository.owner === session.owner && repository.repo === session.repo) : undefined;
  if (sessionRepository) return sessionRepository;
  const accessed = repositories.filter((repository) => repository.lastAccessedAt).sort((left, right) => Date.parse(right.lastAccessedAt ?? "") - Date.parse(left.lastAccessedAt ?? ""))[0];
  return accessed ?? repositories.find((repository) => repository.status === "indexed") ?? repositories[0];
}

function repositoryPath(repository: IndexedRepository): string {
  return `/repositories/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
}
