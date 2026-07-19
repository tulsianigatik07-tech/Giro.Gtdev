import Link from "next/link";
import { ArrowRight, Clock3, MessageSquare, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import type { SessionSummary } from "@/types/api";

interface SessionTimelineProps {
  sessions?: SessionSummary[];
  loading?: boolean;
  error?: unknown;
  onRetry?(): void;
  startHref: string;
  now?: Date;
}

type TimelineGroup = { label: "Today" | "Yesterday" | "Earlier"; sessions: SessionSummary[] };

export function SessionTimeline({ sessions = [], loading = false, error, onRetry, startHref, now = new Date() }: SessionTimelineProps) {
  const ordered = orderSessions(sessions);
  const groups = groupSessions(ordered, now);
  const latestId = ordered[0]?.id;
  const recentCreations = [...ordered].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)).slice(0, 3);

  return (
    <section aria-labelledby="sessions-heading" className="mt-9">
      <div className="mb-4 flex flex-col gap-2 mobile:flex-row mobile:items-end mobile:justify-between">
        <div><h2 id="sessions-heading" className="type-section-eyebrow text-muted-foreground">Investigation timeline</h2><p className="mt-2 type-compact text-text-secondary">Resume repository-scoped work from recorded session activity.</p></div>
        {ordered.length ? <span className="type-metadata text-muted-foreground">{ordered.length} sessions</span> : null}
      </div>
      {error ? <ErrorState error={error} retry={onRetry} compact /> : null}
      {loading ? <div role="status" aria-live="polite" aria-label="Loading investigation timeline" className="space-y-3 border-y border-border-subtle py-3"><span className="sr-only">Loading investigation timeline.</span><Skeleton className="h-24" /><Skeleton className="h-20" /></div> : null}
      {!loading && !error && ordered.length === 0 ? <EmptySessionTimeline startHref={startHref} /> : null}
      {!loading && !error && ordered.length ? <div data-testid="session-timeline-layout" className="grid items-start gap-8 laptop:grid-cols-[minmax(0,1fr)_280px]"><div className="space-y-7">{groups.map((group) => <TimelineGroupSection key={group.label} group={group} latestId={latestId} />)}</div><RecentSessionActivity sessions={recentCreations} /></div> : null}
    </section>
  );
}

function TimelineGroupSection({ group, latestId }: { group: TimelineGroup; latestId?: string }) {
  return <section aria-labelledby={`session-group-${group.label.toLowerCase()}`}><h3 id={`session-group-${group.label.toLowerCase()}`} className="type-metadata-label text-muted-foreground">{group.label}</h3><ol className="mt-2 divide-y divide-border-subtle border-y border-border-subtle" aria-label={`${group.label} sessions`}>{group.sessions.map((session) => <li key={session.id}><SessionTimelineItem session={session} latest={session.id === latestId} /></li>)}</ol></section>;
}

function SessionTimelineItem({ session, latest }: { session: SessionSummary; latest: boolean }) {
  return <article className={latest ? "bg-selection" : undefined}><Link href={`/chat/${encodeURIComponent(session.id)}`} className="group grid gap-3 px-3 py-4 focus-ring mobile:grid-cols-[28px_minmax(0,1fr)_auto] mobile:items-start"><MessageSquare className={`mt-0.5 size-4 ${latest ? "text-primary" : "text-muted-foreground"}`} /><div className="min-w-0">{latest ? <p className="mb-1 type-metadata-label text-primary">Continue investigation</p> : null}<h4 className="truncate type-body-strong">{session.title}</h4><p className="mt-1 truncate type-mono text-muted-foreground">{session.owner}/{session.repo}</p><p className="mt-2 type-compact text-text-secondary" aria-label={`Session preview: ${session.title}`}>Resume “{session.title}”.</p><div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 type-metadata text-muted-foreground"><span className="inline-flex items-center gap-1.5"><Clock3 className="size-3" /><span>Last activity <time dateTime={session.updatedAt}>{formatTimestamp(session.updatedAt)}</time></span></span><span>Created <time dateTime={session.createdAt}>{formatTimestamp(session.createdAt)}</time></span><span>{session.messageCount} messages</span></div></div><ArrowRight className="hidden size-3.5 text-muted-foreground transition-transform duration-[150ms] group-hover:translate-x-0.5 motion-reduce:transition-none mobile:mt-1 mobile:block" /></Link></article>;
}

function RecentSessionActivity({ sessions }: { sessions: SessionSummary[] }) {
  return <aside aria-labelledby="recent-activity-heading" className="border-y border-border-subtle py-4"><h3 id="recent-activity-heading" className="type-metadata-label text-muted-foreground">Recent activity</h3><ol className="mt-2 divide-y divide-border-subtle">{sessions.map((session) => <li key={session.id} className="py-3"><p className="type-compact-strong">Session created</p><p className="mt-1 truncate type-compact text-text-secondary">{session.title}</p><p className="mt-1 truncate type-mono text-muted-foreground">{session.owner}/{session.repo}</p><time dateTime={session.createdAt} className="mt-1 block type-metadata text-muted-foreground">{formatTimestamp(session.createdAt)}</time></li>)}</ol></aside>;
}

function EmptySessionTimeline({ startHref }: { startHref: string }) {
  return <div className="border-y border-border-subtle py-8"><h3 className="type-panel-title">No investigations recorded.</h3><p className="mt-2 max-w-[62ch] type-body text-text-secondary">Repository conversations appear here after a session is started from an indexed repository.</p><Button asChild variant="secondary" className="mt-5"><Link href={startHref}><Play className="size-4" />Start your first investigation</Link></Button></div>;
}

export function orderSessions(sessions: SessionSummary[]): SessionSummary[] {
  return sessions.map((session, index) => ({ session, index })).sort((a, b) => {
    const left = Date.parse(a.session.updatedAt);
    const right = Date.parse(b.session.updatedAt);
    if (Number.isNaN(left) || Number.isNaN(right)) return a.index - b.index;
    return right - left || a.index - b.index;
  }).map(({ session }) => session);
}

export function groupSessions(sessions: SessionSummary[], now: Date): TimelineGroup[] {
  const today = calendarKey(now);
  const yesterdayDate = new Date(now);
  yesterdayDate.setDate(now.getDate() - 1);
  const yesterday = calendarKey(yesterdayDate);
  const grouped = new Map<TimelineGroup["label"], SessionSummary[]>([["Today", []], ["Yesterday", []], ["Earlier", []]]);
  for (const session of sessions) {
    const value = new Date(session.updatedAt);
    const key = Number.isNaN(value.getTime()) ? "Earlier" : calendarKey(value) === today ? "Today" : calendarKey(value) === yesterday ? "Yesterday" : "Earlier";
    grouped.get(key)?.push(session);
  }
  return (["Today", "Yesterday", "Earlier"] as const).flatMap((label) => {
    const items = grouped.get(label) ?? [];
    return items.length ? [{ label, sessions: items }] : [];
  });
}

function calendarKey(value: Date): string {
  return `${value.getFullYear()}-${value.getMonth()}-${value.getDate()}`;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Time unavailable";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
