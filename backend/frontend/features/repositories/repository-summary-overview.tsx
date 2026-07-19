import Link from "next/link";
import { ArrowRight, Braces, FileCode2, FolderTree, MessageSquare, Search, Waypoints } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InlineAlert } from "@/components/ui/inline-alert";
import { StatusBadge, getRepositoryStatus, type StatusTone } from "@/components/ui/status-badge";
import { repositoryExplorerItemKey } from "@/lib/repository-explorer";
import type { IndexedRepository, RepositorySummary, RepositorySummaryItem, RepositoryWorkspace } from "@/types/api";

interface StructureItem extends RepositorySummaryItem {
  category: string;
  tab: "architecture" | "files" | "symbols" | "dependencies";
}

interface StructureGroup {
  id: string;
  label: string;
  description: string;
  icon: typeof FileCode2;
  items: StructureItem[];
}

const technologyFields: Array<{ label: string; field: keyof RepositorySummary }> = [
  { label: "Languages", field: "languages" },
  { label: "Frameworks", field: "frameworks" },
  { label: "Package managers", field: "packageManagers" },
  { label: "Testing", field: "testing" },
  { label: "Deployment", field: "deployment" },
  { label: "Data stores", field: "dataStores" },
  { label: "Build", field: "build" },
];

export function RepositorySummaryOverview({
  owner,
  repo,
  summary,
  repository,
  workspace,
  workspaceLoading = false,
  workspaceUnavailable = false,
  onAsk,
}: {
  owner: string;
  repo: string;
  summary?: RepositorySummary;
  repository?: IndexedRepository;
  workspace?: RepositoryWorkspace;
  workspaceLoading?: boolean;
  workspaceUnavailable?: boolean;
  onAsk(): void;
}) {
  const basePath = `/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const technologies = technologyFields.flatMap(({ label, field }) => {
    const value = summary?.[field];
    return Array.isArray(value) && field !== "dependencyOverview" && value.length > 0
      ? [{ label, items: value as RepositorySummaryItem[] }]
      : [];
  });
  const structure = structureGroups(summary);
  const status = getRepositoryStatus(repository?.status);
  const healthWarnings = unique([
    ...(workspace?.health.warnings ?? []),
    ...(workspace?.aiReadiness.blockers ?? []),
    ...(workspace?.aiReadiness.warnings ?? []),
    ...(repository?.failureReason ? [repository.failureReason] : []),
  ]);
  const missingAnalysis = [
    technologies.length === 0 ? "technology stack" : null,
    (summary?.entrypoints?.length ?? 0) === 0 ? "entry points" : null,
    (summary?.importantDirectories?.length ?? 0) === 0 ? "important paths" : null,
    (summary?.modules?.length ?? 0) === 0 && (summary?.dependencyOverview?.centralModules.length ?? 0) === 0 ? "major modules" : null,
  ].filter((item): item is string => Boolean(item));

  return (
    <div className="space-y-10">
      <div className="grid items-start gap-10 laptop:grid-cols-[minmax(0,1fr)_320px] laptop:gap-12">
        <div className="min-w-0 space-y-9">
          <section aria-labelledby="repository-purpose-heading">
            <p className="type-section-eyebrow text-muted-foreground">Engineering summary</p>
            <h2 id="repository-purpose-heading" className="mt-2 type-section-title">Repository purpose</h2>
            {summary?.purpose ? (
              <p className="mt-3 max-w-[68ch] type-body text-foreground">{summary.purpose}</p>
            ) : (
              <p className="mt-3 max-w-[68ch] border-y border-border-subtle py-4 type-compact text-muted-foreground">A repository purpose summary is not available from the current index.</p>
            )}
          </section>

          <section aria-labelledby="technology-stack-heading">
            <p className="type-section-eyebrow text-muted-foreground">Detected environment</p>
            <h2 id="technology-stack-heading" className="mt-2 type-section-title">Technology stack</h2>
            {technologies.length > 0 ? (
              <div className="mt-4 grid gap-x-7 gap-y-4 sm:grid-cols-2">
                {technologies.map((group) => (
                  <div key={group.label}>
                    <p className="type-compact-strong text-text-secondary">{group.label}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {group.items.slice(0, 8).map((item) => <Badge key={`${group.label}-${item.name}`}>{item.name}</Badge>)}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-4 border-y border-border-subtle py-4 type-compact text-muted-foreground">Technology analysis is not available from the current summary.</p>
            )}
          </section>
        </div>

        <aside aria-label="Repository status and primary actions" className="min-w-0 space-y-8 border-t border-border-subtle pt-8 laptop:border-l laptop:border-t-0 laptop:pl-8 laptop:pt-0">
          <section aria-labelledby="repository-health-heading">
            <p className="type-section-eyebrow text-muted-foreground">Current status</p>
            <h2 id="repository-health-heading" className="mt-2 type-section-title">Repository health</h2>
            <div className="mt-4 divide-y divide-border-subtle border-y border-border-subtle">
              <HealthItem title="Index status" value={status.label} detail={repository?.lastIndexMode ? `${repository.lastIndexMode} index` : "Repository lifecycle"} tone={status.tone} />
              <HealthItem title="AI readiness" value={workspace ? readinessLabel(workspace.aiReadiness.level) : status.ready ? "Ready" : "Unavailable"} detail={workspace ? `${workspace.aiReadiness.score}/100 readiness` : "Based on index status"} tone={workspace ? readinessTone(workspace.aiReadiness.level) : status.tone} />
              <HealthItem title="Repository health" value={workspace ? capitalize(workspace.health.grade) : workspaceLoading ? "Checking" : "Not available"} detail={workspace ? `${workspace.health.score}/100 health score` : "Detailed health analysis"} tone={workspace ? healthTone(workspace.health.score) : "neutral"} />
              <HealthItem title="Indexed context" value={repository ? `${repository.fileCount.toLocaleString()} files` : "Not available"} detail={repository ? `${repository.chunkCount.toLocaleString()} chunks · ${repository.symbolCount.toLocaleString()} symbols` : "Index coverage not exposed"} tone={repository && repository.fileCount > 0 ? "success" : "neutral"} />
            </div>
            {healthWarnings.length > 0 ? <InlineAlert tone={workspace?.aiReadiness.level === "blocked" || repository?.status === "failed" ? "danger" : "warning"} className="mt-4"><div><p className="type-compact-strong">Repository attention</p><ul className="mt-1 space-y-1">{healthWarnings.slice(0, 4).map((warning) => <li key={warning}>{warning}</li>)}</ul></div></InlineAlert> : null}
            {workspaceUnavailable ? <InlineAlert tone="info" className="mt-4">Detailed health and readiness are temporarily unavailable. Index status remains current.</InlineAlert> : null}
            {missingAnalysis.length > 0 ? <p className="mt-3 type-compact text-muted-foreground">Not exposed by the current summary: {missingAnalysis.join(", ")}.</p> : null}
          </section>

          <section aria-labelledby="next-actions-heading">
            <p className="type-section-eyebrow text-muted-foreground">Continue working</p>
            <h2 id="next-actions-heading" className="mt-2 type-section-title">Primary actions</h2>
            <div className="mt-4 divide-y divide-border-subtle border-y border-border-subtle">
              <NextAction href={`${basePath}/search`} icon={Search} title="Search repository" description="Find relevant symbols, files, and indexed evidence." />
              <NextAction href={`${basePath}?tab=sessions`} icon={MessageSquare} title="Open sessions" description="Resume repository-scoped engineering conversations." />
              <NextAction href={`${basePath}?tab=dependencies`} icon={Waypoints} title="Inspect dependencies" description="Review central modules, hotspots, and detected cycles." />
              <NextAction href={`${basePath}?tab=symbols`} icon={Braces} title="Review symbols" description="Explore modules and API surfaces detected by indexing." />
              <div className="flex min-h-14 items-center gap-3 py-3">
                <MessageSquare className="size-4 shrink-0 text-primary" />
                <div className="min-w-0 flex-1"><p className="type-compact-strong">Ask Giro</p><p className="mt-0.5 type-compact text-muted-foreground">Start a grounded conversation about this repository.</p></div>
                <Button variant="secondary" size="sm" onClick={onAsk} disabled={!status.ready}>Ask Giro</Button>
              </div>
            </div>
          </section>
        </aside>
      </div>

      <section aria-labelledby="repository-structure-heading" className="border-t border-border-subtle pt-9">
        <p className="type-section-eyebrow text-muted-foreground">Repository exploration</p>
        <h2 id="repository-structure-heading" className="mt-2 type-section-title">Where to start reading</h2>
        <p className="mt-2 max-w-[68ch] type-compact text-text-secondary">Start with detected entry points and important repository surfaces, then continue in the existing explorer.</p>
        {structure.length > 0 ? (
          <div className="mt-6 grid gap-x-10 gap-y-8 laptop:grid-cols-2">
            {structure.map((group) => <StructureSection key={group.id} group={group} basePath={basePath} />)}
          </div>
        ) : (
          <p className="mt-4 border-y border-border-subtle py-4 type-compact text-muted-foreground">Repository structure analysis is not available from the current summary.</p>
        )}
      </section>
    </div>
  );
}

function structureGroups(summary?: RepositorySummary): StructureGroup[] {
  if (!summary) return [];
  const group = (id: string, label: string, description: string, icon: StructureGroup["icon"], tab: StructureItem["tab"], category: string, items: readonly RepositorySummaryItem[] = []): StructureGroup => ({
    id, label, description, icon, items: items.slice(0, 4).map((item) => ({ ...item, tab, category })),
  });
  const importantPaths: StructureItem[] = [
    ...(summary.importantDirectories ?? []).map((item) => ({ ...item, tab: "files" as const, category: "importantDirectories" })),
    ...(summary.configFiles ?? []).map((item) => ({ ...item, tab: "files" as const, category: "configFiles" })),
  ].slice(0, 4);
  const modules = uniqueItems([
    ...(summary.modules ?? []).map((item) => ({ ...item, tab: "symbols" as const, category: "modules" })),
    ...(summary.dependencyOverview?.centralModules ?? []).map((name) => ({ name, tab: "dependencies" as const, category: "centralModules" })),
  ]).slice(0, 4);
  const subsystems = uniqueItems([
    ...(summary.services ?? []).map((item) => ({ ...item, tab: "architecture" as const, category: "services" })),
    ...(summary.applications ?? []).map((item) => ({ ...item, tab: "architecture" as const, category: "applications" })),
    ...(summary.libraries ?? []).map((item) => ({ ...item, tab: "architecture" as const, category: "libraries" })),
    ...(summary.backgroundWorkers ?? []).map((item) => ({ ...item, tab: "architecture" as const, category: "backgroundWorkers" })),
  ]).slice(0, 4);
  return [
    group("entrypoints", "Entry points", "Start with execution boundaries and application entry files.", FileCode2, "architecture", "entrypoints", summary.entrypoints),
    { id: "paths", label: "Important paths", description: "Directories and configuration that define the repository shape.", icon: FolderTree, items: importantPaths },
    { id: "modules", label: "Major modules", description: "Modules identified by the summary or dependency analysis.", icon: Braces, items: modules },
    { id: "subsystems", label: "Subsystems", description: "Applications, services, libraries, and workers detected during indexing.", icon: Waypoints, items: subsystems },
  ].filter((item) => item.items.length > 0);
}

function StructureSection({ group, basePath }: { group: StructureGroup; basePath: string }) {
  const Icon = group.icon;
  return <section aria-labelledby={`overview-${group.id}`}><div className="flex items-start gap-3"><Icon className="mt-0.5 size-4 shrink-0 text-primary" /><div><h3 id={`overview-${group.id}`} className="type-panel-title">{group.label}</h3><p className="mt-1 type-compact text-muted-foreground">{group.description}</p></div></div><div className="mt-3 divide-y divide-border-subtle border-y border-border-subtle">{group.items.map((item) => { const params = new URLSearchParams({ tab: item.tab, category: item.category, item: repositoryExplorerItemKey(item.category, item) }); return <div key={`${item.category}-${item.name}-${item.path ?? ""}`} className="flex min-h-12 items-center gap-3 px-3 py-2"><div className="min-w-0 flex-1"><p className="truncate type-compact-strong" title={item.name}>{item.name}</p><p className="mt-0.5 truncate type-metadata text-muted-foreground" title={item.reason ?? item.path ?? item.kind}>{item.reason ?? item.path ?? item.kind ?? "Detected by repository analysis"}</p></div><Button asChild variant="ghost" size="sm"><Link href={`${basePath}?${params.toString()}`} aria-label={`Explore ${item.name}`}>Explore<ArrowRight className="size-3.5" /></Link></Button></div>; })}</div></section>;
}

function HealthItem({ title, value, detail, tone }: { title: string; value: string; detail: string; tone: StatusTone }) {
  return <div className="flex min-h-14 items-center gap-3 py-3"><div className="min-w-0 flex-1"><p className="type-metadata-label text-muted-foreground">{title}</p><p className="mt-1 type-compact text-muted-foreground">{detail}</p></div><StatusBadge label={value} tone={tone} className="shrink-0" /></div>;
}

function NextAction({ href, icon: Icon, title, description }: { href: string; icon: typeof Search; title: string; description: string }) {
  return <Link href={href} className="flex min-h-14 items-center gap-3 py-3 transition-colors duration-[150ms] hover:bg-hover focus-ring"><Icon className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1"><span className="block type-compact-strong">{title}</span><span className="mt-0.5 block type-compact text-muted-foreground">{description}</span></span><ArrowRight className="size-3.5 shrink-0 text-muted-foreground" /></Link>;
}

function readinessLabel(level: RepositoryWorkspace["aiReadiness"]["level"]): string {
  return level === "ready" ? "Ready" : level === "degraded" ? "Degraded" : "Blocked";
}

function readinessTone(level: RepositoryWorkspace["aiReadiness"]["level"]): StatusTone {
  return level === "ready" ? "success" : level === "degraded" ? "warning" : "danger";
}

function healthTone(score: number): StatusTone {
  return score >= 70 ? "success" : score >= 40 ? "warning" : "danger";
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueItems<T extends { name: string }>(items: T[]): T[] {
  return items.filter((item, index) => items.findIndex((candidate) => candidate.name === item.name) === index);
}
