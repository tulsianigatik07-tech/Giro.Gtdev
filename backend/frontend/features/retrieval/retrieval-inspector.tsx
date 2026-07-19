"use client";

import { useEffect, useState } from "react";
import { BarChart3, ChevronDown, Database, ExternalLink, FileCode2, Link2, SearchX, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyControl } from "@/components/ui/copy-control";
import { EmptyState } from "@/components/ui/empty-state";
import { InlineAlert } from "@/components/ui/inline-alert";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { HybridRetrievalResult, RetrievalResult } from "@/types/api";

export function RetrievalInspector({ retrieval, loading, error, selectedPath, onSelectPath, onClose }: { retrieval: HybridRetrievalResult | null; loading: boolean; error: string | null; selectedPath?: string | null; onSelectPath?(path: string): void; onClose?: () => void }) {
  const selected = retrieval?.results.find((result) => result.filePath === selectedPath) ?? retrieval?.results[0];
  const selectedCitation = selected ? retrieval?.citations?.find((item) => item.relativeFilePath === selected.filePath || selected.filePath.endsWith(item.relativeFilePath)) : undefined;
  const [evidenceExpanded, setEvidenceExpanded] = useState(true);
  useEffect(() => setEvidenceExpanded(true), [selected?.filePath]);
  return (
    <aside className="flex h-full min-h-0 w-full flex-col border-l border-border-subtle bg-panel" aria-label="Retrieval inspector">
      <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-border-subtle px-3"><BarChart3 className="size-4 text-primary" /><div className="min-w-0 flex-1"><h2 className="truncate type-panel-title">Retrieval inspector</h2>{retrieval ? <p className="truncate type-metadata text-muted-foreground">{retrieval.repository}</p> : null}</div>{onClose ? <Button variant="ghost" size="icon-sm" aria-label="Close retrieval inspector" onClick={onClose}><X className="size-4" /></Button> : null}</header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? <div className="space-y-2 p-3" role="status" aria-live="polite" aria-label="Loading retrieval evidence"><span className="sr-only">Loading retrieval evidence.</span><Skeleton className="h-10" /><Skeleton className="h-9" /><Skeleton className="h-9" /><Skeleton className="h-32" /></div> : null}
        {error ? <div className="p-3"><InlineAlert tone="warning">The answer can still complete, but retrieval diagnostics were unavailable: {error}</InlineAlert></div> : null}
        {!loading && !error && !retrieval ? <EmptyState icon={SearchX} title="No retrieval run yet" description="Ask a question to inspect ranking signals and retrieved chunks." /> : null}
        {retrieval ? <>
          <section className="border-b border-border-subtle p-3"><p className="type-metadata-label text-muted-foreground">Query</p><p className="mt-2 break-words type-compact text-foreground">{retrieval.query}</p></section>
          <section aria-labelledby="ranking-heading"><div className="flex h-9 items-center justify-between px-3"><h3 id="ranking-heading" className="type-metadata-label text-muted-foreground">Ranking</h3><span className="type-metadata text-muted-foreground">{retrieval.results.length} results</span></div><div className="border-y border-border-subtle">{retrieval.results.map((result, index) => <RankingRow key={`${result.chunkId ?? result.filePath}-${result.startLine}`} result={result} rank={index + 1} selected={selected === result} cited={Boolean(retrieval.citations?.some((item) => item.relativeFilePath === result.filePath || result.filePath.endsWith(item.relativeFilePath)))} onSelect={() => onSelectPath?.(result.filePath)} />)}</div>{retrieval.results.length === 0 ? <EmptyState icon={SearchX} title="No ranked results" description="The retrieval run completed without exposed results." /> : null}</section>
          {selected ? <section className="p-3" aria-labelledby="selected-evidence-heading"><div className="flex items-center justify-between gap-3"><p id="selected-evidence-heading" className="type-metadata-label text-muted-foreground">Selected evidence</p><Button variant="ghost" size="sm" aria-expanded={evidenceExpanded} aria-controls="selected-evidence-detail" onClick={() => setEvidenceExpanded((value) => !value)}>{evidenceExpanded ? "Collapse" : "Expand"}<ChevronDown className={cn("size-3.5 transition-transform duration-[150ms] motion-reduce:transition-none", evidenceExpanded && "rotate-180")} /></Button></div><div className="mt-3"><div className="flex items-start gap-2"><FileCode2 className="mt-0.5 size-3.5 shrink-0 text-primary" /><div className="min-w-0 flex-1"><p className="break-all type-mono-strong">{selected.filePath}</p><p className="mt-1 type-metadata text-muted-foreground">L{selected.startLine}–{selected.endLine} · {selected.language}</p>{selected.symbol ? <p className="mt-1 break-all type-metadata text-muted-foreground">SYMBOL {selected.symbol}</p> : null}</div><div className="flex shrink-0 items-center gap-1"><CopyControl value={`${selected.filePath}:${selected.startLine}-${selected.endLine}`} label={`Copy path ${selected.filePath}`} /><Button variant="ghost" size="icon-sm" aria-label="Source link unavailable" disabled title="Source links are not exposed by the backend"><ExternalLink className="size-3.5" /></Button></div></div>{evidenceExpanded ? <div id="selected-evidence-detail"><div className="mt-4 border-y border-border-subtle"><DiagnosticRow label="Retrieval source" value={selected.source} /><DiagnosticRow label="Score" value={selected.score.toFixed(3)} /><SignalRows result={selected} /><DiagnosticRow label="Citation" value={selectedCitation ? `Linked · ${selectedCitation.repositoryVersion}` : "Not linked"} icon={selectedCitation ? Link2 : undefined} /><DiagnosticRow label="Expansion" value="Not exposed" muted /><DiagnosticRow label="Stitching" value="Not exposed" muted /></div>{selected.content.trim() ? <pre className="mt-4 max-h-64 overflow-auto rounded-panel bg-code p-3 type-mono text-code-foreground" aria-label={`Evidence excerpt from ${selected.filePath}`}><code>{selected.content}</code></pre> : <div className="mt-4 rounded-control bg-inset p-3 type-compact text-muted-foreground">Preview not available</div>}</div> : null}</div></section> : null}
        </> : null}
      </div>
      {retrieval ? <footer className="border-t border-border-subtle p-3"><p className="mb-2 type-metadata-label text-muted-foreground">Run summary</p><dl className="divide-y divide-border-subtle"><DiagnosticRow label="Returned" value={String(retrieval.stats.returned)} /><DiagnosticRow label="Semantic" value={String(retrieval.stats.semanticResults)} /><DiagnosticRow label="Keyword" value={String(retrieval.stats.keywordResults)} /><DiagnosticRow label="Symbol" value={String(retrieval.stats.symbolResults)} /><DiagnosticRow label="Graph boosted" value={String(retrieval.stats.graphBoosted)} /><DiagnosticRow label="Token budget" value="Not exposed" muted /></dl></footer> : null}
    </aside>
  );
}

function RankingRow({ result, rank, selected, cited, onSelect }: { result: RetrievalResult; rank: number; selected: boolean; cited: boolean; onSelect(): void }) {
  return <button type="button" onClick={onSelect} aria-pressed={selected} className={cn("relative grid min-h-9 w-full grid-cols-[24px_minmax(0,1fr)_auto_auto_auto] items-center gap-2 border-b border-border-subtle px-3 text-left last:border-b-0 hover:bg-hover focus-ring", selected && "bg-selection before:absolute before:bottom-1 before:left-0 before:top-1 before:w-0.5 before:bg-primary")}><span className={cn("type-metadata text-muted-foreground", rank === 1 && "text-primary")}>{rank}</span><span className="min-w-0"><span className="block truncate type-mono">{result.filePath}</span>{result.symbol ? <span className="block truncate type-metadata text-muted-foreground">{result.symbol}</span> : null}</span><span className="type-metadata text-muted-foreground">L{result.startLine}–{result.endLine}</span><span className="type-metadata text-muted-foreground">{result.source}{cited ? " · cited" : ""}</span><span className="type-metadata tabular-nums text-foreground">{result.score.toFixed(3)}</span></button>;
}

function SignalRows({ result }: { result: RetrievalResult }) {
  const signals = [["Semantic", result.signals.semantic], ["Keyword", result.signals.keyword], ["Symbol", result.signals.symbol], ["Graph", result.signals.graph]] as const;
  return <>{signals.filter(([, value]) => value !== undefined).map(([label, value]) => <DiagnosticRow key={label} label={label} value={value?.toFixed(2) ?? ""} icon={Database} />)}</>;
}

function DiagnosticRow({ label, value, muted = false, icon: Icon }: { label: string; value: string; muted?: boolean; icon?: typeof Database }) {
  return <div className="flex min-h-9 items-center gap-2 py-2 type-compact"><dt className="text-muted-foreground">{label}</dt><dd className={cn("ml-auto flex items-center gap-1 text-right type-metadata text-foreground", muted && "text-muted-foreground")}>{Icon ? <Icon className="size-3" /> : null}{value}</dd></div>;
}
