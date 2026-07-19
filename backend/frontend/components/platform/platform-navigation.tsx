"use client";

import { useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import Link from "next/link";
import { Building2, ChevronDown, Code2, Globe2, Layers3, Smartphone, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/overlays";
import { cn } from "@/lib/utils";

export const PLATFORM_PRODUCTS = [
  { id: "web", name: "Web", status: "available", href: "/dashboard", icon: Globe2 },
  { id: "cli", name: "CLI", status: "coming-soon", description: "Repository intelligence directly from the terminal.", icon: Terminal },
  { id: "ide", name: "IDE", status: "coming-soon", description: "Grounded repository understanding inside your editor.", icon: Code2 },
  { id: "mobile", name: "Mobile", status: "coming-soon", description: "Review sessions and repository evidence on the move.", icon: Smartphone },
  { id: "enterprise", name: "Enterprise", status: "coming-soon", description: "Organization controls, private deployments, and team workflows.", icon: Building2 },
] as const;

type PlatformProduct = (typeof PLATFORM_PRODUCTS)[number];
type ComingSoonProduct = Extract<PlatformProduct, { status: "coming-soon" }>;

export function PlatformNavigation({ variant = "public" }: { variant?: "public" | "compact" }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [comingSoon, setComingSoon] = useState<ComingSoonProduct | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  function openComingSoon(product: ComingSoonProduct, event: MouseEvent<HTMLButtonElement>) {
    returnFocusRef.current = variant === "compact" ? triggerRef.current : event.currentTarget;
    setMenuOpen(false);
    setComingSoon(product);
  }

  function closeComingSoon() {
    setComingSoon(null);
    window.setTimeout(() => returnFocusRef.current?.focus(), 0);
  }

  function handleEscape(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    if (comingSoon) {
      closeComingSoon();
      return;
    }
    if (menuOpen) {
      setMenuOpen(false);
      triggerRef.current?.focus();
    }
  }

  return (
    <div className="contents" onKeyDown={handleEscape}>
      {variant === "public" ? (
        <nav aria-label="Giro products" className="flex flex-wrap items-center justify-end gap-1">
          {PLATFORM_PRODUCTS.map((product) => (
            <PublicProduct key={product.id} product={product} onComingSoon={openComingSoon} />
          ))}
        </nav>
      ) : (
        <nav aria-label="Giro products" className="relative">
          <Button
            ref={triggerRef}
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Switch Giro product. Web is active."
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className="w-full justify-start max-[1080px]:justify-center max-[1080px]:px-0"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <Layers3 className="size-4" />
            <span className="max-[1080px]:sr-only">Web</span>
            <span className="ml-auto type-metadata text-success max-[1080px]:sr-only">ACTIVE</span>
            <ChevronDown className={cn("size-3.5 transition-transform duration-[150ms] motion-reduce:transition-none max-[1080px]:hidden", menuOpen && "rotate-180")} />
          </Button>
          {menuOpen ? (
            <div role="menu" aria-label="Giro products" className="absolute bottom-10 left-0 z-50 w-64 rounded-overlay border border-border bg-elevated p-2 shadow-overlay max-[1080px]:left-10 max-[1080px]:bottom-0">
              <p className="px-2 pb-2 pt-1 type-metadata-label text-muted-foreground">Products</p>
              {PLATFORM_PRODUCTS.map((product) => (
                <CompactProduct key={product.id} product={product} onComingSoon={openComingSoon} />
              ))}
            </div>
          ) : null}
        </nav>
      )}

      <Modal
        open={Boolean(comingSoon)}
        title={comingSoon?.name ?? "Giro product"}
        description={comingSoon?.description}
        onClose={closeComingSoon}
        footer={<Button variant="secondary" onClick={closeComingSoon}>Close</Button>}
      >
        <p className="type-metadata-label text-muted-foreground">Coming soon</p>
      </Modal>
    </div>
  );
}

function PublicProduct({ product, onComingSoon }: { product: PlatformProduct; onComingSoon(product: ComingSoonProduct, event: MouseEvent<HTMLButtonElement>): void }) {
  const Icon = product.icon;
  if (product.status === "available") {
    return (
      <Link href={product.href} aria-current="page" className="flex h-8 items-center gap-2 rounded-control bg-selection px-2 type-compact-strong text-foreground focus-ring max-[820px]:min-h-11">
        <Icon className="size-3.5 text-primary" />
        <span>{product.name}</span>
        <span className="type-metadata text-success">ACTIVE</span>
      </Link>
    );
  }
  return (
    <button type="button" aria-label={`${product.name}, coming soon`} onClick={(event) => onComingSoon(product, event)} className="flex h-8 items-center gap-2 rounded-control px-2 type-compact text-text-secondary transition-colors duration-[150ms] hover:bg-hover hover:text-foreground focus-ring max-[820px]:min-h-11">
      <Icon className="size-3.5" />
      <span>{product.name}</span>
      <span className="type-metadata text-muted-foreground">SOON</span>
    </button>
  );
}

function CompactProduct({ product, onComingSoon }: { product: PlatformProduct; onComingSoon(product: ComingSoonProduct, event: MouseEvent<HTMLButtonElement>): void }) {
  const Icon = product.icon;
  const content = (
    <>
      <Icon className={cn("size-3.5 shrink-0", product.status === "available" && "text-primary")} />
      <span className="min-w-0 flex-1 text-left">{product.name}</span>
      <span className={cn("type-metadata", product.status === "available" ? "text-success" : "text-muted-foreground")}>
        {product.status === "available" ? "ACTIVE" : "COMING SOON"}
      </span>
    </>
  );
  if (product.status === "available") {
    return <Link role="menuitem" href={product.href} aria-current="page" className="flex min-h-9 items-center gap-2 rounded-control bg-selection px-2 type-compact-strong text-foreground focus-ring">{content}</Link>;
  }
  return <button role="menuitem" type="button" aria-label={`${product.name}, coming soon`} onClick={(event) => onComingSoon(product, event)} className="flex min-h-9 w-full items-center gap-2 rounded-control px-2 type-compact text-text-secondary hover:bg-hover hover:text-foreground focus-ring">{content}</button>;
}
