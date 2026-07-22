import { createHash } from "node:crypto";
import type { IndexingJob } from "../../indexing/jobs/indexingJobStore.js";

export interface RepositoryConnectionResponse {
  repositoryId: string;
  jobId: string;
  status: "queued";
}

export interface ConnectRepositoryTransactionInput {
  idempotencyKey: string;
  payloadHash: string;
  ownerUserId: string;
  repositoryOwner: string;
  repositoryName: string;
  repositoryUrl: string;
  branch: string | null;
  requestId: string;
  traceparent: string | null;
  signal?: AbortSignal;
}

export interface RepositoryConnectionTransactionResult {
  response: RepositoryConnectionResponse;
  job: IndexingJob;
  replayed: boolean;
}

export interface RepositoryConnectionStore {
  connect(input: ConnectRepositoryTransactionInput): Promise<RepositoryConnectionTransactionResult>;
  cleanupExpired(signal?: AbortSignal): Promise<number>;
  verify(signal?: AbortSignal): Promise<void>;
}

export class RepositoryConnectionIdempotencyConflictError extends Error {
  readonly code = "idempotency_conflict";
  constructor() {
    super("The idempotency key was already used with a different repository connection payload.");
    this.name = "RepositoryConnectionIdempotencyConflictError";
  }
}

export function repositoryConnectionPayloadHash(input: {
  ownerUserId: string;
  repositoryOwner: string;
  repositoryName: string;
  repositoryUrl: string;
  branch: string | null;
}): string {
  return createHash("sha256").update(JSON.stringify({
    ownerUserId: input.ownerUserId,
    repositoryOwner: input.repositoryOwner,
    repositoryName: input.repositoryName,
    repositoryUrl: input.repositoryUrl,
    branch: input.branch,
  })).digest("hex");
}

export function throwIfConnectionAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}
