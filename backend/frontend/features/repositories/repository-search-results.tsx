"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { FileCode2, MessageSquare, SearchX, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/card";
import { ListRow } from "@/components/ui/data-display";
import { Drawer } from "@/components/ui/drawer";
import { SegmentedControl } from "@/components/ui/tabs";
import type { AskGiroTarget } from "@/features/repositories/ask-giro-dialog";
import { RepositoryExplorerDetail } from "@/features/repositories/repository-explorer-detail";
import { RepositoryExplorerList } from "@/features/repositories/repository-explorer-list";
import { cn } from "@/lib/utils";
import type { RepositoryExplorerCategory, RepositoryExplorerItem } from "@/lib/repository-explorer";
import type { RetrievalResult } from "@/types/api";

export type EvidenceFilter = "all" | "symbol" | "code";
const AskGiroDialog = dynamic(() => import("@/features/repositories/ask-giro-dialog").then((module) => module.AskGiroDialog), { ssr: false });

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
  owner,
  repo,
  query,
  selectedResult,
  filter,
  restoreFocus,
  onSelectIntelligence,
  onSelectEvidence,
  onFilterChange,
  onReturnToSearch,
}: {
  intelligence: RepositoryExplorerCategory[];
  evidence: RetrievalResult[];
  owner: string;
  repo: string;
  query: string;
  selectedResult: string | null;
  filter: EvidenceFilter;
  restoreFocus: boolean;
  onSelectIntelligence(item: RepositoryExplorerItem): void;
  onSelectEvidence(item: RetrievalResult): void;
  onFilterChange(filter: EvidenceFilter): void;
  onReturnToSearch(): void;
}) {
  const [askTarget, setAskTarget] = useState<AskGiroTarget | null>(null);
  const [narrow, setNarrow] = useState(false);
  const [mobileSelection, setMobileSelection] = useState<{ kind: "intelligence"; item: RepositoryExplorerItem } | { kind: "evidence"; item: RetrievalResult } | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const restoreFocusPending = useRef(false);
  const intelligenceItems = intelligence.flatMap((category) => category.items);
  const selectedIntelligence = intelligenceItems.find((item) => repositoryIntelligenceResultKey(item) === selectedResult);
  const selectedEvidence = evidence.find((item) => indexedEvidenceResultKey(item) === selectedResult);
  const fallbackIntelligence = intelligenceItems[0];
  const fallbackEvidence = evidence[0];
  const effectiveIntelligence = selectedIntelligence ?? (!selectedEvidence ? fallbackIntelligence : undefined);
  const effectiveEvidence = selectedEvidence ?? (!effectiveIntelligence ? fallbackEvidence : undefined);
  const noResults = intelligenceItems.length === 0 && evidence.length === 0;

  useEffect(() => {
    const query = window.matchMedia("(max-width: 1080px)");
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (mobileSelection || !restoreFocusPending.current) return;
    restoreFocusPending.current = false;
    returnFocusRef.current?.focus();
  }, [mobileSelection]);

  function rememberSelectionTarget() {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }

  function selectIntelligence(item: RepositoryExplorerItem) {
    rememberSelectionTarget();
    onSelectIntelligence(item);
    if (narrow) setMobileSelection({ kind: "intelligence", item });
  }

  function selectEvidence(item: RetrievalResult) {
    rememberSelectionTarget();
    onSelectEvidence(item);
    if (narrow) setMobileSelection({ kind: "evidence", item });
  }

  function closeMobileDetail() {
    if (!mobileSelection) return;
    restoreFocusPending.current = true;
    setMobileSelection(null);
  }

  function askAboutEvidence(item: RetrievalResult) {
    setMobileSelection(null);
    setAskTarget({ kind: "indexed-evidence", result: item, query, resultKey: indexedEvidenceResultKey(item) });
  }

  function askAboutIntelligence(item: RepositoryExplorerItem) {
    setMobileSelection(null);
    setAskTarget({ kind: "repository-item", item, location: { kind: "search", query, resultKey: repositoryIntelligenceResultKey(item) } });
  }

  if (noResults) {
    return <section aria-labelledby="no-search-results-heading" className="max-w-[760px] border-y border-border-subtle py-8"><div className="flex items-start gap-4"><SearchX className="mt-1 size-5 shrink-0 text-muted-foreground" /><div><p role="status" aria-live="polite" className="type-metadata-label text-muted-foreground">No matches for “{query}”</p><h2 id="no-search-results-heading" className="mt-2 type-section-title">Refine the search, not the repository</h2><p className="mt-2 max-w-[58ch] type-compact text-text-secondary">Try simpler terms, a file or symbol name, or a broader engineering concept. Search uses the words in your query to retrieve indexed repository evidence.</p><Button variant="secondary" size="sm" className="mt-5" onClick={onReturnToSearch}><SearchX className="size-3.5" />Return to search field</Button></div></div></section>;
  }

  return (
    <div className="space-y-7">
      <p role="status" aria-live="polite" className="type-metadata text-muted-foreground">{intelligenceItems.length + evidence.length} results for “{query}” · backend ranking preserved</p>
      <div className="grid gap-7 laptop:grid-cols-[minmax(0,1fr)_360px]">
      <div className="min-w-0 space-y-8">
        <section aria-labelledby="repository-intelligence-heading">
          <h2 id="repository-intelligence-heading" className="type-section-title">Repository intelligence</h2>
          <p className="mt-2 type-compact text-text-secondary">Matches from the loaded repository summary.</p>
          <div className="mt-4">
            {intelligence.length > 0 ? <RepositoryExplorerList categories={intelligence} selectedKey={effectiveIntelligence?.key} onSelect={selectIntelligence} label="Repository intelligence results" restoreFocus={restoreFocus && Boolean(effectiveIntelligence)} /> : <p className="border-y border-border-subtle px-3 py-4 type-compact text-muted-foreground">No repository summary items matched this query.</p>}
          </div>
        </section>

        <section aria-labelledby="indexed-evidence-heading">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div><h2 id="indexed-evidence-heading" className="type-section-title">Indexed evidence</h2><p className="mt-2 type-compact text-text-secondary">Grounded excerpts returned in backend ranking order.</p></div>
            <SegmentedControl label="Evidence type" items={[{ id: "all", label: "All" }, { id: "symbol", label: "Symbol Evidence" }, { id: "code", label: "Code Evidence" }]} value={filter} onValueChange={(value) => onFilterChange(normalizeEvidenceFilter(value))} />
          </div>
          <div className="mt-4">
            {evidence.length > 0 ? <EvidenceList items={evidence} selected={effectiveEvidence} restoreFocus={restoreFocus && Boolean(effectiveEvidence)} onSelect={selectEvidence} /> : <p className="border-y border-border-subtle px-3 py-4 type-compact text-muted-foreground">No indexed evidence was returned for this query.</p>}
          </div>
        </section>
      </div>

      <aside aria-label="Selected search result" className="hidden min-w-0 space-y-3 laptop:block">
        {effectiveEvidence ? <><EvidenceDetail result={effectiveEvidence} /><Button variant="secondary" className="w-full" onClick={() => askAboutEvidence(effectiveEvidence)}><MessageSquare className="size-4" />Ask Giro about this evidence</Button></> : effectiveIntelligence ? <><RepositoryExplorerDetail item={effectiveIntelligence} /><Button variant="secondary" className="w-full" onClick={() => askAboutIntelligence(effectiveIntelligence)}><MessageSquare className="size-4" />Ask Giro about this result</Button></> : null}
      </aside>
      </div>
      <Drawer open={narrow && Boolean(mobileSelection)} label="Selected search result" side="right" className="!w-[480px]" onClose={closeMobileDetail}>{mobileSelection ? <div className="flex h-full min-h-0 flex-col"><div className="flex h-[52px] shrink-0 items-center gap-3 border-b border-border-subtle px-4"><div className="min-w-0 flex-1"><p className="type-compact-strong">Selected result</p><p className="truncate type-metadata text-muted-foreground">{mobileSelection.kind === "evidence" ? mobileSelection.item.filePath : mobileSelection.item.name}</p></div><Button variant="ghost" size="icon-sm" aria-label="Close selected result" onClick={closeMobileDetail}><X className="size-4" /></Button></div><div className="min-h-0 flex-1 overflow-y-auto p-4">{mobileSelection.kind === "evidence" ? <div className="space-y-3"><EvidenceDetail result={mobileSelection.item} /><Button variant="secondary" className="w-full" onClick={() => askAboutEvidence(mobileSelection.item)}><MessageSquare className="size-4" />Ask Giro about this evidence</Button></div> : <div className="space-y-3"><RepositoryExplorerDetail item={mobileSelection.item} /><Button variant="secondary" className="w-full" onClick={() => askAboutIntelligence(mobileSelection.item)}><MessageSquare className="size-4" />Ask Giro about this result</Button></div>}</div></div> : null}</Drawer>
      {askTarget ? <AskGiroDialog open owner={owner} repo={repo} target={askTarget} onClose={() => setAskTarget(null)} /> : null}
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
    return <ListRow key={key} selected={isSelected} interactive className="p-0"><button ref={(node) => { buttons.current[index] = node; }} type="button" role="option" aria-selected={isSelected} aria-label={`${item.filePath}, lines ${item.startLine} to ${item.endLine}, score ${item.score.toFixed(3)}`} tabIndex={key === focusKey ? 0 : -1} onClick={(event) => { event.currentTarget.focus(); onSelect(item); }} onKeyDown={(event) => { if (event.key === "ArrowUp") { event.preventDefault(); move(index, "previous"); } if (event.key === "ArrowDown") { event.preventDefault(); move(index, "next"); } if (event.key === "Home") { event.preventDefault(); move(index, "first"); } if (event.key === "End") { event.preventDefault(); move(index, "last"); } }} className="flex min-h-16 min-w-0 w-full items-start gap-3 rounded-control px-3 py-3 text-left focus-ring"><FileCode2 className={cn("mt-0.5 size-3.5 shrink-0 text-muted-foreground", isSelected && "text-primary")} /><span className="min-w-0 flex-1"><span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1"><span className="min-w-0 break-all type-mono-strong" title={item.filePath}>{item.filePath}</span>{item.symbol ? <span className="type-compact-strong text-primary">{item.symbol}</span> : null}</span><span className="mt-1 block type-metadata text-muted-foreground">L{item.startLine}–{item.endLine} · {item.language} · score {item.score.toFixed(3)}</span><span className="mt-2 block line-clamp-3 whitespace-pre-wrap type-mono text-text-secondary">{item.content}</span></span></button></ListRow>;
  })}</div>;
}

function EvidenceDetail({ result }: { result: RetrievalResult }) {
  return <Panel className="border border-border-subtle p-4" aria-label={`${result.filePath} evidence details`}><p className="type-metadata-label text-muted-foreground">Selected evidence</p><h2 className="mt-2 break-all type-mono-strong">{result.filePath}</h2><div className="mt-3 flex flex-wrap gap-2"><Badge>lines {result.startLine}–{result.endLine}</Badge>{result.symbol ? <Badge>{result.symbol}</Badge> : null}<Badge>{result.language}</Badge><Badge>score {result.score.toFixed(3)}</Badge></div><pre className="mt-4 max-h-[60vh] overflow-auto rounded-control bg-code p-4 type-mono text-code-foreground"><code>{result.content}</code></pre></Panel>;
}
