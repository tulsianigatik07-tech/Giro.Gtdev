"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Check, Circle, LoaderCircle, RefreshCcw, TriangleAlert, WifiOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/error-state";
import { clamp } from "@/lib/utils";
import { useIndexingProgress } from "@/hooks/use-indexing-progress";
import type { IndexingStage } from "@/types/api";

const stages: Array<{ id: IndexingStage; label: string }> = [
  { id: "queued", label: "Queued" }, { id: "cloning", label: "Cloning" }, { id: "parsing", label: "Parsing" },
  { id: "chunking", label: "Chunking" }, { id: "embedding", label: "Embedding" }, { id: "uploading_vectors", label: "Uploading" },
  { id: "finalizing", label: "Finalizing" }, { id: "completed", label: "Completed" },
];

export function IndexingProgressView({ owner, repo, jobId }: { owner: string; repo: string; jobId?: string }) {
  const router = useRouter();
  const { progress, connected, disconnected, reconnecting, streamError, retry } = useIndexingProgress(`${owner}/${repo}`);
  const current = progress?.stage ?? "queued";
  const currentIndex = stages.findIndex((stage) => stage.id === current);
  const failed = current === "failed";

  useEffect(() => {
    if (current !== "completed") return;
    const timer = window.setTimeout(() => router.replace(`/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`), 900);
    return () => window.clearTimeout(timer);
  }, [current, owner, repo, router]);

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-8 lg:pt-16">
      <div className="flex items-center gap-2"><Badge className={connected ? "border-primary/30 bg-primary/10 text-primary" : "text-muted-foreground"}>{connected ? "Live" : reconnecting ? "Reconnecting" : "Connecting"}</Badge>{disconnected ? <span className="flex items-center gap-1.5 text-xs text-amber-300"><WifiOff className="size-3" />{reconnecting ? "Reconnecting automatically" : "Progress stream disconnected"}</span> : null}</div>
      <h1 className="mt-5 font-display text-5xl italic tracking-tight">Indexing {owner}/{repo}</h1>
      <p className="mt-3 text-sm text-muted-foreground">Building repository intelligence. You can safely leave this screen and return.</p>
      <Card className="mt-8 overflow-hidden">
        <div className="border-b border-border p-5"><div className="flex items-end justify-between"><div><p className="text-sm font-medium">{failed ? "Indexing failed" : progress?.message ?? "Indexing job queued."}</p><p className="mt-1 font-mono text-[10px] text-muted-foreground">JOB {jobId ?? progress?.jobId ?? "PENDING"}</p></div><span className="font-display text-4xl italic tabular-nums">{Math.round(clamp(progress?.percentage ?? 0))}%</span></div><div className="mt-4 h-1.5 overflow-hidden rounded-full bg-foreground/5"><div className={`h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none ${failed ? "bg-red-400" : "bg-primary"}`} style={{ width: `${clamp(progress?.percentage ?? 0)}%` }} /></div></div>
        <ol className="divide-y divide-border p-2" aria-label="Indexing stages">
          {stages.map((stage, index) => {
            const complete = current === "completed" || index < currentIndex;
            const active = index === currentIndex && !failed;
            return <li key={stage.id} className="flex items-center gap-3 rounded-md px-3 py-3"><span className={`grid size-6 place-items-center rounded-full border ${complete ? "border-primary/30 bg-primary/10 text-primary" : active ? "border-primary/30 bg-primary/10 text-primary" : "border-border text-muted-foreground"}`}>{complete ? <Check className="size-3" /> : active ? <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" /> : <Circle className="size-2" />}</span><span className={`text-sm ${active || complete ? "text-foreground" : "text-muted-foreground"}`}>{stage.label}</span>{active ? <span className="ml-auto text-xs text-muted-foreground">In progress</span> : null}</li>;
          })}
        </ol>
      </Card>
      {streamError && !reconnecting && !failed ? <div className="mt-4"><ErrorState error={streamError} retry={retry} compact /></div> : null}
      {failed ? <div role="alert" className="mt-4 flex items-start gap-3 rounded-lg border border-red-500/20 bg-red-500/5 p-4"><TriangleAlert className="mt-0.5 size-4 text-red-300" /><div className="flex-1"><p className="text-sm font-medium text-red-200">{progress?.message ?? "Indexing could not be completed."}</p><p className="mt-1 text-xs text-red-200/70">Return to repository connection to retry through the supported workflow.</p></div><Button variant="secondary" size="sm" onClick={() => router.push("/repositories/connect")}><RefreshCcw className="size-3.5" />Retry</Button></div> : null}
    </div>
  );
}
