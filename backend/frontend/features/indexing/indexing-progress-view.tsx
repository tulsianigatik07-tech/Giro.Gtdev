"use client";

import { useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Eye, MessageSquare, Play, RefreshCcw, Search, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/error-state";
import { InlineAlert } from "@/components/ui/inline-alert";
import { Progress } from "@/components/ui/progress";
import { StatusBadge } from "@/components/ui/status-badge";
import { Timeline, TimelineItem } from "@/components/ui/timeline";
import { clamp } from "@/lib/utils";
import { useIndexingProgress } from "@/hooks/use-indexing-progress";
import type { IndexingStage } from "@/types/api";

const stages: Array<{ id: IndexingStage; label: string }> = [
  { id: "queued", label: "Queue indexing job" }, { id: "cloning", label: "Clone repository" }, { id: "parsing", label: "Read repository structure" },
  { id: "chunking", label: "Build searchable chunks" }, { id: "embedding", label: "Generate embedding context" }, { id: "uploading_vectors", label: "Store vector context" },
  { id: "finalizing", label: "Finalize repository index" }, { id: "completed", label: "Repository ready" },
];

export function IndexingProgressView({ owner, repo, jobId }: { owner: string; repo: string; jobId?: string }) {
  const router = useRouter();
  const { progress, connected, disconnected, reconnecting, streamError, retry } = useIndexingProgress(`${owner}/${repo}`);
  const current = progress?.stage ?? "queued";
  const failed = current === "failed";
  const ready = current === "completed";
  const lastStage = useRef<IndexingStage>("queued");
  if (!failed) lastStage.current = current;
  const timelineStage = failed ? lastStage.current : current;
  const currentIndex = stages.findIndex((stage) => stage.id === timelineStage);
  const connectionLabel = connected ? "Live" : reconnecting ? "Reconnecting" : disconnected ? "Disconnected" : "Connecting";
  const connectionTone = connected ? "success" : reconnecting ? "warning" : disconnected ? "danger" : "info";
  const announcedStage = failed ? "Failed" : stages.find((stage) => stage.id === current)?.label ?? current;

  const repositoryPath = `/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  return (
    <div className="layout-editorial layout-gutter py-10 max-[820px]:py-8">
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{ready ? `Repository ready. ${owner}/${repo} indexing completed.` : `Indexing ${announcedStage}, ${Math.round(clamp(progress?.percentage ?? 0))} percent. ${progress?.message ?? "Indexing job queued."}`}</p>
      <div className="flex flex-wrap items-center gap-2"><StatusBadge label={connectionLabel} tone={connectionTone} />{disconnected ? <span className="flex items-center gap-1.5 type-compact text-warning"><WifiOff className="size-3.5" />{reconnecting ? "Reconnecting automatically" : "Progress stream disconnected"}</span> : null}</div>
      <h1
        aria-label={ready ? "Repository ready" : `Indexing ${owner}/${repo}`}
        className="mt-5 break-words type-page-title"
      >{ready ? "Repository " : "Indexing "}<span className="italic text-primary">{ready ? "ready" : `${owner}/${repo}`}</span><span className="not-italic">.</span></h1>
      <p className="mt-2 type-body text-text-secondary">{ready ? `${owner}/${repo} is indexed and available for repository-scoped exploration.` : "Building repository intelligence from backend stage updates. You can safely leave this screen and return."}</p>
      <Panel className="mt-7 overflow-hidden border border-border-subtle p-0">
        <div className="border-b border-border-subtle p-6"><div className="flex items-end justify-between gap-4"><div><p className="type-body-strong">{ready ? "Repository index is ready" : failed ? "Indexing failed" : progress?.message ?? "Indexing job queued."}</p><p className="mt-1 type-metadata text-muted-foreground">JOB {jobId ?? progress?.jobId ?? "PENDING"}</p>{progress?.timestamp ? <p className="mt-1 type-metadata text-muted-foreground">UPDATED {new Date(progress.timestamp).toLocaleTimeString()}</p> : null}</div><span className="type-mono-strong tabular-nums">{Math.round(clamp(progress?.percentage ?? 0))}%</span></div><Progress className="mt-4" value={progress?.percentage ?? 0} tone={failed ? "danger" : ready ? "success" : "info"} /></div>
        <div className="p-6"><Timeline label="Indexing stages">
          {stages.map((stage, index) => {
            const complete = current === "completed" || index < currentIndex;
            const active = index === currentIndex && !failed;
            const stageFailed = failed && index === currentIndex;
            return <TimelineItem key={stage.id} state={stageFailed ? "failed" : complete ? "complete" : active ? "active" : "pending"} title={stage.label} metadata={stageFailed ? "Failed" : complete ? "Complete" : active ? "In progress" : "Pending"} />;
          })}
        </Timeline></div>
      </Panel>
      {streamError && !reconnecting && !failed ? <div className="mt-4"><ErrorState error={streamError} retry={retry} compact /></div> : null}
      {failed ? <InlineAlert tone="danger" className="mt-4"><div className="flex flex-wrap items-center gap-3"><div className="min-w-0 flex-1"><p className="type-compact-strong text-danger">{progress?.message ?? "Indexing could not be completed."}</p><p className="mt-1">Return to repository connection to retry through the supported workflow.</p></div><Button variant="secondary" size="sm" onClick={() => router.push("/repositories/connect")}><RefreshCcw className="size-3.5" />Retry</Button></div></InlineAlert> : null}
      {ready ? <section aria-labelledby="repository-ready-actions" className="mt-8"><p className="type-section-eyebrow text-muted-foreground">Continue with indexed context</p><h2 id="repository-ready-actions" className="mt-2 type-section-title">Repository actions</h2><div className="mt-4 divide-y divide-border-subtle border-y border-border-subtle"><ReadyAction href={repositoryPath} icon={Eye} title="Repository overview" description="Review purpose, technology, structure, and repository health." /><ReadyAction href={`${repositoryPath}/search`} icon={Search} title="Search repository" description="Retrieve ranked repository evidence without generating an answer." /><ReadyAction href={repositoryPath} icon={MessageSquare} title="Ask Giro" description="Open the repository and choose grounded context for a repository-scoped question." /><ReadyAction href={repositoryPath} icon={Play} title="Start a session" description="Use the repository primary action to create a scoped engineering session." /></div></section> : null}
    </div>
  );
}

function ReadyAction({ href, icon: Icon, title, description }: { href: string; icon: typeof Eye; title: string; description: string }) {
  return <Link href={href} className="flex min-h-14 items-center gap-3 px-3 py-3 hover:bg-hover focus-ring"><Icon className="size-4 shrink-0 text-primary" /><span className="min-w-0 flex-1"><span className="block type-compact-strong">{title}</span><span className="mt-0.5 block type-compact text-muted-foreground">{description}</span></span><ArrowRight className="size-3.5 shrink-0 text-muted-foreground" /></Link>;
}
