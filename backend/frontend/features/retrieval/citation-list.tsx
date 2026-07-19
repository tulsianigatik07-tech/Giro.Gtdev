"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ExternalLink, FileCode2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyControl } from "@/components/ui/copy-control";
import { Drawer } from "@/components/ui/drawer";
import { cn } from "@/lib/utils";
import type { GroundedCitation, SelectedContextChunk } from "@/types/api";

function citationPreview(citation: GroundedCitation, context: SelectedContextChunk[]): string | undefined {
  return context.find((chunk) => chunk.filePath.endsWith(citation.relativeFilePath) && chunk.startLine <= citation.endLine && chunk.endLine >= citation.startLine)?.content;
}

export function CitationList({ citations, context = [], selectedPath, onSelectPath }: { citations: GroundedCitation[]; context?: SelectedContextChunk[]; selectedPath?: string | null; onSelectPath?(path: string): void }) {
  if (citations.length === 0) return <p className="type-compact text-muted-foreground">No citations were attached to this answer.</p>;
  return <div className="overflow-hidden rounded-panel border border-border-subtle">{citations.map((citation, index) => <CitationItem key={`${citation.chunkId}-${citation.startLine}`} citation={citation} index={index + 1} preview={citationPreview(citation, context)} selected={selectedPath === citation.relativeFilePath} onSelect={() => onSelectPath?.(citation.relativeFilePath)} />)}</div>;
}

function CitationItem({ citation, index, preview, selected, onSelect }: { citation: GroundedCitation; index: number; preview?: string; selected: boolean; onSelect(): void }) {
  const [open, setOpen] = useState(false);
  const [mobile, setMobile] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const lines = citation.startLine === citation.endLine ? `:${citation.startLine}` : `:${citation.startLine}-${citation.endLine}`;
  useEffect(() => {
    const query = window.matchMedia?.("(max-width: 820px)");
    if (!query) return;
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  function toggle() { setOpen((value) => !value); onSelect(); }
  function closeMobileCitation() {
    setOpen(false);
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  }
  return (
    <article className={cn("relative border-b border-border-subtle last:border-b-0", (open || selected) && "bg-selection before:absolute before:bottom-2 before:left-0 before:top-2 before:w-0.5 before:bg-primary")}>
      <div className="flex min-h-10 items-center gap-2 px-3 py-2">
        <button ref={triggerRef} className="flex min-w-0 flex-1 items-center gap-2 rounded-control text-left focus-ring" onClick={toggle} aria-expanded={open} aria-label={`${index} ${citation.relativeFilePath}, lines ${citation.startLine} to ${citation.endLine}`}>
          <span className={cn("w-6 shrink-0 text-right type-metadata", index === 1 ? "text-primary" : "text-muted-foreground")}>{index}</span>
          <FileCode2 className={cn("size-3.5 shrink-0 text-muted-foreground", selected && "text-primary")} />
          <span className="min-w-0 flex-1"><span className="block truncate type-mono-strong">{citation.relativeFilePath}</span><span className="mt-0.5 block type-metadata text-muted-foreground">L{citation.startLine}–{citation.endLine}{citation.symbol ? ` · ${citation.symbol}` : ""}</span></span>
          <span className="type-metadata tabular-nums text-muted-foreground">{citation.score.toFixed(3)}</span>
          <ChevronDown className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-[150ms] motion-reduce:transition-none", open && "rotate-180")} />
        </button>
        <CopyControl value={`${citation.relativeFilePath}${lines}`} label={`Copy path ${citation.relativeFilePath}`} />
        <Button variant="ghost" size="icon-sm" aria-label="Source link unavailable" disabled title="Source links are not exposed by the backend"><ExternalLink className="size-3.5" /></Button>
      </div>
      {open && !mobile ? <div className="border-t border-border-subtle"><CitationDetail citation={citation} preview={preview} /></div> : null}
      <Drawer open={open && mobile} label={`Citation ${index}: ${citation.relativeFilePath}`} side="full" onClose={closeMobileCitation}><div className="flex h-[52px] items-center gap-3 border-b border-border-subtle px-4"><div className="min-w-0 flex-1"><p className="truncate type-mono-strong">{citation.relativeFilePath}</p><p className="type-metadata text-muted-foreground">EVIDENCE {index} · L{citation.startLine}–{citation.endLine}</p></div><Button variant="ghost" size="icon-sm" aria-label="Close citation" onClick={closeMobileCitation}><X className="size-4" /></Button></div><CitationDetail citation={citation} preview={preview} expanded /></Drawer>
    </article>
  );
}

function CitationDetail({ citation, preview, expanded = false }: { citation: GroundedCitation; preview?: string; expanded?: boolean }) {
  return <><div className="flex flex-wrap gap-2 px-4 py-3"><Badge>{citation.language}</Badge><Badge>{citation.retrievalType}</Badge><Badge>score {citation.score.toFixed(3)}</Badge><Badge className="max-w-52 truncate">version {citation.repositoryVersion}</Badge></div>{preview ? <pre className={cn("max-h-64 overflow-auto border-t border-border-subtle bg-code p-4 type-mono text-code-foreground", expanded && "max-h-none")}><code>{preview}</code></pre> : <div className="border-t border-border-subtle bg-inset px-4 py-3 type-compact text-muted-foreground">Preview not available</div>}</>;
}
