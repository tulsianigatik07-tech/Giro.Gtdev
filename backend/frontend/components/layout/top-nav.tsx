"use client";

import Link from "next/link";
import { Menu, PanelRight, Search } from "lucide-react";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Breadcrumbs } from "@/components/ui/data-display";
import { RepositoryStatusBadge } from "@/components/ui/status-badge";
import { useRepositories } from "@/hooks/use-repositories";
import { useSessions } from "@/hooks/use-sessions";
import { useUiStore } from "@/store/ui-store";

export function TopNav() {
  const setSidebarOpen = useUiStore((state) => state.setSidebarOpen);
  const toggleInspector = useUiStore((state) => state.toggleInspector);
  const pathname = usePathname();
  const repositories = useRepositories();
  const sessions = useSessions();
  const segments = pathname.split("/").filter(Boolean);
  const inChat = segments[0] === "chat";
  const routeRepository = segments[0] === "repositories" && segments.length >= 3
    ? `${decodeURIComponent(segments[1] ?? "")}/${decodeURIComponent(segments[2] ?? "")}`
    : null;
  const activeSession = inChat ? sessions.data?.sessions.find((session) => session.id === segments[1]) : null;
  const repository = routeRepository ?? (activeSession ? `${activeSession.owner}/${activeSession.repo}` : null);
  const repositorySearchHref = routeRepository
    ? `/repositories/${encodeURIComponent(segments[1] ?? "")}/${encodeURIComponent(segments[2] ?? "")}/search`
    : null;
  const indexed = repository ? repositories.data?.repositories.find((item) => `${item.owner}/${item.repo}` === repository) : null;
  const section = repository ? "Repository" : segments[0] === "repositories" ? "Repositories" : "Workspace";
  const breadcrumbItems = inChat && activeSession
    ? [
        { label: "Giro", href: "/dashboard" },
        { label: `${activeSession.owner}/${activeSession.repo}`, href: `/repositories/${encodeURIComponent(activeSession.owner)}/${encodeURIComponent(activeSession.repo)}` },
        { label: activeSession.title },
      ]
    : [
        { label: "Giro", href: "/dashboard" },
        { label: section, href: repository ? "/dashboard" : undefined },
        ...(repository ? [{ label: repository }] : []),
      ];
  return (
    <header className="layout-gutter flex h-[52px] shrink-0 items-center border-b border-border-subtle bg-background">
      <Button aria-label="Open navigation" title="Open navigation" variant="ghost" size="icon" className="mr-2 laptop:hidden" onClick={() => setSidebarOpen(true)}><Menu className="size-4" /></Button>
      <div className="min-w-0"><Breadcrumbs items={breadcrumbItems} /></div>
      <div className="ml-auto flex items-center gap-1">
        {indexed ? <RepositoryStatusBadge status={indexed.status} /> : null}
        {repositorySearchHref ? <Button asChild variant="ghost" size="sm"><Link href={repositorySearchHref}><Search className="size-3.5" /><span className="max-[820px]:sr-only">Search repository</span></Link></Button> : null}
        {inChat ? <Button aria-label="Toggle retrieval inspector" title="Toggle retrieval inspector" variant="ghost" size="icon" onClick={toggleInspector}><PanelRight className="size-4" /></Button> : null}
        <div className="ml-2 grid size-8 place-items-center rounded-badge border border-border bg-interactive type-compact-strong text-text-secondary" aria-label="Signed in">G</div>
      </div>
    </header>
  );
}
