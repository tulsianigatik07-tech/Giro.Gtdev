"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, FileCode2, LoaderCircle, MessageSquare, Play, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { InlineAlert } from "@/components/ui/inline-alert";
import { Skeleton } from "@/components/ui/skeleton";
import { getRepositoryStatus, RepositoryStatusBadge } from "@/components/ui/status-badge";
import { Tabs } from "@/components/ui/tabs";
import { AskGiroDialog, type AskGiroTarget } from "@/features/repositories/ask-giro-dialog";
import { RepositoryExplorerDetail } from "@/features/repositories/repository-explorer-detail";
import { RepositoryExplorerList } from "@/features/repositories/repository-explorer-list";
import { useRepositories, useRepository, useRepositoryWorkspace } from "@/hooks/use-repositories";
import { useCreateSession, useSessions } from "@/hooks/use-sessions";
import {
  extractRepositoryExplorerCategories,
  findRepositoryExplorerItem,
  normalizeRepositoryExplorerCategory,
  type RepositoryExplorerItem,
  type RepositoryExplorerTab,
} from "@/lib/repository-explorer";
import { formatDate } from "@/lib/utils";
import { RepositorySummaryOverview } from "./repository-summary-overview";

const REPOSITORY_TAB_IDS = ["summary", "architecture", "files", "symbols", "dependencies", "sessions", "settings"] as const;
type RepositoryTab = (typeof REPOSITORY_TAB_IDS)[number];

function repositoryTab(value: string | null): RepositoryTab {
  return REPOSITORY_TAB_IDS.find((tab) => tab === value) ?? "summary";
}

function isExplorerTab(tab: RepositoryTab): tab is RepositoryExplorerTab {
  return tab === "architecture" || tab === "files" || tab === "symbols" || tab === "dependencies";
}

export function RepositoryOverview({ owner, repo }: { owner: string; repo: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const summary = useRepository(owner, repo);
  const repositories = useRepositories();
  const create = useCreateSession();
  const sessions = useSessions();
  const [askTarget, setAskTarget] = useState<AskGiroTarget | null>(null);
  const activeTab = repositoryTab(searchParams.get("tab"));
  const indexed = repositories.data?.repositories.find((item) => item.owner === owner && item.repo === repo);
  const workspace = useRepositoryWorkspace(owner, repo, activeTab === "summary" && Boolean(indexed));
  const repositoryStatus = getRepositoryStatus(indexed?.status);
  const details = summary.data?.summary;

  async function openSession() {
    if (!repositoryStatus.ready) return;
    const session = await create.mutateAsync({ owner, repo, title: `${repo} exploration` });
    router.push(`/chat/${session.id}`);
  }

  if (repositories.isLoading || summary.isLoading) return <RepositoryWorkspaceSkeleton />;
  if (repositories.isError) return <div className="layout-standard layout-gutter py-10"><ErrorState error={repositories.error} retry={() => void repositories.refetch()} /></div>;

  const explorerCategories = isExplorerTab(activeTab) ? extractRepositoryExplorerCategories(activeTab, details) : [];
  const selectedExplorerCategory = normalizeRepositoryExplorerCategory(explorerCategories, searchParams.get("category"));
  const selectedExplorerItem = findRepositoryExplorerItem(selectedExplorerCategory, searchParams.get("item"));
  const repositorySessions = sessions.data?.sessions.filter((session) => session.owner === owner && session.repo === repo) ?? [];
  const tabs = REPOSITORY_TAB_IDS.map((id) => ({ id, label: id[0]?.toUpperCase() + id.slice(1), panelId: `repository-${id}-panel` }));

  function selectTab(tab: string) {
    const nextSearchParams = new URLSearchParams(searchParams.toString());
    nextSearchParams.set("tab", repositoryTab(tab));
    nextSearchParams.delete("category");
    nextSearchParams.delete("item");
    router.push(
      `/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}?${nextSearchParams.toString()}`,
      { scroll: false },
    );
  }

  function selectExplorerItem(item: RepositoryExplorerItem) {
    const nextSearchParams = new URLSearchParams(searchParams.toString());
    nextSearchParams.set("tab", activeTab);
    nextSearchParams.set("category", item.category);
    nextSearchParams.set("item", item.key);
    router.push(
      `/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}?${nextSearchParams.toString()}`,
      { scroll: false },
    );
  }

  return (
    <div className="layout-standard layout-gutter py-10 max-[820px]:py-8">
      <header className="grid gap-6 border-b border-border-subtle pb-7 laptop:grid-cols-[minmax(0,1fr)_auto] laptop:items-end">
        <div className="min-w-0">
          <p className="type-section-eyebrow text-muted-foreground">{owner}</p>
          <h1 aria-label={repo} className="mt-2 break-words type-page-title"><span className="type-page-title-accent">{repo}</span><span className="not-italic text-foreground">.</span></h1>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <RepositoryStatusBadge status={indexed?.status} />
            {details?.repositoryVersion ? <span className="type-metadata text-muted-foreground">VERSION {details.repositoryVersion}</span> : null}
            {indexed?.lastIndexedAt ? <span className="type-metadata text-muted-foreground">INDEXED {formatDate(indexed.lastIndexedAt)}</span> : null}
          </div>
          {activeTab !== "summary" && details?.purpose ? <p className="mt-4 max-w-[68ch] type-body text-text-secondary">{details.purpose}</p> : null}
        </div>
        <Button variant="accent" className="justify-self-start max-[820px]:w-full laptop:justify-self-end" onClick={() => void openSession()} disabled={create.isPending || !repositoryStatus.ready}>{create.isPending ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" /> : <Play className="size-4" />}{create.isPending ? "Creating…" : "Open session"}</Button>
      </header>

      {!repositoryStatus.ready ? <InlineAlert tone={repositoryStatus.label === "Failed" ? "danger" : "warning"} className="mt-4"><div className="flex flex-wrap items-center gap-3"><div className="min-w-0 flex-1"><p className="type-compact-strong">{repositoryStatus.label} repository</p><p className="mt-1">{repositoryStatus.label === "Failed" ? "Indexing failed. Retry the repository connection before starting a session." : repositoryStatus.label === "Stale" ? "Repository evidence is stale. Reindex before starting a new session." : "Repository intelligence must be ready before starting a session."}</p></div><Button variant="secondary" size="sm" onClick={() => router.push(indexed?.status === "failed" ? "/repositories/connect" : `/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/indexing`)}>{indexed?.status === "failed" ? "Reconnect repository" : "View indexing"}<ArrowRight className="size-3.5" /></Button></div></InlineAlert> : null}

      {create.isError ? <div className="mt-4"><ErrorState error={create.error} compact /></div> : null}
      {summary.isError ? <div className="mt-4"><ErrorState error={summary.error} retry={() => void summary.refetch()} compact /></div> : null}

      <div className="mt-6"><Tabs label="Repository sections" items={tabs} value={activeTab} onValueChange={selectTab} /></div>

      <div id={`repository-${activeTab}-panel`} role="tabpanel" className="mt-8">
        {activeTab === "summary" ? <RepositorySummaryOverview owner={owner} repo={repo} summary={details} repository={indexed} workspace={workspace.data} workspaceLoading={workspace.isLoading} workspaceUnavailable={workspace.isError} onAsk={() => void openSession()} /> : null}

        {activeTab === "architecture" ? <ExplorerTab tab="architecture" title="Architecture summary" description="Languages, frameworks, entry points, and repository surfaces exposed by indexing." empty="No architecture summary is available." categories={explorerCategories} selectedItem={selectedExplorerItem} onSelect={selectExplorerItem} onAsk={repositoryStatus.ready ? (item) => setAskTarget({ kind: "repository-item", item, location: { kind: "explorer", tab: "architecture" } }) : undefined} /> : null}

        {activeTab === "files" ? <ExplorerTab tab="files" title="Important files and directories" description="A curated summary of important directories and configuration files. It does not represent every repository path." empty="No important files were detected." categories={explorerCategories} selectedItem={selectedExplorerItem} onSelect={selectExplorerItem} onAsk={repositoryStatus.ready ? (item) => setAskTarget({ kind: "repository-item", item, location: { kind: "explorer", tab: "files" } }) : undefined} /> : null}

        {activeTab === "symbols" ? <ExplorerTab tab="symbols" title="Exported symbols" description="Modules and API surfaces exposed by the repository summary." empty="No exported symbols were detected." categories={explorerCategories} selectedItem={selectedExplorerItem} onSelect={selectExplorerItem} onAsk={repositoryStatus.ready ? (item) => setAskTarget({ kind: "repository-item", item, location: { kind: "explorer", tab: "symbols" } }) : undefined} /> : null}

        {activeTab === "dependencies" ? <ExplorerTab tab="dependencies" title="Dependency summary" description="Central modules, dependency hotspots, and detected cycles exposed by indexing." empty="No dependency summary is available." categories={explorerCategories} selectedItem={selectedExplorerItem} onSelect={selectExplorerItem} onAsk={repositoryStatus.ready ? (item) => setAskTarget({ kind: "repository-item", item, location: { kind: "explorer", tab: "dependencies" } }) : undefined} /> : null}

        {activeTab === "sessions" ? <section aria-label="Repository sessions" className="layout-editorial ml-0"><div className="divide-y divide-border-subtle border-y border-border-subtle">{sessions.isError ? <div className="p-3"><ErrorState error={sessions.error} retry={() => void sessions.refetch()} compact /></div> : null}{sessions.isLoading ? <div className="space-y-3 p-3"><Skeleton className="h-10" /><Skeleton className="h-10" /></div> : null}{repositorySessions.map((session) => <Link key={session.id} href={`/chat/${session.id}`} className="flex min-h-10 items-center gap-3 px-3 py-2 hover:bg-hover focus-ring"><MessageSquare className="size-3.5 text-muted-foreground" /><span className="min-w-0 flex-1 truncate type-compact-strong">{session.title}</span><span className="type-metadata text-muted-foreground">{session.messageCount} messages</span></Link>)}</div>{!sessions.isLoading && !sessions.isError && repositorySessions.length === 0 ? <EmptyState icon={MessageSquare} title="No repository sessions" description="Start a session from the primary action when repository intelligence is ready." /> : null}</section> : null}

        {activeTab === "settings" ? <EmptyState icon={Settings} title="No repository settings exposed" description="The current backend does not expose repository-specific settings." /> : null}
      </div>
      {askTarget ? <AskGiroDialog open owner={owner} repo={repo} target={askTarget} onClose={() => setAskTarget(null)} /> : null}
    </div>
  );
}

function ExplorerTab({ title, description, empty, categories, selectedItem, onSelect, onAsk }: { tab: RepositoryExplorerTab; title: string; description: string; empty: string; categories: ReturnType<typeof extractRepositoryExplorerCategories>; selectedItem: RepositoryExplorerItem | undefined; onSelect(item: RepositoryExplorerItem): void; onAsk?: (item: RepositoryExplorerItem) => void }) {
  if (!selectedItem) return <section aria-labelledby="repository-explorer-empty-heading"><p className="type-section-eyebrow text-muted-foreground">Repository explorer</p><h2 id="repository-explorer-empty-heading" className="mt-2 type-section-title">{title}</h2><p className="mt-2 max-w-[68ch] type-compact text-text-secondary">{description}</p><div className="mt-5 border-y border-border-subtle"><EmptyState icon={FileCode2} title="No indexed surfaces yet" description={empty} /></div></section>;
  return <section aria-labelledby={`repository-${selectedItem.category}-heading`}><p className="type-section-eyebrow text-muted-foreground">Repository explorer</p><h2 id={`repository-${selectedItem.category}-heading`} className="mt-2 type-section-title">{title}</h2><p className="mt-2 max-w-[68ch] type-compact text-text-secondary">{description}</p><div className="mt-5 grid gap-7 laptop:grid-cols-[minmax(0,1fr)_320px]"><RepositoryExplorerList categories={categories} selectedKey={selectedItem.key} onSelect={onSelect} label={title} /><aside className="min-w-0 space-y-3"><RepositoryExplorerDetail item={selectedItem} />{onAsk ? <Button variant="secondary" className="w-full" onClick={() => onAsk(selectedItem)}><MessageSquare className="size-4" />Ask Giro about this</Button> : null}</aside></div></section>;
}

function RepositoryWorkspaceSkeleton() {
  return <div role="status" aria-label="Loading repository workspace" className="layout-standard layout-gutter py-10 max-[820px]:py-8"><div className="grid gap-6 border-b border-border-subtle pb-7 laptop:grid-cols-[minmax(0,1fr)_auto] laptop:items-end"><div><Skeleton className="h-3 w-24" /><Skeleton className="mt-3 h-12 w-64 max-w-full" /><div className="mt-4 flex gap-3"><Skeleton className="h-5 w-16" /><Skeleton className="h-4 w-28" /></div></div><Skeleton className="h-9 w-32 max-[820px]:w-full" /></div><Skeleton className="mt-6 h-10 w-full" /><div className="mt-8 grid items-start gap-10 laptop:grid-cols-[minmax(0,1fr)_320px] laptop:gap-12"><div className="space-y-8"><div><Skeleton className="h-3 w-32" /><Skeleton className="mt-3 h-6 w-48" /><Skeleton className="mt-4 h-16 w-full" /></div><div><Skeleton className="h-3 w-28" /><Skeleton className="mt-3 h-6 w-40" /><Skeleton className="mt-4 h-28 w-full" /></div></div><div className="border-t border-border-subtle pt-8 laptop:border-l laptop:border-t-0 laptop:pl-8 laptop:pt-0"><Skeleton className="h-3 w-24" /><Skeleton className="mt-3 h-6 w-44" /><Skeleton className="mt-4 h-56 w-full" /></div></div></div>;
}
