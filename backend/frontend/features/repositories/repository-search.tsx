"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { SearchInput } from "@/components/ui/form-controls";
import { InlineAlert } from "@/components/ui/inline-alert";
import { LoadingState } from "@/components/ui/data-display";
import { MAX_REPOSITORY_SEARCH_QUERY_LENGTH, useRepositorySearch } from "@/hooks/use-repository-search";

export function RepositorySearch({ owner, repo }: { owner: string; repo: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const submittedQuery = searchParams.get("q") ?? "";
  const [draft, setDraft] = useState(submittedQuery);
  const search = useRepositorySearch(owner, repo, submittedQuery);
  const repositoryPath = `/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  useEffect(() => setDraft(submittedQuery), [submittedQuery]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextSearchParams = new URLSearchParams(searchParams.toString());
    const normalizedDraft = draft.trim();
    if (normalizedDraft) nextSearchParams.set("q", normalizedDraft);
    else nextSearchParams.delete("q");
    const suffix = nextSearchParams.toString();
    router.push(`${repositoryPath}/search${suffix ? `?${suffix}` : ""}`, { scroll: false });
  }

  const reconnect = search.repositoryStatus.label === "Failed" || search.repositoryStatus.label === "Disconnected";
  const readinessHref = reconnect ? "/repositories/connect" : `${repositoryPath}/indexing`;
  const readinessAction = reconnect ? "Connect repository" : "View indexing";

  return (
    <div className="layout-standard layout-gutter py-10 max-[820px]:py-8">
      <header className="border-b border-border-subtle pb-6">
        <p className="type-section-eyebrow text-muted-foreground">{owner}/{repo}</p>
        <h1 className="mt-2 type-page-title">Search <span className="italic text-primary">repository</span><span className="not-italic">.</span></h1>
        <p className="mt-2 max-w-[68ch] type-body text-text-secondary">Search indexed repository context without creating a chat session or generating an answer.</p>
      </header>

      <form onSubmit={submit} className="mt-7 flex max-w-[680px] items-start gap-2">
        <label htmlFor="repository-search-query" className="sr-only">Search repository</label>
        <div className="min-w-0 flex-1"><SearchInput
            id="repository-search-query"
            name="q"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onClear={() => setDraft("")}
            maxLength={MAX_REPOSITORY_SEARCH_QUERY_LENGTH}
            placeholder="Search repository context…"
          /></div>
        <Button type="submit" variant="accent"><Search className="size-4" />Search</Button>
      </form>

      <div className="mt-7" aria-live="polite">
        {search.checkingReadiness ? <LoadingState label="Checking repository readiness…" /> : null}
        {!search.checkingReadiness && search.error ? <ErrorState error={search.error} retry={search.retry ? () => void search.retry?.() : undefined} /> : null}
        {!search.checkingReadiness && !search.error && !search.ready ? <InlineAlert tone={search.repositoryStatus.label === "Failed" ? "danger" : "warning"}><div className="flex flex-wrap items-center gap-3"><div className="min-w-0 flex-1"><p className="type-compact-strong">{search.repositoryStatus.label} repository</p><p className="mt-1">{search.repositoryStatus.label === "Failed" ? "Indexing failed. Reconnect the repository before searching." : search.repositoryStatus.label === "Stale" ? "Repository evidence is stale. Reindex before searching." : "Repository intelligence must be ready before searching."}</p></div><Button asChild variant="secondary" size="sm"><Link href={readinessHref}>{readinessAction}<ArrowRight className="size-3.5" /></Link></Button></div></InlineAlert> : null}
        {!search.checkingReadiness && search.ready && search.loading ? <LoadingState label={`Searching ${owner}/${repo}…`} /> : null}
        {!search.checkingReadiness && search.ready && search.success ? <InlineAlert tone="info">Repository search completed.</InlineAlert> : null}
        {!search.checkingReadiness && search.ready && search.idle && !search.query ? <EmptyState icon={Search} title="Search indexed repository context" description="Submit a repository question or technical concept to run repository-scoped retrieval. Search does not create a chat session or generate an answer." /> : null}
      </div>
    </div>
  );
}
