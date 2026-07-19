"use client";

import { useEffect, useState } from "react";
import { Braces, FileCode2, Pause, Play, Search, ShieldCheck } from "lucide-react";
import { PLATFORM_PRODUCTS } from "@/components/platform/platform-navigation";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const SHOWCASE_IDS = ["web", "cli", "ide", "mobile"] as const;
type ShowcaseId = (typeof SHOWCASE_IDS)[number];

const webDescription = "Repository summaries, scoped search, sessions, retrieval inspection, and citations in the browser.";

export function PlatformShowcase() {
  const [selected, setSelected] = useState<ShowcaseId>("web");
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!media) return;
    const update = () => setPaused(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const product = PLATFORM_PRODUCTS.find((item) => item.id === selected);
  const description = selected === "web" ? webDescription : product && "description" in product ? product.description : "";

  return (
    <section aria-labelledby="platform-showcase-heading" className="mx-auto w-full max-w-[1280px] px-12 max-[1080px]:px-8 max-[820px]:px-4">
      <div className="overflow-hidden rounded-panel border border-border bg-panel">
        <div className="flex flex-wrap items-end justify-between gap-4 border-b border-border-subtle p-6 max-[820px]:p-4">
          <div>
            <p className="type-section-eyebrow text-muted-foreground">Giro platform</p>
            <h2 id="platform-showcase-heading" className="mt-2 type-section-title">One repository context, presented where engineers work.</h2>
            <p className="mt-2 max-w-[68ch] type-compact text-text-secondary">Web is available today. CLI, IDE, and Mobile are product directions and are not implemented in the current repository.</p>
          </div>
          <Button type="button" variant="secondary" size="sm" aria-pressed={paused} onClick={() => setPaused((value) => !value)}>{paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}{paused ? "Play preview" : "Pause preview"}</Button>
        </div>

        <div className="grid min-h-[560px] bg-selection/40 laptop:grid-cols-[220px_minmax(0,1fr)] max-[820px]:min-h-0">
          <div role="tablist" aria-label="Platform previews" className="flex gap-2 overflow-x-auto border-b border-border-subtle p-4 laptop:flex-col laptop:border-b-0 laptop:border-r">
            {SHOWCASE_IDS.map((id) => {
              const item = PLATFORM_PRODUCTS.find((candidate) => candidate.id === id);
              if (!item) return null;
              const Icon = item.icon;
              const active = selected === id;
              return <button key={id} type="button" role="tab" aria-selected={active} aria-controls="platform-preview-panel" onClick={() => setSelected(id)} className={cn("flex min-h-11 shrink-0 items-center gap-3 rounded-control px-3 text-left focus-ring", active ? "bg-selection text-foreground" : "text-text-secondary hover:bg-hover hover:text-foreground")}><Icon className={cn("size-4", active && "text-primary")} /><span className="min-w-0 flex-1"><span className="block type-compact-strong">{item.name}</span><span className={cn("block type-metadata", item.status === "available" ? "text-success" : "text-muted-foreground")}>{item.status === "available" ? "AVAILABLE" : "COMING SOON"}</span></span></button>;
            })}
          </div>

          <div id="platform-preview-panel" role="tabpanel" className="min-w-0 p-8 max-[820px]:p-4">
            <div className="mb-5 flex flex-wrap items-start justify-between gap-4"><div><p className="type-metadata-label text-muted-foreground">{product?.status === "available" ? "Available product" : "Coming soon concept"}</p><h3 className="mt-2 type-current-value">Giro {product?.name}</h3><p className="mt-2 max-w-[58ch] type-compact text-text-secondary">{description}</p></div><span className={cn("rounded-badge px-2 py-1 type-metadata", product?.status === "available" ? "bg-success/10 text-success" : "bg-inset text-muted-foreground")}>{product?.status === "available" ? "LIVE" : "NOT YET AVAILABLE"}</span></div>
            <AnimatedPreview selected={selected} paused={paused} />
          </div>
        </div>
      </div>
    </section>
  );
}

function AnimatedPreview({ selected, paused }: { selected: ShowcaseId; paused: boolean }) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (paused) return;
    const timer = window.setInterval(() => setFrame((value) => (value + 1) % 4), 1400);
    return () => window.clearInterval(timer);
  }, [paused]);

  return selected === "web" ? <WebPreview frame={frame} /> : <ComingSoonPreview product={selected} frame={frame} />;
}

const webPreviewRows = [
  { icon: FileCode2, title: "Repository purpose", detail: "Readable engineering summary from the current index" },
  { icon: Search, title: "Indexed evidence", detail: "File paths, symbols, line ranges, scores, and excerpts" },
  { icon: ShieldCheck, title: "Inspectable citations", detail: "Repository version and retrieval identity attached to answers" },
  { icon: Braces, title: "Repository sessions", detail: "Repository-scoped conversations that can be resumed" },
];

function WebPreview({ frame }: { frame: number }) {
  return <div className="overflow-hidden rounded-panel border border-border bg-background shadow-raised"><div className="flex h-11 items-center gap-2 border-b border-border-subtle px-4"><span className="size-2 rounded-full bg-primary" /><span className="type-metadata-label text-muted-foreground">Repository workspace</span><span className="ml-auto type-metadata text-success">READY</span></div><div className="grid laptop:grid-cols-[180px_minmax(0,1fr)]"><aside className="border-b border-border-subtle p-3 laptop:border-b-0 laptop:border-r"><p className="px-2 type-metadata-label text-muted-foreground">acme/platform</p><div className="mt-3 space-y-1">{["Summary", "Architecture", "Files", "Symbols", "Dependencies"].map((label, index) => <div key={label} className={cn("rounded-control px-2 py-2 type-compact", index === frame ? "bg-selection text-foreground" : "text-muted-foreground")}>{label}</div>)}</div></aside><div className="min-w-0 p-5"><p className="type-section-eyebrow text-muted-foreground">Engineering overview</p><h4 className="mt-2 type-section-title">Understand the indexed repository.</h4><div className="mt-5 divide-y divide-border-subtle border-y border-border-subtle">{webPreviewRows.map(({ icon: Icon, title, detail }, index) => <div key={title} className={cn("flex items-start gap-3 px-3 py-3", index === frame && "bg-selection")}><Icon className={cn("mt-0.5 size-4 shrink-0 text-muted-foreground", index === frame && "text-primary")} /><div><p className="type-compact-strong">{title}</p><p className="mt-1 type-compact text-muted-foreground">{detail}</p></div></div>)}</div></div></div></div>;
}

const comingSoonFacts = {
  cli: ["Terminal product surface", "Repository-scoped commands", "No executable CLI ships today"],
  ide: ["Editor product surface", "Grounded context beside code", "No IDE extension ships today"],
  mobile: ["Session review surface", "Evidence review on smaller screens", "No mobile application ships today"],
};

function ComingSoonPreview({ product, frame }: { product: Exclude<ShowcaseId, "web">; frame: number }) {
  const facts = comingSoonFacts[product];
  const Icon = product === "cli" ? PLATFORM_PRODUCTS[1].icon : product === "ide" ? PLATFORM_PRODUCTS[2].icon : PLATFORM_PRODUCTS[3].icon;
  return <div className="flex min-h-[360px] items-center justify-center rounded-panel border border-border bg-background p-6"><div className="w-full max-w-[620px]"><div className="flex items-center gap-3 border-b border-border-subtle pb-4"><span className="grid size-9 place-items-center rounded-control bg-selection"><Icon className="size-4 text-primary" /></span><div><p className="type-panel-title">Giro {product.toUpperCase()}</p><p className="type-metadata text-muted-foreground">CONCEPT PREVIEW · COMING SOON</p></div></div><div className="mt-6 space-y-3">{facts.map((fact, index) => <div key={fact} className={cn("flex min-h-12 items-center gap-3 rounded-control border border-border-subtle px-4", index === frame % facts.length && "bg-selection")}><span className={cn("size-1.5 rounded-full bg-muted-foreground", index === frame % facts.length && "bg-primary")} /><span className="type-mono text-text-secondary">{fact}</span></div>)}</div><p className="mt-6 type-compact text-muted-foreground">This preview communicates product direction only. It does not represent completed functionality.</p></div></div>;
}
