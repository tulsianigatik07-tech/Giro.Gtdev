"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ChevronsUpDown, Clock3, LayoutDashboard, LogOut, MessageSquare, PanelLeftClose, PanelLeftOpen, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { PlatformNavigation } from "@/components/platform/platform-navigation";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { getRepositoryStatus } from "@/components/ui/status-badge";
import { useAuth } from "@/features/auth/auth-context";
import { useDeleteSession, useSessions } from "@/hooks/use-sessions";
import { useRepositories } from "@/hooks/use-repositories";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/store/ui-store";

const navigation = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/repositories/connect", label: "Connect repository", icon: Plus },
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { signOut } = useAuth();
  const { data, isLoading } = useSessions();
  const repositories = useRepositories();
  const remove = useDeleteSession();
  const repositoryMenuRef = useRef<HTMLDetailsElement>(null);
  const { sidebarOpen, sidebarCollapsed, setSidebarOpen, setSidebarCollapsed, toggleSidebarCollapsed } = useUiStore();
  const segments = pathname.split("/").filter(Boolean);
  const routeRepository = segments[0] === "repositories" && segments.length >= 3
    ? `${decodeURIComponent(segments[1] ?? "")}/${decodeURIComponent(segments[2] ?? "")}`
    : null;
  const activeSession = segments[0] === "chat" ? data?.sessions.find((session) => session.id === segments[1]) : null;
  const activeRepository = routeRepository ?? (activeSession ? `${activeSession.owner}/${activeSession.repo}` : null);

  useEffect(() => {
    const saved = window.localStorage.getItem("giro.sidebar-collapsed");
    if (saved) setSidebarCollapsed(saved === "true");
    const desktop = window.matchMedia("(min-width: 1081px)");
    const closeDrawer = () => { if (desktop.matches) setSidebarOpen(false); };
    desktop.addEventListener("change", closeDrawer);
    return () => desktop.removeEventListener("change", closeDrawer);
  }, [setSidebarCollapsed, setSidebarOpen]);

  function toggleCollapsed() {
    const next = !sidebarCollapsed;
    toggleSidebarCollapsed();
    window.localStorage.setItem("giro.sidebar-collapsed", String(next));
  }

  async function deleteSession(id: string) {
    try {
      await remove.mutateAsync(id);
      if (pathname === `/chat/${id}`) router.push("/dashboard");
    } catch {
      // The mutation error is rendered below with its request ID.
    }
  }

  function navigationContent(drawer: boolean) {
    const hideText = !drawer && "max-[1080px]:hidden";
    const collapsedText = !drawer && sidebarCollapsed && "laptop:hidden";
    return <>
        <div className="flex h-[52px] shrink-0 items-center px-3">
          <Link href="/dashboard" aria-label="Giro dashboard" className="flex min-w-0 items-center gap-2 rounded-control px-1 focus-ring"><span className="grid size-7 shrink-0 place-items-center rounded-badge bg-primary type-compact-strong text-primary-foreground">G</span><span className={cn("type-body-strong", hideText, collapsedText)}>Giro</span><span className={cn("rounded-badge bg-inset px-1.5 type-metadata text-muted-foreground", hideText, collapsedText)}>DEV</span></Link>
          {drawer ? <Button aria-label="Close sidebar" variant="ghost" size="icon-sm" className="ml-auto" onClick={() => setSidebarOpen(false)}><X className="size-4" /></Button> : null}
        </div>
        <div className="px-2 pb-5">
          <details ref={drawer ? undefined : repositoryMenuRef} className="group relative" onKeyDown={(event) => { if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } if (event.key === "ArrowDown" && event.target === event.currentTarget.querySelector("summary")) { event.preventDefault(); event.currentTarget.open = true; event.currentTarget.querySelector<HTMLAnchorElement>("a")?.focus(); } }}>
            <summary title="Select repository" className={cn("flex h-10 cursor-pointer list-none items-center gap-2 rounded-control px-3 text-text-secondary transition-colors duration-[150ms] hover:bg-hover hover:text-foreground focus-ring", !drawer && "mobile:justify-center mobile:px-0 laptop:justify-start laptop:px-3")}>
              <span className="grid size-4 shrink-0 place-items-center rounded-badge bg-selection type-metadata text-primary">R</span>
              <span className={cn("min-w-0 flex-1", hideText, collapsedText)}><span className="block truncate type-compact-strong text-foreground">{activeRepository ?? "Select repository"}</span><span className="block truncate type-metadata text-muted-foreground">Repository context</span></span>
              <ChevronsUpDown className={cn("size-3.5 shrink-0", hideText, collapsedText)} />
            </summary>
            <div className="absolute left-0 top-11 z-50 w-64 rounded-overlay border border-border bg-elevated p-2 shadow-overlay">
              <p className="px-2 py-1 type-metadata-label text-muted-foreground">Repositories</p>
              {repositories.data?.repositories.map((repository) => <Link key={`${repository.owner}/${repository.repo}`} href={`/repositories/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`} onClick={() => setSidebarOpen(false)} className="flex min-h-8 items-center gap-2 rounded-control px-2 type-compact text-text-secondary hover:bg-hover hover:text-foreground focus-ring"><span className="min-w-0 flex-1 truncate">{repository.owner}/{repository.repo}</span><span className="type-metadata text-muted-foreground">{getRepositoryStatus(repository.status).label}</span></Link>)}
              {!repositories.isLoading && !repositories.data?.repositories.length ? <p className="px-2 py-3 type-compact text-muted-foreground">No repositories connected.</p> : null}
            </div>
          </details>
        </div>
        <nav aria-label="Primary navigation" className="px-2">
          <p className={cn("px-3 pb-2 type-metadata-label text-muted-foreground", !drawer && "max-[1080px]:sr-only", !drawer && sidebarCollapsed && "laptop:sr-only")}>Workspace</p>
          <div className="space-y-1">
          {navigation.map(({ href, label, icon: Icon }) => (
            <Link key={href} href={href} title={label} onClick={() => setSidebarOpen(false)} className={cn("relative flex h-9 items-center gap-2 rounded-control px-3 type-compact-strong text-text-secondary transition-colors duration-[150ms] hover:bg-hover hover:text-foreground focus-ring max-[820px]:min-h-11", !drawer && "mobile:justify-center mobile:px-0 laptop:justify-start laptop:px-3", pathname === href && "bg-selection text-foreground before:absolute before:bottom-2 before:left-0 before:top-2 before:w-0.5 before:bg-primary", !drawer && sidebarCollapsed && "laptop:justify-center laptop:px-0")}><Icon className={cn("size-4 shrink-0", pathname === href && "text-primary")} /><span className={cn("truncate", hideText, collapsedText)}>{label}</span></Link>
          ))}
          </div>
        </nav>
        <div className="mt-5 flex min-h-0 flex-1 flex-col px-2">
          <div className={cn("mb-2 flex items-center justify-between px-3", !drawer && sidebarCollapsed && "laptop:justify-center")}><span className={cn("type-metadata-label text-muted-foreground", hideText, collapsedText)}>Recent sessions</span><Clock3 className="size-3.5 text-muted-foreground" /></div>
          <div className={cn("space-y-1 overflow-y-auto", hideText, collapsedText)}>
            {isLoading ? Array.from({ length: 3 }, (_, index) => <Skeleton key={index} className="h-9" />) : null}
            {data?.sessions.slice(0, 12).map((session) => (
              <div key={session.id} className={cn("group flex items-center rounded-control hover:bg-hover", pathname === `/chat/${session.id}` && "bg-selection")}>
                <Link href={`/chat/${session.id}`} onClick={() => setSidebarOpen(false)} className="flex min-w-0 flex-1 items-center gap-2 rounded-control px-2 py-2 type-compact text-text-secondary focus-ring"><MessageSquare className="size-3.5 shrink-0" /><span className="truncate">{session.title}</span></Link>
                <button aria-label={`Delete ${session.title}`} className="mr-1 grid size-8 place-items-center rounded-control text-muted-foreground hover:bg-hover hover:text-danger focus-ring max-[820px]:size-11" onClick={() => void deleteSession(session.id)} disabled={remove.isPending}><Trash2 className="size-3" /></button>
              </div>
            ))}
            {!isLoading && data?.sessions.length === 0 ? <p className="px-2 py-4 type-compact text-muted-foreground">Sessions appear here after you open a repository.</p> : null}
            {remove.isError ? <ErrorState error={remove.error} compact /> : null}
          </div>
        </div>
        <div className="border-t border-border-subtle px-2 pb-2 pt-3">
          <PlatformNavigation variant="compact" />
          <Button variant="ghost" size={!drawer && sidebarCollapsed ? "icon" : "default"} title="Sign out" className={cn("w-full justify-start", !drawer && "max-[1080px]:justify-center", !drawer && sidebarCollapsed && "laptop:justify-center")} onClick={signOut}><LogOut className="size-4" /><span className={cn(hideText, collapsedText)}>Sign out</span></Button>
          {!drawer ? <Button variant="ghost" size={sidebarCollapsed ? "icon" : "default"} title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"} className={cn("mt-1 hidden w-full justify-start laptop:inline-flex", sidebarCollapsed && "laptop:justify-center")} onClick={toggleCollapsed}>{sidebarCollapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}<span className={cn(sidebarCollapsed && "laptop:hidden")}>Collapse sidebar</span></Button> : null}
        </div>
      </>;
  }

  return <><aside aria-label="Application navigation" className={cn("hidden h-full w-14 shrink-0 flex-col border-r border-border-subtle bg-sidebar mobile:flex laptop:w-[220px]", sidebarCollapsed && "laptop:w-14")}>{navigationContent(false)}</aside><Drawer open={sidebarOpen} label="Application navigation" side="left" className="!w-[220px] bg-sidebar" onClose={() => setSidebarOpen(false)}>{navigationContent(true)}</Drawer></>;
}
