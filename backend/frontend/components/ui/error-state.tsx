import { AlertTriangle, RotateCcw } from "lucide-react";
import { Button } from "./button";
import { ApiClientError, getApiErrorMessage } from "@/services/api/client";

export function ErrorState({ error, retry, compact = false }: { error: unknown; retry?: () => void; compact?: boolean }) {
  const normalized = error instanceof ApiClientError ? error : null;
  return (
    <div role="alert" className={`rounded-lg border border-red-500/20 bg-red-500/5 ${compact ? "p-3" : "p-6"}`}>
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-300" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-red-200">Unable to load</p>
          <p className="mt-1 text-sm text-red-200/70">{getApiErrorMessage(error)}</p>
          {normalized?.fieldErrors ? <ul className="mt-2 space-y-1 text-xs text-red-200/70">{Object.entries(normalized.fieldErrors).flatMap(([field, messages]) => messages.map((message) => <li key={`${field}-${message}`}>{field}: {message}</li>))}</ul> : null}
          {normalized?.requestId ? <details className="mt-3 text-xs text-red-200/60"><summary className="cursor-pointer">Technical details</summary><p className="mt-1 font-mono">Request ID: {normalized.requestId}</p></details> : null}
        </div>
        {retry ? <Button variant="ghost" size="sm" onClick={retry}><RotateCcw className="size-3.5" />Retry</Button> : null}
      </div>
    </div>
  );
}
