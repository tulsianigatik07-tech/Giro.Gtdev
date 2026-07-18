import type { Metadata } from "next";
import { RepositorySearch } from "@/features/repositories/repository-search";

export const metadata: Metadata = { title: "Search repository" };

export default async function RepositorySearchPage({ params }: { params: Promise<{ owner: string; repo: string }> }) {
  const { owner, repo } = await params;
  return <RepositorySearch owner={decodeURIComponent(owner)} repo={decodeURIComponent(repo)} />;
}
