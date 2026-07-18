import { Panel } from "@/components/ui/card";
import type { RepositoryExplorerItem } from "@/lib/repository-explorer";

export function RepositoryExplorerDetail({ item }: { item: RepositoryExplorerItem }) {
  return (
    <Panel className="border border-border-subtle p-4" aria-label={`${item.name} details`}>
      <p className="type-metadata-label text-muted-foreground">Selected item</p>
      <h2 className="mt-2 break-words type-panel-title">{item.name}</h2>
      <dl className="mt-4 divide-y divide-border-subtle border-y border-border-subtle">
        <DetailRow label="Category" value={item.categoryLabel} />
        <DetailRow label="Path" value={item.path} mono />
        <DetailRow label="Kind" value={item.kind} />
        <DetailRow label="Reason" value={item.reason} />
      </dl>
    </Panel>
  );
}

function DetailRow({ label, value, mono = false }: { label: string; value: string | undefined; mono?: boolean }) {
  if (!value) return null;
  return (
    <div className="grid min-h-10 gap-2 py-2 mobile:grid-cols-[88px_minmax(0,1fr)]">
      <dt className="type-compact text-muted-foreground">{label}</dt>
      <dd className={mono ? "min-w-0 break-all type-mono text-foreground" : "min-w-0 break-words type-compact text-foreground"}>{value}</dd>
    </div>
  );
}
