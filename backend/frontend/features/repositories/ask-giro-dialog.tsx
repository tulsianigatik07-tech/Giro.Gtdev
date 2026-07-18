"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { Radio } from "@/components/ui/form-controls";
import { Modal } from "@/components/ui/overlays";
import { useCreateSession, useSessions } from "@/hooks/use-sessions";
import type { RepositoryExplorerItem, RepositoryExplorerTab } from "@/lib/repository-explorer";
import type { RetrievalResult } from "@/types/api";

export type AskGiroTarget =
  | {
      kind: "repository-item";
      item: RepositoryExplorerItem;
      location:
        | { kind: "explorer"; tab: RepositoryExplorerTab }
        | { kind: "search"; query: string; resultKey: string };
    }
  | {
      kind: "indexed-evidence";
      result: RetrievalResult;
      query: string;
      resultKey: string;
    };

export function AskGiroDialog({
  open,
  owner,
  repo,
  target,
  onClose,
}: {
  open: boolean;
  owner: string;
  repo: string;
  target: AskGiroTarget;
  onClose(): void;
}) {
  const router = useRouter();
  const sessions = useSessions();
  const create = useCreateSession();
  const [choice, setChoice] = useState<string | null>(null);
  const inFlight = useRef(false);
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => () => {
    openRef.current = false;
  }, []);
  const repositorySessions =
    sessions.data?.sessions.filter((session) => session.owner === owner && session.repo === repo) ?? [];

  async function continueToSession() {
    if (!choice || inFlight.current || create.isPending) return;
    inFlight.current = true;

    if (choice.startsWith("session:")) {
      const sessionId = choice.slice("session:".length);
      const session = repositorySessions.find((candidate) => candidate.id === sessionId);
      if (!session) {
        inFlight.current = false;
        return;
      }
      if (openRef.current) router.push(chatHandoffUrl(session.id, owner, repo, target));
      return;
    }

    try {
      const session = await create.mutateAsync({
        owner,
        repo,
        title: askGiroSessionTitle(target),
      });
      if (openRef.current) router.push(chatHandoffUrl(session.id, owner, repo, target));
    } catch {
      inFlight.current = false;
    }
  }

  return (
    <Modal
      open={open}
      title="Ask Giro about this"
      description={`Choose a session for ${owner}/${repo}. Nothing will be submitted yet.`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void continueToSession()} disabled={!choice || create.isPending}>
            {create.isPending ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" /> : null}
            {create.isPending ? "Creating…" : "Continue"}
          </Button>
        </>
      }
    >
      <fieldset disabled={create.isPending}>
        <legend className="type-compact-strong">Continue in</legend>
        {sessions.isLoading ? <p role="status" aria-live="polite" className="mt-3 type-compact text-muted-foreground">Loading repository sessions…</p> : null}
        {sessions.isError ? <div className="mt-3"><ErrorState error={sessions.error} retry={() => void sessions.refetch()} compact /></div> : null}
        {!sessions.isLoading && !sessions.isError ? (
          <div className="mt-3 divide-y divide-border-subtle border-y border-border-subtle">
            {repositorySessions.map((session) => (
              <Radio
                key={session.id}
                name="ask-giro-session"
                value={`session:${session.id}`}
                checked={choice === `session:${session.id}`}
                onChange={(event) => setChoice(event.currentTarget.value)}
                label={session.title}
                description={`${session.messageCount} messages`}
                className="px-3 py-2"
              />
            ))}
            {repositorySessions.length === 0 ? <p className="px-3 py-3 type-compact text-muted-foreground">No sessions exist for this repository.</p> : null}
            <Radio
              name="ask-giro-session"
              value="new"
              checked={choice === "new"}
              onChange={(event) => setChoice(event.currentTarget.value)}
              label="New session"
              description="Create an empty repository-scoped session."
              className="px-3 py-2"
            />
          </div>
        ) : null}
      </fieldset>
      {create.isPending ? <p role="status" aria-live="polite" className="mt-3 type-compact text-muted-foreground">Creating repository session…</p> : null}
      {create.isError ? <div className="mt-3"><ErrorState error={create.error} compact /></div> : null}
    </Modal>
  );
}

export function askGiroSessionTitle(target: AskGiroTarget): string {
  if (target.kind === "repository-item") return target.item.name;
  return target.result.symbol ?? target.result.filePath;
}

export function askGiroDraft(target: AskGiroTarget): string {
  if (target.kind === "indexed-evidence") {
    if (target.result.symbol) return `Explain how ${target.result.symbol} in ${target.result.filePath} works.`;
    return `Explain the code in ${target.result.filePath}, lines ${target.result.startLine}-${target.result.endLine}.`;
  }

  if (target.item.category === "entrypoints" && target.item.path) {
    return `Explain how execution begins at ${target.item.path}.`;
  }
  if (["centralModules", "dependencyHotspots", "circularDependencies"].includes(target.item.category)) {
    return `Explain why ${target.item.name} is important.`;
  }
  if (target.item.path) return `Explain how ${target.item.name} in ${target.item.path} works.`;
  return `Explain why ${target.item.name} is important.`;
}

export function chatHandoffUrl(sessionId: string, owner: string, repo: string, target: AskGiroTarget): string {
  const originParams = new URLSearchParams();
  const repositoryPath = `/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  let originPath = repositoryPath;
  if (target.kind === "repository-item") {
    if (target.location.kind === "explorer") {
      originParams.set("tab", target.location.tab);
      originParams.set("category", target.item.category);
      originParams.set("item", target.item.key);
    } else {
      originPath = `${repositoryPath}/search`;
      originParams.set("q", target.location.query);
      originParams.set("result", target.location.resultKey);
    }
  } else {
    originPath = `${repositoryPath}/search`;
    originParams.set("q", target.query);
    originParams.set("result", target.resultKey);
  }
  const originQuery = originParams.toString();
  const params = new URLSearchParams({
    draft: askGiroDraft(target),
    from: `${originPath}${originQuery ? `?${originQuery}` : ""}`,
  });
  return `/chat/${encodeURIComponent(sessionId)}?${params.toString()}`;
}
