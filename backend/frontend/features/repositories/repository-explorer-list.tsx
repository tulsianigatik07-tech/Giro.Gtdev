import { useEffect, useRef } from "react";
import { FileCode2 } from "lucide-react";
import { ListRow } from "@/components/ui/data-display";
import { cn } from "@/lib/utils";
import type { RepositoryExplorerCategory, RepositoryExplorerItem } from "@/lib/repository-explorer";

export function RepositoryExplorerList({
  categories,
  selectedKey,
  onSelect,
  label,
  restoreFocus = false,
}: {
  categories: RepositoryExplorerCategory[];
  selectedKey?: string;
  onSelect(item: RepositoryExplorerItem): void;
  label: string;
  restoreFocus?: boolean;
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const items = categories.flatMap((category) => category.items);
  const focusKey = selectedKey ?? items[0]?.key;

  useEffect(() => {
    if (!restoreFocus || !selectedKey) return;
    const selectedIndex = items.findIndex((item) => item.key === selectedKey);
    if (selectedIndex >= 0) buttons.current[selectedIndex]?.focus();
  }, [items, restoreFocus, selectedKey]);

  function moveSelection(currentItem: RepositoryExplorerItem, destination: "previous" | "next" | "first" | "last") {
    const currentIndex = items.findIndex((item) => item.key === currentItem.key);
    const nextIndex = destination === "first"
      ? 0
      : destination === "last"
        ? items.length - 1
        : destination === "previous"
          ? Math.max(0, currentIndex - 1)
          : Math.min(items.length - 1, currentIndex + 1);
    const nextItem = items[nextIndex];
    if (!nextItem) return;
    onSelect(nextItem);
    buttons.current[nextIndex]?.focus();
  }

  let itemIndex = 0;
  return (
    <div role="listbox" aria-label={label} className="space-y-5">
      {categories.map((category) => (
        <section key={category.id} role="group" aria-labelledby={`repository-category-${category.id}`}>
          <h3 id={`repository-category-${category.id}`} className="px-3 pb-2 type-metadata-label text-muted-foreground">{category.label}</h3>
          <div className="border-y border-border-subtle">
            {category.items.map((item) => {
              const index = itemIndex++;
              const selected = item.key === selectedKey;
              const visiblePath = item.path && item.path !== item.name ? item.path : undefined;
              return (
                <ListRow key={item.key} selected={selected} interactive className="p-0">
                  <button
                    ref={(node) => { buttons.current[index] = node; }}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    aria-label={`${item.categoryLabel}: ${item.name}${item.path ? `, ${item.path}` : ""}`}
                    tabIndex={item.key === focusKey ? 0 : -1}
                    onClick={() => onSelect(item)}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowUp") { event.preventDefault(); moveSelection(item, "previous"); }
                      if (event.key === "ArrowDown") { event.preventDefault(); moveSelection(item, "next"); }
                      if (event.key === "Home") { event.preventDefault(); moveSelection(item, "first"); }
                      if (event.key === "End") { event.preventDefault(); moveSelection(item, "last"); }
                    }}
                    className="flex min-h-10 min-w-0 w-full items-center gap-3 rounded-control px-3 py-2 text-left focus-ring"
                  >
                    <FileCode2 className={cn("size-3.5 shrink-0 text-muted-foreground", selected && "text-primary")} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate type-compact-strong text-foreground" title={item.name}>{item.name}</span>
                      {visiblePath ? <span className="mt-0.5 block truncate type-metadata text-muted-foreground" title={visiblePath}>{visiblePath}</span> : null}
                    </span>
                    {item.kind ? <span className="shrink-0 type-metadata text-muted-foreground">{item.kind}</span> : null}
                  </button>
                </ListRow>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
