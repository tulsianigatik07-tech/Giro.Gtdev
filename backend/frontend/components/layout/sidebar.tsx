"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Clock3, LayoutDashboard, LogOut, MessageSquare, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { useAuth } from "@/features/auth/auth-context";
import { useDeleteSession, useSessions } from "@/hooks/use-sessions";
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
  const remove = useDeleteSession();
  const { sidebarOpen, setSidebarOpen } = useUiStore();

  async function deleteSession(id: string) {
    try {
      await remove.mutateAsync(id);
      if (pathname === `/chat/${id}`) router.push("/dashboard");
    } catch {
      // The mutation error is rendered below with its request ID.
    }
  }

  return (
    <>
      {sidebarOpen ? <button aria-label="Close navigation" className="fixed inset-0 z-40 bg-black/60 lg:hidden" onClick={() => setSidebarOpen(false)} /> : null}
      <aside className={cn("fixed inset-y-0 left-0 z-50 flex w-64 -translate-x-full flex-col border-r border-border bg-panel transition-transform duration-200 motion-reduce:transition-none lg:static lg:translate-x-0", sidebarOpen && "translate-x-0")}>
        <div className="flex h-14 items-center border-b border-border px-4">
          <Link href="/dashboard" className="flex items-center gap-2 focus-ring rounded"><span className="font-display text-2xl italic leading-none">G</span><span className="font-display text-lg">Giro</span><span className="rounded-full border border-primary/40 bg-primary/10 px-1.5 py-0.5 font-mono text-[8px] tracking-wider text-primary">DEV</span></Link>
          <Button aria-label="Close sidebar" variant="ghost" size="icon" className="ml-auto lg:hidden" onClick={() => setSidebarOpen(false)}><X className="size-4" /></Button>
        </div>
        <nav aria-label="Primary navigation" className="space-y-1 p-3">
          {navigation.map(({ href, label, icon: Icon }) => (
            <Link key={href} href={href} onClick={() => setSidebarOpen(false)} className={cn("flex h-9 items-center gap-2.5 rounded-md px-3 text-sm text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-ring", pathname === href && "border border-border bg-muted text-foreground")}><Icon className={cn("size-4", pathname === href && "text-primary")} />{label}</Link>
          ))}
        </nav>
        <div className="mx-3 border-t border-border" />
        <div className="flex min-h-0 flex-1 flex-col px-3 py-4">
          <div className="mb-2 flex items-center justify-between px-2"><span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Recent sessions</span><Clock3 className="size-3 text-muted-foreground" /></div>
          <div className="space-y-1 overflow-y-auto">
            {isLoading ? Array.from({ length: 3 }, (_, index) => <Skeleton key={index} className="h-9" />) : null}
            {data?.sessions.slice(0, 12).map((session) => (
              <div key={session.id} className={cn("group flex items-center rounded-md hover:bg-foreground/5", pathname === `/chat/${session.id}` && "bg-muted")}>
                <Link href={`/chat/${session.id}`} onClick={() => setSidebarOpen(false)} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-xs text-muted-foreground focus-ring"><MessageSquare className="size-3.5 shrink-0" /><span className="truncate">{session.title}</span></Link>
                <button aria-label={`Delete ${session.title}`} className="mr-1 rounded p-1 text-muted-foreground opacity-0 hover:text-red-300 focus:opacity-100 focus-ring group-hover:opacity-100" onClick={() => void deleteSession(session.id)} disabled={remove.isPending}><Trash2 className="size-3" /></button>
              </div>
            ))}
            {!isLoading && data?.sessions.length === 0 ? <p className="px-2 py-4 text-xs leading-relaxed text-muted-foreground">Sessions appear here after you open a repository.</p> : null}
            {remove.isError ? <ErrorState error={remove.error} compact /> : null}
          </div>
        </div>
        <div className="border-t border-border p-3">
          <Button variant="ghost" className="w-full justify-start" onClick={signOut}><LogOut className="size-4" />Sign out</Button>
        </div>
      </aside>
    </>
  );
}
