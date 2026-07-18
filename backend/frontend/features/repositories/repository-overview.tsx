"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, FileCode2, LoaderCircle, MessageSquare, Play, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { InlineAlert } from "@/components/ui/inline-alert";
import { Skeleton } from "@/components/ui/skeleton";
import { getRepositoryStatus, RepositoryStatusBadge } from "@/components/ui/status-badge";
import { Tabs } from "@/components/ui/tabs";
import { useRepositories, useRepository } from "@/hooks/use-repositories";
import { useCreateSession, useSessions } from "@/hooks/use-sessions";
import { formatDate } from "@/lib/utils";
import type { RepositorySummaryItem } from "@/types/api";

const REPOSITORY_TAB_IDS = ["summary", "architecture", "files", "symbols", "dependencies", "sessions", "settings"] as const;
type RepositoryTab = (typeof REPOSITORY_TAB_IDS)[number];

function repositoryTab(value: string | null): RepositoryTab {
  return REPOSITORY_TAB_IDS.find((tab) => tab === value) ?? "summary";
}

export function RepositoryOverview({ owner, repo }: { owner: string; repo: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const summary = useRepository(owner, repo);
  const repositories = useRepositories();
  const create = useCreateSession();
  const sessions = useSessions();
  const activeTab = repositoryTab(searchParams.get("tab"));
  const indexed = repositories.data?.repositories.find((item) => item.owner === owner && item.repo === repo);
  const repositoryStatus = getRepositoryStatus(indexed?.status);
  const details = summary.data?.summary;

  async function openSession() {
    if (!repositoryStatus.ready) return;
    const session = await create.mutateAsync({ owner, repo, title: `${repo} exploration` });
    router.push(`/chat/${session.id}`);
  }

  if (repositories.isLoading || summary.isLoading) return <div className="layout-standard layout-gutter space-y-4 py-10"><Skeleton className="h-24" /><Skeleton className="h-10" /><Skeleton className="h-56" /></div>;
  if (repositories.isError) return <div className="layout-standard layout-gutter py-10"><ErrorState error={repositories.error} retry={() => void repositories.refetch()} /></div>;

  const architecture = [
    group("Languages", names(details?.languages)),
    group("Frameworks", names(details?.frameworks)),
    group("Package managers", names(details?.packageManagers)),
    group("Applications", paths(details?.applications)),
    group("Libraries", paths(details?.libraries)),
    group("Services", paths(details?.services)),
  ].filter(hasItems);
  const repositoryShape = [
    group("Important directories", paths(details?.importantDirectories)),
    group("Configuration files", paths(details?.configFiles)),
  ].filter(hasItems);
  const symbols = [
    group("Modules", paths(details?.modules)),
    group("API surface", names(details?.apiSurface)),
  ].filter(hasItems);
  const systemSurfaces = [
    group("Background workers", paths(details?.backgroundWorkers)),
    group("Data stores", paths(details?.dataStores)),
    group("Authentication", paths(details?.authentication)),
    group("Retrieval", paths(details?.retrieval)),
    group("Indexing", paths(details?.indexing)),
  ].filter(hasItems);
  const delivery = [
    group("Testing", paths(details?.testing)),
    group("Build", paths(details?.build)),
    group("Deployment", paths(details?.deployment)),
  ].filter(hasItems);
  const dependencies = [
    group("Central modules", details?.dependencyOverview?.centralModules ?? []),
    group("Dependency hotspots", details?.dependencyOverview?.dependencyHotspots ?? []),
    group("Circular dependencies", details?.dependencyOverview?.circularDependencies?.map((cycle) => cycle.join(" → ")) ?? []),
  ].filter(hasItems);
  const repositorySessions = sessions.data?.sessions.filter((session) => session.owner === owner && session.repo === repo) ?? [];
  const tabs = REPOSITORY_TAB_IDS.map((id) => ({ id, label: id[0]?.toUpperCase() + id.slice(1), panelId: `repository-${id}-panel` }));

  function selectTab(tab: string) {
    const nextSearchParams = new URLSearchParams(searchParams.toString());
    nextSearchParams.set("tab", repositoryTab(tab));
    router.push(
      `/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}?${nextSearchParams.toString()}`,
      { scroll: false },
    );
  }

  return (
    <div className="layout-standard layout-gutter py-10 max-[820px]:py-8">
      <header className="flex flex-col gap-5 border-b border-border-subtle pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="type-section-eyebrow text-muted-foreground">{owner}</p>
          <h1 aria-label={repo} className="mt-2 break-words type-page-title"><span className="type-page-title-accent">{repo}</span><span className="not-italic text-foreground">.</span></h1>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <RepositoryStatusBadge status={indexed?.status} />
            {details?.repositoryVersion ? <span className="type-metadata text-muted-foreground">VERSION {details.repositoryVersion}</span> : null}
            {indexed?.lastIndexedAt ? <span className="type-metadata text-muted-foreground">INDEXED {formatDate(indexed.lastIndexedAt)}</span> : null}
          </div>
          {details?.purpose ? <p className="mt-4 max-w-[68ch] type-body text-text-secondary">{details.purpose}</p> : null}
        </div>
        <Button variant="accent" onClick={() => void openSession()} disabled={create.isPending || !repositoryStatus.ready}>{create.isPending ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" /> : <Play className="size-4" />}{create.isPending ? "Creating…" : "Open session"}</Button>
      </header>

      {!repositoryStatus.ready ? <InlineAlert tone={repositoryStatus.label === "Failed" ? "danger" : "warning"} className="mt-4"><div className="flex flex-wrap items-center gap-3"><div className="min-w-0 flex-1"><p className="type-compact-strong">{repositoryStatus.label} repository</p><p className="mt-1">{repositoryStatus.label === "Failed" ? "Indexing failed. Retry the repository connection before starting a session." : repositoryStatus.label === "Stale" ? "Repository evidence is stale. Reindex before starting a new session." : "Repository intelligence must be ready before starting a session."}</p></div><Button variant="secondary" size="sm" onClick={() => router.push(indexed?.status === "failed" ? "/repositories/connect" : `/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/indexing`)}>{indexed?.status === "failed" ? "Reconnect repository" : "View indexing"}<ArrowRight className="size-3.5" /></Button></div></InlineAlert> : null}

      {create.isError ? <div className="mt-4"><ErrorState error={create.error} compact /></div> : null}
      {summary.isError ? <div className="mt-4"><ErrorState error={summary.error} retry={() => void summary.refetch()} compact /></div> : null}

      <div className="mt-7"><Tabs label="Repository sections" items={tabs} value={activeTab} onValueChange={selectTab} /></div>

      <div id={`repository-${activeTab}-panel`} role="tabpanel" className="mt-7">
        {activeTab === "summary" ? <div className="grid gap-7 desktop:grid-cols-[minmax(0,760px)_320px]">
          <div className="min-w-0">{indexed ? <section className="grid grid-cols-2 divide-x divide-y divide-border-subtle border-y border-border-subtle sm:grid-cols-3 desktop:grid-cols-5" aria-label="Repository metrics"><Metric label="Files" value={indexed.fileCount} /><Metric label="Chunks" value={indexed.chunkCount} /><Metric label="Symbols" value={indexed.symbolCount} /><Metric label="Graph nodes" value={indexed.graphNodeCount} /><Metric label="Graph edges" value={indexed.graphEdgeCount} /></section> : <EmptyState icon={FileCode2} title="Repository metrics unavailable" description="Indexing has not exposed repository metrics yet." />}</div>
          <aside className="min-w-0" aria-label="Repository index summary"><Panel className="border border-border-subtle p-4"><h2 className="type-panel-title">Latest indexing run</h2><dl className="mt-4 divide-y divide-border-subtle"><Row label="Status" value={repositoryStatus.label} /><Row label="Version" value={details?.repositoryVersion} mono /><Row label="Indexed" value={indexed?.lastIndexedAt ? formatDate(indexed.lastIndexedAt) : undefined} /><Row label="Mode" value={indexed?.lastIndexMode ?? undefined} /><Row label="Changed files" value={indexed ? String(indexed.lastChangedFileCount) : undefined} /><Row label="Retries" value={indexed ? String(indexed.retryCount) : undefined} /></dl></Panel></aside>
        </div> : null}

        {activeTab === "architecture" ? <div className="layout-editorial ml-0 space-y-7">{architecture.length ? <OverviewSection eyebrow="Architecture" description="Languages, frameworks, package boundaries, and major repository surfaces."><DefinitionGroups groups={architecture} /></OverviewSection> : null}{details?.entrypoints?.length ? <OverviewSection eyebrow="Entry points" description="Likely starting points discovered during indexing."><div className="divide-y divide-border-subtle border-y border-border-subtle">{details.entrypoints.map((item) => <div key={`${item.name}-${item.path ?? ""}`} className="flex min-h-10 items-center gap-3 px-3 py-2"><ArrowRight className="size-3.5 shrink-0 text-primary" /><span className="min-w-0 flex-1 break-all type-mono-strong">{item.path ?? item.name}</span>{item.kind ? <span className="type-metadata text-muted-foreground">{item.kind}</span> : null}</div>)}</div></OverviewSection> : null}{systemSurfaces.length ? <OverviewSection eyebrow="System surfaces" description="Runtime and repository-intelligence concerns exposed by the summary."><DefinitionGroups groups={systemSurfaces} /></OverviewSection> : null}{delivery.length ? <OverviewSection eyebrow="Delivery" description="Testing, build, and deployment metadata."><DefinitionGroups groups={delivery} /></OverviewSection> : null}{!architecture.length && !details?.entrypoints?.length && !systemSurfaces.length && !delivery.length ? <EmptyState icon={FileCode2} title="Architecture unavailable" description="The repository summary did not expose architecture data." /> : null}</div> : null}

        {activeTab === "files" ? repositoryShape.length ? <div className="layout-editorial ml-0"><OverviewSection eyebrow="Files" description="Important directories and configuration files exposed by indexing."><DefinitionGroups groups={repositoryShape} /></OverviewSection></div> : <EmptyState icon={FileCode2} title="File summary unavailable" description="The repository summary did not expose file groups." /> : null}

        {activeTab === "symbols" ? symbols.length ? <div className="layout-editorial ml-0"><OverviewSection eyebrow="Symbols" description="Modules and API surfaces exposed by indexing."><DefinitionGroups groups={symbols} /></OverviewSection></div> : <EmptyState icon={FileCode2} title="Symbol summary unavailable" description="The repository summary did not expose symbol groups." /> : null}

        {activeTab === "dependencies" ? dependencies.length ? <div className="layout-editorial ml-0"><OverviewSection eyebrow="Dependencies" description="Central modules, hotspots, and detected cycles."><DefinitionGroups groups={dependencies} /></OverviewSection></div> : <EmptyState icon={FileCode2} title="Dependency summary unavailable" description="The repository summary did not expose dependency relationships." /> : null}

        {activeTab === "sessions" ? <section aria-label="Repository sessions" className="layout-editorial ml-0"><div className="divide-y divide-border-subtle border-y border-border-subtle">{sessions.isError ? <div className="p-3"><ErrorState error={sessions.error} retry={() => void sessions.refetch()} compact /></div> : null}{sessions.isLoading ? <div className="space-y-3 p-3"><Skeleton className="h-10" /><Skeleton className="h-10" /></div> : null}{repositorySessions.map((session) => <Link key={session.id} href={`/chat/${session.id}`} className="flex min-h-10 items-center gap-3 px-3 py-2 hover:bg-hover focus-ring"><MessageSquare className="size-3.5 text-muted-foreground" /><span className="min-w-0 flex-1 truncate type-compact-strong">{session.title}</span><span className="type-metadata text-muted-foreground">{session.messageCount} messages</span></Link>)}</div>{!sessions.isLoading && !sessions.isError && repositorySessions.length === 0 ? <EmptyState icon={MessageSquare} title="No repository sessions" description="Start a session from the primary action when repository intelligence is ready." /> : null}</section> : null}

        {activeTab === "settings" ? <EmptyState icon={Settings} title="No repository settings exposed" description="The current backend does not expose repository-specific settings." /> : null}
      </div>
    </div>
  );
}

interface Group { label: string; items: string[] }
function group(label: string, items: string[]): Group { return { label, items }; }
function hasItems(value: Group): boolean { return value.items.length > 0; }

function OverviewSection({ eyebrow, description, children }: { eyebrow: string; description: string; children: React.ReactNode }) {
  return <section><p className="type-section-eyebrow text-muted-foreground">{eyebrow}</p><p className="mt-2 type-compact text-text-secondary">{description}</p><div className="mt-3">{children}</div></section>;
}

function DefinitionGroups({ groups }: { groups: Group[] }) {
  return <dl className="divide-y divide-border-subtle border-y border-border-subtle">{groups.map((item) => <div key={item.label} className="grid min-h-10 gap-2 px-3 py-2 mobile:grid-cols-[140px_minmax(0,1fr)]"><dt className="type-compact-strong text-text-secondary">{item.label}</dt><dd className="min-w-0"><ValueList items={item.items} /></dd></div>)}</dl>;
}

function ValueList({ items }: { items: string[] }) {
  const visible = items.slice(0, 8);
  const remaining = items.slice(8);
  return <div className="space-y-1">{visible.map((item) => <div key={item} className="break-all type-mono text-foreground">{item}</div>)}{remaining.length ? <details><summary className="cursor-pointer rounded-control type-compact text-muted-foreground focus-ring">Show {remaining.length} more</summary><div className="mt-1 space-y-1">{remaining.map((item) => <div key={item} className="break-all type-mono text-foreground">{item}</div>)}</div></details> : null}</div>;
}

function Metric({ label, value }: { label: string; value: number }) {
  return <div className="p-3"><p className="type-metadata-label text-muted-foreground">{label}</p><p className="mt-2 type-mono-strong tabular-nums">{value.toLocaleString()}</p></div>;
}

function Row({ label, value, mono }: { label: string; value: string | undefined; mono?: boolean }) {
  if (value === undefined) return null;
  return <div className="flex min-h-10 items-start justify-between gap-4 py-2 type-compact"><dt className="text-muted-foreground">{label}</dt><dd className={mono ? "max-w-[65%] break-all text-right type-metadata text-foreground" : "max-w-[65%] break-words text-right text-foreground"}>{value}</dd></div>;
}

function names(items: RepositorySummaryItem[] | undefined): string[] { return items?.map((item) => item.name) ?? []; }
function paths(items: RepositorySummaryItem[] | undefined): string[] { return items?.map((item) => item.path ?? item.name) ?? []; }
