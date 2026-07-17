"use client";

import { useState } from "react";
import { Check, ChevronDown, Clipboard, ExternalLink, FileCode2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { GroundedCitation, SelectedContextChunk } from "@/types/api";

function citationPreview(citation: GroundedCitation, context: SelectedContextChunk[]): string | undefined {
  return context.find((chunk) =>
    chunk.filePath.endsWith(citation.relativeFilePath) &&
    chunk.startLine <= citation.endLine && chunk.endLine >= citation.startLine,
  )?.content;
}

export function CitationList({ citations, context = [] }: { citations: GroundedCitation[]; context?: SelectedContextChunk[] }) {
  if (citations.length === 0) return <p className="text-xs text-muted-foreground">No citations were attached to this answer.</p>;
  return <div className="space-y-2">{citations.map((citation, index) => <CitationItem key={`${citation.chunkId}-${citation.startLine}`} citation={citation} index={index + 1} preview={citationPreview(citation, context)} />)}</div>;
}

function CitationItem({ citation, index, preview }: { citation: GroundedCitation; index: number; preview?: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  async function copyPath() {
    const lines = citation.startLine === citation.endLine
      ? `:${citation.startLine}`
      : `:${citation.startLine}-${citation.endLine}`;
    await navigator.clipboard.writeText(`${citation.relativeFilePath}${lines}`);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }
  return (
    <div className="overflow-hidden rounded-md border border-border bg-background/25">
      <div className="flex items-center gap-2 p-2.5">
        <button className="flex min-w-0 flex-1 items-center gap-2 rounded text-left focus-ring" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
          <span className="grid size-6 shrink-0 place-items-center rounded bg-foreground/5 font-mono text-[10px] text-muted-foreground">{index}</span>
          <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1"><span className="block truncate font-mono text-xs">{citation.relativeFilePath}</span><span className="mt-0.5 block text-[10px] text-muted-foreground">Lines {citation.startLine}–{citation.endLine}{citation.symbol ? ` · ${citation.symbol}` : ""}</span></span>
          <ChevronDown className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
        </button>
        <Button variant="ghost" size="icon" aria-label={`Copy path ${citation.relativeFilePath}`} onClick={() => void copyPath()}>{copied ? <Check className="size-3.5 text-primary" /> : <Clipboard className="size-3.5" />}</Button>
        <Button variant="ghost" size="icon" aria-label="GitHub link unavailable" disabled title="GitHub source links are not exposed by the backend"><ExternalLink className="size-3.5" /></Button>
      </div>
      {open ? <div className="border-t border-border"><div className="flex flex-wrap gap-1.5 px-3 py-2"><Badge className="text-muted-foreground">{citation.language}</Badge><Badge className="text-muted-foreground">{citation.retrievalType}</Badge><Badge className="text-muted-foreground">score {citation.score.toFixed(3)}</Badge><Badge className="max-w-52 truncate text-muted-foreground">version {citation.repositoryVersion}</Badge></div>{preview ? <pre className="max-h-64 overflow-auto border-t border-border bg-background p-3 font-mono text-[11px] leading-relaxed text-foreground"><code>{preview}</code></pre> : null}</div> : null}
    </div>
  );
}
