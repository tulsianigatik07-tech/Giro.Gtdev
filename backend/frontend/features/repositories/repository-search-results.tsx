"use client";

import { useEffect, useRef } from "react";
import { FileCode2, SearchX } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/card";
import { ListRow } from "@/components/ui/data-display";
import { EmptyState } from "@/components/ui/empty-state";
import { SegmentedControl } from "@/components/ui/tabs";
import { RepositoryExplorerDetail } from "@/features/repositories/repository-explorer-detail";
import { RepositoryExplorerList } from "@/features/repositories/repository-explorer-list";
import { cn } from "@/lib/utils";
import type { RepositoryExplorerCategory, RepositoryExplorerItem } from "@/lib/repository-explorer";
import type { RetrievalResult } from "@/types/api";

export type EvidenceFilter = "all" | "symbol" | "code";

export function normalizeEvidenceFilter(value: string | null): EvidenceFilter {
  return value === "symbol" || value === "code" ? value : "all";
}

export function repositoryIntelligenceResultKey(item: RepositoryExplorerItem): string {
  return `intelligence:${item.key}`;
}

export function indexedEvidenceResultKey(result: RetrievalResult): string {
  return `evidence:${encodeURIComponent(result.chunkId ?? `${result.filePath}:${result.startLine}-${result.endLine}`)}`;
}

export function filterIndexedEvidence(results: readonly RetrievalResult[], filter: EvidenceFilter): RetrievalResult[] {
  if (filter === "symbol") return results.filter((result) => Boolean(result.symbol));
  if (filter === "code") return results.filter((result) => !result.symbol);
  return [...results];
}

export function RepositorySearchResults({
  intelligence,
  evidence,
  selectedResult,
  filter,
  restoreFocus,
  onSelectIntelligence,
  onSelectEvidence,
  onFilterChange,
}: {
  intelligence: RepositoryExplorerCategory[];
  evidence: RetrievalResult[];
  selectedResult: string | null;
  filter: EvidenceFilter;
  restoreFocus: boolean;
  onSelectIntelligence(item: RepositoryExplorerItem): void;
  onSelectEvidence(item: RetrievalResult): void;
  onFilterChange(filter: EvidenceFilter): void;
}) {
  const intelligenceItems = intelligence.flatMap((category) => category.items);
  const selectedIntelligence = intelligenceItems.find((item) => repositoryIntelligenceResultKey(item) === selectedResult);
  const selectedEvidence = evidence.find((item) => indexedEvidenceResultKey(item) === selectedResult);
  const fallbackIntelligence = intelligenceItems[0];
  const fallbackEvidence = evidence[0];
  const effectiveIntelligence = selectedIntelligence ?? (!selectedEvidence ? fallbackIntelligence : undefined);
  const effectiveEvidence = selectedEvidence ?? (!effectiveIntelligence ? fallbackEvidence : undefined);
  const noResults = intelligenceItems.length === 0 && evidence.length === 0;

  return (
    <div className="space-y-7">
      {noResults ? <EmptyState icon={SearchX} title="No repository results" description="No repository intelligence or indexed evidence matched this query." /> : null}
      <div className="grid gap-7 laptop:grid-cols-[minmax(0,1fr)_360px]">
      <div className="min-w-0 space-y-8">
        <section aria-labelledby="repository-intelligence-heading">
          <h2 id="repository-intelligence-heading" className="type-section-title">Repository Intelligence</h2>
          <p className="mt-2 type-compact text-text-secondary">Matches from the loaded repository summary.</p>
          <div className="mt-4">
            {intelligence.length > 0 ? <RepositoryExplorerList categories={intelligence} selectedKey={effectiveIntelligence?.key} onSelect={onSelectIntelligence} label="Repository Intelligence results" restoreFocus={restoreFocus && Boolean(effectiveIntelligence)} /> : <p className="border-y border-border-subtle px-3 py-4 type-compact text-muted-foreground">No repository summary items matched this query.</p>}
          </div>
        </section>

        <section aria-labelledby="indexed-evidence-heading">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div><h2 id="indexed-evidence-heading" className="type-section-title">Indexed Evidence</h2><p className="mt-2 type-compact text-text-secondary">Grounded excerpts returned by repository retrieval.</p></div>
            <SegmentedControl label="Evidence type" items={[{ id: "all", label: "All" }, { id: "symbol", label: "Symbol Evidence" }, { id: "code", label: "Code Evidence" }]} value={filter} onValueChange={(value) => onFilterChange(normalizeEvidenceFilter(value))} />
          </div>
          <div className="mt-4">
            {evidence.length > 0 ? <EvidenceList items={evidence} selected={effectiveEvidence} restoreFocus={restoreFocus && Boolean(effectiveEvidence)} onSelect={onSelectEvidence} /> : <p className="border-y border-border-subtle px-3 py-4 type-compact text-muted-foreground">No indexed evidence was returned for this query.</p>}
          </div>
        </section>
      </div>

      <aside className="min-w-0">
        {effectiveEvidence ? <EvidenceDetail result={effectiveEvidence} /> : effectiveIntelligence ? <RepositoryExplorerDetail item={effectiveIntelligence} /> : null}
      </aside>
      </div>
    </div>
  );
}

function EvidenceList({ items, selected, restoreFocus, onSelect }: { items: RetrievalResult[]; selected?: RetrievalResult; restoreFocus: boolean; onSelect(item: RetrievalResult): void }) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedKey = selected ? indexedEvidenceResultKey(selected) : undefined;
  const focusKey = selectedKey ?? (items[0] ? indexedEvidenceResultKey(items[0]) : undefined);

  useEffect(() => {
    if (!restoreFocus || !selectedKey) return;
    const index = items.findIndex((item) => indexedEvidenceResultKey(item) === selectedKey);
    if (index >= 0) buttons.current[index]?.focus();
  }, [items, restoreFocus, selectedKey]);

  function move(currentIndex: number, destination: "previous" | "next" | "first" | "last") {
    const nextIndex = destination === "first" ? 0 : destination === "last" ? items.length - 1 : destination === "previous" ? Math.max(0, currentIndex - 1) : Math.min(items.length - 1, currentIndex + 1);
    const next = items[nextIndex];
    if (!next) return;
    onSelect(next);
    buttons.current[nextIndex]?.focus();
  }

  return <div role="listbox" aria-label="Indexed Evidence results" className="border-y border-border-subtle">{items.map((item, index) => {
    const key = indexedEvidenceResultKey(item);
    const isSelected = key === selectedKey;
    return <ListRow key={key} selected={isSelected} interactive className="p-0"><button ref={(node) => { buttons.current[index] = node; }} type="button" role="option" aria-selected={isSelected} aria-label={`${item.filePath}, lines ${item.startLine} to ${item.endLine}, score ${item.score.toFixed(3)}`} tabIndex={key === focusKey ? 0 : -1} onClick={() => onSelect(item)} onKeyDown={(event) => { if (event.key === "ArrowUp") { event.preventDefault(); move(index, "previous"); } if (event.key === "ArrowDown") { event.preventDefault(); move(index, "next"); } if (event.key === "Home") { event.preventDefault(); move(index, "first"); } if (event.key === "End") { event.preventDefault(); move(index, "last"); } }} className="flex min-h-12 min-w-0 w-full items-start gap-3 rounded-control px-3 py-2 text-left focus-ring"><FileCode2 className={cn("mt-0.5 size-3.5 shrink-0 text-muted-foreground", isSelected && "text-primary")} /><span className="min-w-0 flex-1"><span className="block truncate type-mono-strong" title={item.filePath}>{item.filePath}</span><span className="mt-1 block type-metadata text-muted-foreground">L{item.startLine}–{item.endLine} · {item.language}{item.symbol ? ` · ${item.symbol}` : ""}</span><span className="mt-1 block line-clamp-2 whitespace-pre-wrap type-mono text-text-secondary">{item.content}</span></span><span className="shrink-0 type-metadata tabular-nums text-muted-foreground">{item.score.toFixed(3)}</span></button></ListRow>;
  })}</div>;
}

function EvidenceDetail({ result }: { result: RetrievalResult }) {
  return <Panel className="border border-border-subtle p-4" aria-label={`${result.filePath} evidence details`}><p className="type-metadata-label text-muted-foreground">Selected evidence</p><h2 className="mt-2 break-all type-mono-strong">{result.filePath}</h2><div className="mt-3 flex flex-wrap gap-2"><Badge>{result.language}</Badge>{result.symbol ? <Badge>{result.symbol}</Badge> : null}<Badge>score {result.score.toFixed(3)}</Badge><Badge>lines {result.startLine}–{result.endLine}</Badge></div><pre className="mt-4 max-h-96 overflow-auto rounded-control bg-code p-4 type-mono text-code-foreground"><code>{result.content}</code></pre></Panel>;
}
