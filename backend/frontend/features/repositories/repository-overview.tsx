"use client";

import { useRouter } from "next/navigation";
import { Activity, ArrowRight, Boxes, Braces, FileCode2, GitFork, LoaderCircle, Network, Play, Route } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useRepositories, useRepository } from "@/hooks/use-repositories";
import { useCreateSession } from "@/hooks/use-sessions";
import { formatDate } from "@/lib/utils";

export function RepositoryOverview({ owner, repo }: { owner: string; repo: string }) {
  const router = useRouter();
  const summary = useRepository(owner, repo);
  const repositories = useRepositories();
  const create = useCreateSession();
  const indexed = repositories.data?.repositories.find((item) => item.owner === owner && item.repo === repo);

  async function openSession() {
    const session = await create.mutateAsync({ owner, repo, title: `${repo} exploration` });
    router.push(`/chat/${session.id}`);
  }

  if (repositories.isLoading || summary.isLoading) return <div className="mx-auto max-w-6xl space-y-4 p-6"><Skeleton className="h-24" /><Skeleton className="h-32" /><Skeleton className="h-56" /></div>;
  if (repositories.isError) return <div className="mx-auto max-w-6xl p-6"><ErrorState error={repositories.error} retry={() => void repositories.refetch()} /></div>;
  const details = summary.data?.summary;

  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6 lg:p-8">
      <div className="flex flex-col gap-5 border-b border-border pb-7 sm:flex-row sm:items-end sm:justify-between"><div><div className="flex items-center gap-2"><span className="text-sm text-muted-foreground">{owner}</span><span className="text-muted-foreground">/</span><h1 className="font-display text-4xl italic tracking-tight">{repo}</h1><Badge className="border-primary/30 bg-primary/10 text-primary">{indexed?.status ?? "Unknown"}</Badge></div><p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">{details?.purpose ?? "Repository summary metadata is not available for this index version yet."}</p></div><Button onClick={() => void openSession()} disabled={create.isPending}>{create.isPending ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" /> : <Play className="size-4" />}{create.isPending ? "Creating…" : "Open session"}</Button></div>
      {create.isError ? <div className="mt-4"><ErrorState error={create.error} compact /></div> : null}
      {summary.isError ? <div className="mt-4"><ErrorState error={summary.error} retry={() => void summary.refetch()} compact /></div> : null}
      <section className="mt-7 grid gap-3 sm:grid-cols-2 lg:grid-cols-5" aria-label="Repository metrics">{[
        { icon: FileCode2, label: "Files", value: indexed?.fileCount ?? 0 }, { icon: Boxes, label: "Chunks", value: indexed?.chunkCount ?? 0 }, { icon: Braces, label: "Symbols", value: indexed?.symbolCount ?? 0 }, { icon: Network, label: "Graph nodes", value: indexed?.graphNodeCount ?? 0 }, { icon: GitFork, label: "Graph edges", value: indexed?.graphEdgeCount ?? 0 },
      ].map(({ icon: Icon, label, value }) => <Card key={label} className="p-4"><Icon className="size-3.5 text-muted-foreground" /><p className="mt-5 font-mono text-xl">{value.toLocaleString()}</p><p className="mt-1 text-xs text-muted-foreground">{label}</p></Card>)}</section>
      <div className="mt-8 grid gap-6 lg:grid-cols-[1.45fr_0.75fr]">
        <div className="space-y-6">
          <OverviewSection title="Repository intelligence" subtitle="Indexed metadata used by retrieval"><div className="grid gap-5 sm:grid-cols-2"><ItemList icon={Braces} title="Languages" items={names(details?.languages)} /><ItemList icon={Boxes} title="Frameworks" items={names(details?.frameworks)} /><ItemList icon={Boxes} title="Package managers" items={names(details?.packageManagers)} /><ItemList icon={Route} title="API surface" items={names(details?.apiSurface)} /><ItemList icon={Network} title="Central modules" items={details?.dependencyOverview?.centralModules ?? []} /><ItemList icon={Boxes} title="Important directories" items={paths(details?.importantDirectories)} /></div></OverviewSection>
          <OverviewSection title="Entry points" subtitle="Likely starting points discovered during indexing"><div className="space-y-2">{details?.entrypoints?.length ? details.entrypoints.slice(0, 8).map((item) => <div key={`${item.name}-${item.path ?? ""}`} className="flex items-center gap-3 rounded-md border border-border bg-background/25 px-3 py-2.5"><ArrowRight className="size-3.5 text-primary" /><span className="min-w-0 flex-1 truncate font-mono text-xs">{item.path ?? item.name}</span>{item.kind ? <Badge className="text-muted-foreground">{item.kind}</Badge> : null}</div>) : <p className="text-sm text-muted-foreground">No entrypoint metadata was exposed.</p>}</div></OverviewSection>
          <OverviewSection title="System surfaces" subtitle="Repository facts exposed by the summary contract"><div className="grid gap-5 sm:grid-cols-2"><ItemList icon={Activity} title="Background workers" items={paths(details?.backgroundWorkers)} /><ItemList icon={Boxes} title="Data stores" items={paths(details?.dataStores)} /><ItemList icon={Braces} title="Authentication" items={paths(details?.authentication)} /><ItemList icon={Network} title="Retrieval" items={paths(details?.retrieval)} /><ItemList icon={Activity} title="Indexing" items={paths(details?.indexing)} /><ItemList icon={Braces} title="Testing" items={paths(details?.testing)} /><ItemList icon={Boxes} title="Build" items={paths(details?.build)} /><ItemList icon={Route} title="Deployment" items={paths(details?.deployment)} /></div></OverviewSection>
        </div>
        <div className="space-y-6"><OverviewSection title="Latest indexing run" subtitle="Current repository metadata"><dl className="space-y-4 text-sm"><Row label="Status" value={indexed?.status ?? "Unknown"} /><Row label="Version" value={details?.repositoryVersion ?? "Not available"} mono /><Row label="Indexed" value={formatDate(indexed?.lastIndexedAt)} /><Row label="Mode" value={indexed?.lastIndexMode ?? "Not available"} /><Row label="Changed files" value={String(indexed?.lastChangedFileCount ?? 0)} /><Row label="Retries" value={String(indexed?.retryCount ?? 0)} /></dl></OverviewSection><OverviewSection title="Ready to explore" subtitle="Start a grounded repository session"><div className="rounded-md border border-primary/15 bg-primary/5 p-4"><Activity className="size-4 text-primary" /><p className="mt-4 text-sm font-medium">Ask about architecture, behavior, or symbols.</p><p className="mt-2 text-xs leading-relaxed text-muted-foreground">Answers preserve citations and confidence from the backend retrieval flow.</p><Button size="sm" className="mt-4" onClick={() => void openSession()}>Create session<ArrowRight className="size-3.5" /></Button></div></OverviewSection></div>
      </div>
    </div>
  );
}

function OverviewSection({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) { return <section><div className="mb-3"><h2 className="text-sm font-medium">{title}</h2><p className="mt-1 text-xs text-muted-foreground">{subtitle}</p></div><Card className="p-5">{children}</Card></section>; }
function ItemList({ icon: Icon, title, items }: { icon: typeof Braces; title: string; items: string[] }) { return <div><div className="flex items-center gap-2 text-xs font-medium text-muted-foreground"><Icon className="size-3.5" />{title}</div><div className="mt-3 flex flex-wrap gap-1.5">{items.length ? items.slice(0, 8).map((item) => <Badge key={item} className="bg-foreground/[0.025] text-muted-foreground">{item}</Badge>) : <span className="text-xs text-muted-foreground">Not detected</span>}</div></div>; }
function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) { return <div className="flex items-start justify-between gap-4"><dt className="text-muted-foreground">{label}</dt><dd className={`max-w-[60%] truncate text-right ${mono ? "font-mono text-xs" : ""}`}>{value}</dd></div>; }
function names(items: Array<{ name: string }> | undefined): string[] { return items?.map((item) => item.name) ?? []; }
function paths(items: Array<{ name: string; path?: string }> | undefined): string[] { return items?.map((item) => item.path ?? item.name) ?? []; }
