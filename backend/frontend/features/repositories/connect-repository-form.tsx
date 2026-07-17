"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Github, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConnectRepository } from "@/hooks/use-repositories";
import { getApiErrorMessage } from "@/services/api/client";

export function validateGitHubUrl(value: string): string | null {
  const input = value.trim();
  try {
    const url = new URL(input);
    const segments = url.pathname.replace(/\.git$/, "").split("/").filter(Boolean);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || segments.length !== 2) throw new Error();
    return null;
  } catch {
    return "Enter a full GitHub URL such as https://github.com/owner/repository.";
  }
}

export function ConnectRepositoryForm() {
  const router = useRouter();
  const connect = useConnectRepository();
  const [url, setUrl] = useState("");
  const [validation, setValidation] = useState<string | null>(null);
  const submissionInFlight = useRef(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const issue = validateGitHubUrl(url);
    setValidation(issue);
    if (issue || submissionInFlight.current) return;
    submissionInFlight.current = true;
    try {
      const result = await connect.mutateAsync(url.trim());
      const [owner, repo] = result.repositoryId.split("/");
      const repositoryPath = `/repositories/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(repo ?? "")}`;
      if (result.status === "already_indexed") {
        router.push(repositoryPath);
        return;
      }
      router.push(`${repositoryPath}/indexing?jobId=${encodeURIComponent(result.jobId ?? "")}`);
    } catch {
      // The mutation error is rendered below.
    } finally {
      submissionInFlight.current = false;
    }
  }

  const error = validation ?? (connect.error ? getApiErrorMessage(connect.error) : null);
  return (
    <form onSubmit={submit} noValidate className="mt-8 space-y-5">
      <div><label htmlFor="repo-url" className="mb-2 block text-xs font-medium text-muted-foreground">GitHub repository URL</label><div className="relative"><Github className="absolute left-3 top-3 size-4 text-muted-foreground" /><Input id="repo-url" value={url} onChange={(event) => { setUrl(event.target.value); setValidation(null); }} placeholder="https://github.com/owner/repository" className="pl-9" aria-invalid={Boolean(error)} aria-describedby="repo-url-help" autoFocus /></div><p id="repo-url-help" role={error ? "alert" : undefined} className={`mt-2 text-xs ${error ? "text-red-300" : "text-muted-foreground"}`}>{error ?? "The backend will clone and index this repository using your existing access."}</p></div>
      <Button disabled={connect.isPending} className="w-full sm:w-auto">{connect.isPending ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" /> : <ArrowRight className="size-4" />}{connect.isPending ? "Connecting…" : "Connect and index"}</Button>
    </form>
  );
}
