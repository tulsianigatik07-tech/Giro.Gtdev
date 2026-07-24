import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "../../config/env.js";
import { supabase } from "../../lib/supabase.js";
import { stableHash, stableId } from "./determinism.js";
import { scheduleWorkUnits } from "./scheduler.js";
import type {
  AgentWorkUnitOutput,
  ExecutionApproval,
  ExecutionDiagnostic,
  ExecutionListPage,
  ExecutionQuotas,
  ExecutionRun,
  ReviewVerdict,
  WorkUnitLease,
  WorkUnitReview,
} from "./types.js";
import {
  ExecutionOrchestratorError,
  REPOSITORY_EXECUTION_VERSION,
} from "./types.js";
import { validateAgentOutput, verifyExecutionIntegrity } from "./validation.js";

export interface ExecutionApprovalInput {
  ownerId: string;
  repositoryId: string;
  executionId: string;
  executionVersion: string;
  repositoryRevision: string;
  idempotencyKey: string;
  workUnitIds?: string[];
}

export interface ExecutionLeaseInput {
  ownerId: string;
  repositoryId: string;
  executionId: string;
  workerId: string;
  leaseMs: number;
}

export interface ExecutionClaimInput {
  ownerId: string;
  repositoryId: string;
  executionId: string;
  workUnitId: string;
  workerId: string;
  claimToken: string;
}

export interface RepositoryExecutionStore {
  create(run: ExecutionRun, idempotencyKey: string, quotas: ExecutionQuotas): Promise<ExecutionRun>;
  get(ownerId: string, repositoryId: string, executionId: string): Promise<ExecutionRun | null>;
  list(ownerId: string, repositoryId: string, cursor?: string, limit?: number): Promise<ExecutionListPage>;
  approve(input: ExecutionApprovalInput): Promise<ExecutionRun>;
  reject(input: ExecutionApprovalInput): Promise<ExecutionRun>;
  leaseNext(input: ExecutionLeaseInput, quotas: ExecutionQuotas): Promise<WorkUnitLease | null>;
  heartbeat(input: ExecutionClaimInput, leaseMs: number): Promise<WorkUnitLease>;
  publishOutput(
    input: ExecutionClaimInput,
    output: AgentWorkUnitOutput,
    idempotencyKey: string,
    quotas: ExecutionQuotas,
  ): Promise<number>;
  submitReview(input: {
    ownerId: string;
    repositoryId: string;
    executionId: string;
    workUnitId: string;
    reviewerId: string;
    reviewerType: WorkUnitReview["reviewerType"];
    verdict: ReviewVerdict;
    findings: string[];
    requiredCorrections: string[];
    reviewedOutputVersion: number;
    idempotencyKey: string;
  }): Promise<WorkUnitReview>;
  failUnit(input: ExecutionClaimInput, code: string, message: string, retryable: boolean): Promise<void>;
  cancel(
    ownerId: string,
    repositoryId: string,
    executionId: string,
    idempotencyKey: string,
  ): Promise<ExecutionRun>;
  supersede(ownerId: string, repositoryId: string, executionId: string, reason: string): Promise<void>;
  recover(now?: Date): Promise<number>;
  collect(ownerId: string, repositoryId: string, retainedRuns?: number): Promise<number>;
  verify(): Promise<void>;
}

interface IdempotencyRecord {
  payloadHash: string;
  result: unknown;
}

const clone = <T>(value: T): T => structuredClone(value);
const terminalRuns = new Set(["succeeded", "failed", "cancelled", "superseded"]);
const terminalUnits = new Set(["succeeded", "failed", "cancelled", "skipped"]);

export class MemoryRepositoryExecutionStore implements RepositoryExecutionStore {
  private readonly runs = new Map<string, ExecutionRun>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();

  private key(ownerId: string, repositoryId: string, executionId: string): string {
    return `${ownerId}\0${repositoryId}\0${executionId}`;
  }

  private require(ownerId: string, repositoryId: string, executionId: string): ExecutionRun {
    const run = this.runs.get(this.key(ownerId, repositoryId, executionId));
    if (!run) throw new ExecutionOrchestratorError("execution_not_found", "Execution was not found.");
    return run;
  }

  private replay<T>(scope: string, idempotencyKey: string, payload: unknown, action: () => T): T {
    if (!idempotencyKey.trim()) {
      throw new ExecutionOrchestratorError("idempotency_key_required", "Idempotency key is required.");
    }
    const key = `${scope}\0${idempotencyKey}`;
    const payloadHash = stableHash(payload);
    const existing = this.idempotency.get(key);
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw new ExecutionOrchestratorError("execution_idempotency_conflict", "Idempotency payload conflicts.");
      }
      return clone(existing.result as T);
    }
    const result = action();
    this.idempotency.set(key, { payloadHash, result: clone(result) });
    return clone(result);
  }

  async create(run: ExecutionRun, idempotencyKey: string, quotas: ExecutionQuotas): Promise<ExecutionRun> {
    return this.replay(`create:${run.ownerId}:${run.repositoryId}`, idempotencyKey, {
      executionVersion: run.executionVersion,
    }, () => {
      const active = [...this.runs.values()].filter((candidate) =>
        candidate.ownerId === run.ownerId && !terminalRuns.has(candidate.status)).length;
      if (active >= quotas.activeRunsPerUser) {
        throw new ExecutionOrchestratorError("execution_active_run_quota_exceeded", "Active execution quota exceeded.", {
          limit: quotas.activeRunsPerUser,
        });
      }
      const key = this.key(run.ownerId, run.repositoryId, run.executionId);
      const existing = this.runs.get(key);
      if (existing) {
        if (existing.executionVersion !== run.executionVersion) {
          throw new ExecutionOrchestratorError("execution_version_conflict", "Execution version conflicts.");
        }
        return existing;
      }
      verifyExecutionIntegrity(run);
      this.runs.set(key, clone(run));
      return run;
    });
  }

  async get(ownerId: string, repositoryId: string, executionId: string) {
    const run = this.runs.get(this.key(ownerId, repositoryId, executionId));
    return run ? clone(run) : null;
  }

  async list(ownerId: string, repositoryId: string, cursor = "", limit = 20): Promise<ExecutionListPage> {
    const runs = [...this.runs.values()]
      .filter((run) => run.ownerId === ownerId && run.repositoryId === repositoryId &&
        (!cursor || `${run.createdAt}\0${run.executionId}` < cursor))
      .sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt) || right.executionId.localeCompare(left.executionId))
      .slice(0, Math.max(1, Math.min(100, limit)));
    const last = runs.at(-1);
    return {
      runs: clone(runs),
      nextCursor: runs.length === limit && last ? `${last.createdAt}\0${last.executionId}` : null,
    };
  }

  private approveOrReject(input: ExecutionApprovalInput, decision: "approved" | "rejected"): ExecutionRun {
    const run = this.require(input.ownerId, input.repositoryId, input.executionId);
    return this.replay(`${decision}:${run.executionId}`, input.idempotencyKey, input, () => {
      if (run.executionVersion !== input.executionVersion ||
          run.repositoryRevision !== input.repositoryRevision) {
        throw new ExecutionOrchestratorError("execution_approval_fence_rejected", "Approval targets a stale version.");
      }
      if (terminalRuns.has(run.status)) {
        throw new ExecutionOrchestratorError("execution_terminal", "Terminal execution cannot be approved.");
      }
      const ids = [...new Set(input.workUnitIds ?? run.workUnits.map((unit) => unit.workUnitId))].sort();
      if (ids.some((id) => !run.workUnits.some((unit) => unit.workUnitId === id))) {
        throw new ExecutionOrchestratorError("work_unit_not_found", "Approval contains an unknown work unit.");
      }
      const approval: ExecutionApproval = {
        approvalId: stableId("approval", { executionVersion: run.executionVersion, decision, ids, key: input.idempotencyKey }),
        scope: input.workUnitIds ? "work_units" : "run",
        workUnitIds: ids,
        decision,
        ownerId: input.ownerId,
        executionVersion: run.executionVersion,
        repositoryRevision: run.repositoryRevision,
        idempotencyKey: input.idempotencyKey,
        createdAt: new Date().toISOString(),
      };
      run.approvals.push(approval);
      run.updatedAt = approval.createdAt;
      if (decision === "rejected") {
        run.approvalState = "rejected";
        run.status = "cancelled";
        run.completedAt = approval.createdAt;
        run.workUnits = run.workUnits.map((unit) =>
          terminalUnits.has(unit.status) ? unit : { ...unit, status: "cancelled", updatedAt: approval.createdAt });
        run.leases = [];
      } else {
        const approvedIds = new Set(run.approvals.filter((item) => item.decision === "approved")
          .flatMap((item) => item.workUnitIds));
        const all = run.workUnits.every((unit) => approvedIds.has(unit.workUnitId));
        run.approvalState = all ? "approved" : "partial";
        run.status = "approved";
        run.approvedAt ??= approval.createdAt;
      }
      return run;
    });
  }

  async approve(input: ExecutionApprovalInput) {
    return clone(this.approveOrReject(input, "approved"));
  }

  async reject(input: ExecutionApprovalInput) {
    return clone(this.approveOrReject(input, "rejected"));
  }

  async leaseNext(input: ExecutionLeaseInput, quotas: ExecutionQuotas): Promise<WorkUnitLease | null> {
    const run = this.require(input.ownerId, input.repositoryId, input.executionId);
    if (terminalRuns.has(run.status)) return null;
    if (!["approved", "running"].includes(run.status) ||
        !["approved", "partial"].includes(run.approvalState)) {
      throw new ExecutionOrchestratorError("execution_approval_required", "Execution requires approval.");
    }
    if (run.policy === "review_only" || run.policy === "dry_run") {
      throw new ExecutionOrchestratorError("execution_policy_disallows_leasing", "Policy does not permit agent leasing.");
    }
    if (Date.now() - Date.parse(run.createdAt) >= quotas.executionDurationMs) {
      run.status = "failed";
      run.completedAt = new Date().toISOString();
      run.diagnostics.push({
        code: "execution_duration_quota_exceeded",
        message: "Execution exceeded its configured duration.",
        createdAt: run.completedAt,
      });
      throw new ExecutionOrchestratorError("execution_duration_quota_exceeded", "Execution duration quota exceeded.");
    }
    const activeLeases = [...this.runs.values()].filter((candidate) => candidate.ownerId === input.ownerId)
      .flatMap((candidate) => candidate.leases)
      .filter((lease) => Date.parse(lease.leaseExpiresAt) > Date.now()).length;
    if (activeLeases >= quotas.concurrentLeasesPerUser) {
      throw new ExecutionOrchestratorError("execution_lease_quota_exceeded", "Concurrent lease quota exceeded.", {
        limit: quotas.concurrentLeasesPerUser,
      });
    }
    run.workUnits = scheduleWorkUnits(run.workUnits);
    const approvedIds = new Set(run.approvals.filter((approval) => approval.decision === "approved")
      .flatMap((approval) => approval.workUnitIds));
    const unit = run.workUnits.filter((candidate) =>
      candidate.status === "ready" && approvedIds.has(candidate.workUnitId))
      .sort((left, right) =>
        Number(run.criticalPath.includes(right.workUnitId)) - Number(run.criticalPath.includes(left.workUnitId)) ||
        left.order - right.order || left.workUnitId.localeCompare(right.workUnitId))[0];
    if (!unit) return null;
    if (unit.attempt >= unit.retryPolicy.maxAttempts) {
      unit.status = "failed";
      this.refresh(run);
      return null;
    }
    const now = new Date();
    const lease: WorkUnitLease = {
      workUnitId: unit.workUnitId,
      workerId: input.workerId,
      claimToken: randomUUID(),
      attempt: unit.attempt + 1,
      claimedAt: now.toISOString(),
      heartbeatAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + input.leaseMs).toISOString(),
    };
    unit.status = "leased";
    unit.attempt = lease.attempt;
    unit.updatedAt = lease.claimedAt;
    run.leases = run.leases.filter((candidate) => candidate.workUnitId !== unit.workUnitId);
    run.leases.push(lease);
    run.status = "running";
    run.startedAt ??= lease.claimedAt;
    run.updatedAt = lease.claimedAt;
    return clone(lease);
  }

  private fenced(input: ExecutionClaimInput): { run: ExecutionRun; lease: WorkUnitLease; unitIndex: number } {
    const run = this.require(input.ownerId, input.repositoryId, input.executionId);
    const lease = run.leases.find((candidate) =>
      candidate.workUnitId === input.workUnitId &&
      candidate.workerId === input.workerId &&
      candidate.claimToken === input.claimToken);
    const unitIndex = run.workUnits.findIndex((unit) => unit.workUnitId === input.workUnitId);
    if (!lease || unitIndex < 0 || Date.parse(lease.leaseExpiresAt) <= Date.now()) {
      throw new ExecutionOrchestratorError("execution_claim_fence_rejected", "Lease claim token is stale.");
    }
    return { run, lease, unitIndex };
  }

  async heartbeat(input: ExecutionClaimInput, leaseMs: number): Promise<WorkUnitLease> {
    const { run, lease, unitIndex } = this.fenced(input);
    const now = new Date();
    lease.heartbeatAt = now.toISOString();
    lease.leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
    const unit = run.workUnits[unitIndex]!;
    unit.status = "running";
    unit.updatedAt = lease.heartbeatAt;
    run.updatedAt = lease.heartbeatAt;
    return clone(lease);
  }

  async publishOutput(
    input: ExecutionClaimInput,
    output: AgentWorkUnitOutput,
    idempotencyKey: string,
    quotas: ExecutionQuotas,
  ): Promise<number> {
    validateAgentOutput(output, quotas.outputBytes);
    const run = this.require(input.ownerId, input.repositoryId, input.executionId);
    return this.replay(`output:${run.executionId}:${input.workUnitId}`, idempotencyKey, output, () => {
      const { lease, unitIndex } = this.fenced(input);
      const unit = run.workUnits[unitIndex]!;
      const outputVersion = unit.outputVersion + 1;
      run.outputs.push({
        workUnitId: input.workUnitId,
        outputVersion,
        attempt: lease.attempt,
        workerId: input.workerId,
        payloadHash: stableHash(output),
        output: clone(output),
        createdAt: new Date().toISOString(),
      });
      unit.outputVersion = outputVersion;
      unit.status = run.policy === "agent_assisted" || run.policy === "guarded_execution"
        ? "awaiting_review"
        : output.completionStatus === "completed" ? "succeeded" : "failed";
      unit.updatedAt = new Date().toISOString();
      run.leases = run.leases.filter((candidate) => candidate.workUnitId !== unit.workUnitId);
      this.refresh(run);
      return outputVersion;
    });
  }

  async submitReview(input: {
    ownerId: string; repositoryId: string; executionId: string; workUnitId: string;
    reviewerId: string; reviewerType: WorkUnitReview["reviewerType"]; verdict: ReviewVerdict;
    findings: string[]; requiredCorrections: string[]; reviewedOutputVersion: number; idempotencyKey: string;
  }): Promise<WorkUnitReview> {
    const run = this.require(input.ownerId, input.repositoryId, input.executionId);
    return this.replay(`review:${run.executionId}:${input.workUnitId}`, input.idempotencyKey, input, () => {
      const unit = run.workUnits.find((candidate) => candidate.workUnitId === input.workUnitId);
      if (!unit || unit.status !== "awaiting_review") {
        throw new ExecutionOrchestratorError("work_unit_not_awaiting_review", "Work unit is not awaiting review.");
      }
      if (unit.outputVersion !== input.reviewedOutputVersion) {
        throw new ExecutionOrchestratorError("stale_output_review", "Review targets a stale output version.");
      }
      const review: WorkUnitReview = {
        reviewId: stableId("review", { executionId: run.executionId, unit: unit.workUnitId, key: input.idempotencyKey }),
        workUnitId: unit.workUnitId,
        reviewerId: input.reviewerId,
        reviewerType: input.reviewerType,
        verdict: input.verdict,
        findings: [...input.findings],
        requiredCorrections: [...input.requiredCorrections],
        reviewedOutputVersion: input.reviewedOutputVersion,
        idempotencyKey: input.idempotencyKey,
        createdAt: new Date().toISOString(),
      };
      run.reviews.push(review);
      unit.status = input.verdict === "approved" ? "succeeded"
        : input.verdict === "skipped" ? "skipped"
        : input.verdict === "changes_requested" && unit.attempt < unit.retryPolicy.maxAttempts ? "ready"
        : "failed";
      unit.updatedAt = review.createdAt;
      this.refresh(run);
      return review;
    });
  }

  async failUnit(input: ExecutionClaimInput, code: string, message: string, retryable: boolean): Promise<void> {
    const { run, unitIndex } = this.fenced(input);
    const unit = run.workUnits[unitIndex]!;
    const canRetry = retryable && unit.retryPolicy.retryableFailureCodes.includes(code) &&
      unit.attempt < unit.retryPolicy.maxAttempts;
    unit.status = canRetry ? "ready" : "failed";
    unit.updatedAt = new Date().toISOString();
    run.leases = run.leases.filter((lease) => lease.workUnitId !== unit.workUnitId);
    run.diagnostics.push({
      code,
      message,
      workUnitId: unit.workUnitId,
      createdAt: unit.updatedAt,
    });
    this.refresh(run);
  }

  async cancel(ownerId: string, repositoryId: string, executionId: string, idempotencyKey: string) {
    const run = this.require(ownerId, repositoryId, executionId);
    return this.replay(`cancel:${executionId}`, idempotencyKey, { executionId }, () => {
      if (terminalRuns.has(run.status)) return run;
      const now = new Date().toISOString();
      run.status = "cancelled";
      run.completedAt = now;
      run.updatedAt = now;
      run.leases = [];
      run.workUnits = run.workUnits.map((unit) =>
        terminalUnits.has(unit.status) ? unit : { ...unit, status: "cancelled", updatedAt: now });
      return run;
    });
  }

  async supersede(ownerId: string, repositoryId: string, executionId: string, reason: string): Promise<void> {
    const run = this.require(ownerId, repositoryId, executionId);
    if (terminalRuns.has(run.status)) return;
    const now = new Date().toISOString();
    run.status = "superseded";
    run.completedAt = now;
    run.updatedAt = now;
    run.leases = [];
    run.workUnits = run.workUnits.map((unit) =>
      terminalUnits.has(unit.status) ? unit : { ...unit, status: "cancelled", updatedAt: now });
    run.diagnostics.push({ code: "execution_superseded", message: reason, createdAt: now });
  }

  async recover(now = new Date()): Promise<number> {
    let recovered = 0;
    for (const run of this.runs.values()) {
      if (terminalRuns.has(run.status)) continue;
      for (const lease of [...run.leases]) {
        if (Date.parse(lease.leaseExpiresAt) > now.getTime()) continue;
        const unit = run.workUnits.find((candidate) => candidate.workUnitId === lease.workUnitId);
        if (!unit) continue;
        unit.status = unit.attempt < unit.retryPolicy.maxAttempts ? "ready" : "failed";
        unit.updatedAt = now.toISOString();
        run.leases = run.leases.filter((candidate) => candidate.claimToken !== lease.claimToken);
        run.diagnostics.push({
          code: "stale_lease_recovered",
          message: "Expired work-unit lease was recovered.",
          workUnitId: unit.workUnitId,
          createdAt: now.toISOString(),
        });
        recovered += 1;
      }
      this.refresh(run);
    }
    return recovered;
  }

  async collect(ownerId: string, repositoryId: string, retainedRuns = env.EXECUTION_RETAINED_RUNS): Promise<number> {
    const candidates = [...this.runs.entries()].filter(([, run]) =>
      run.ownerId === ownerId && run.repositoryId === repositoryId && terminalRuns.has(run.status))
      .sort((left, right) => right[1].createdAt.localeCompare(left[1].createdAt));
    let removed = 0;
    for (const [key] of candidates.slice(Math.max(1, retainedRuns))) {
      this.runs.delete(key);
      removed += 1;
    }
    return removed;
  }

  async verify(): Promise<void> {
    for (const run of this.runs.values()) {
      if (run.orchestratorVersion !== REPOSITORY_EXECUTION_VERSION) {
        throw new ExecutionOrchestratorError("execution_version_incompatible", "Execution version is incompatible.");
      }
      verifyExecutionIntegrity(run);
    }
  }

  private refresh(run: ExecutionRun): void {
    run.workUnits = scheduleWorkUnits(run.workUnits);
    const now = new Date().toISOString();
    run.updatedAt = now;
    if (run.workUnits.some((unit) => unit.status === "failed")) {
      run.status = "failed";
      run.completedAt = now;
    } else if (run.workUnits.length > 0 &&
        run.workUnits.every((unit) => unit.status === "succeeded" || unit.status === "skipped")) {
      run.status = "succeeded";
      run.completedAt = now;
    } else if (run.leases.length > 0 || run.workUnits.some((unit) =>
      ["leased", "running", "awaiting_review"].includes(unit.status))) {
      run.status = "running";
    } else if (run.approvalState === "approved") {
      run.status = "approved";
    }
  }
}

interface RpcQuery extends PromiseLike<{ data: unknown; error: { message?: string } | null }> {
  abortSignal?(signal: AbortSignal): RpcQuery;
}
interface DatabaseClient { rpc(name: string, parameters?: Record<string, unknown>): RpcQuery }
const first = (data: unknown): Record<string, unknown> | null =>
  Array.isArray(data) ? data[0] as Record<string, unknown> | undefined ?? null
    : data && typeof data === "object" ? data as Record<string, unknown> : null;
const rpcError = (error: { message?: string } | null, fallback: string) => {
  if (error) throw new ExecutionOrchestratorError("execution_storage_error", error.message ?? fallback);
};
function leaseFromRow(row: Record<string, unknown> | null): WorkUnitLease | null {
  if (!row) return null;
  return {
    workUnitId: String(row.workUnitId ?? row.work_unit_id),
    workerId: String(row.workerId ?? row.worker_id),
    claimToken: String(row.claimToken ?? row.claim_token),
    attempt: Number(row.attempt),
    claimedAt: String(row.claimedAt ?? row.claimed_at),
    heartbeatAt: String(row.heartbeatAt ?? row.heartbeat_at),
    leaseExpiresAt: String(row.leaseExpiresAt ?? row.lease_expires_at),
  };
}

export class SupabaseRepositoryExecutionStore implements RepositoryExecutionStore {
  constructor(private readonly client: DatabaseClient | SupabaseClient) {}
  private async call(name: string, parameters: Record<string, unknown> = {}) {
    const result = await (this.client as DatabaseClient).rpc(name, parameters);
    rpcError(result.error, name);
    return result.data;
  }
  async create(run: ExecutionRun, idempotencyKey: string, quotas: ExecutionQuotas) {
    const data = await this.call("create_repository_execution", {
      input_run: run, input_idempotency_key: idempotencyKey,
      input_max_active_runs: quotas.activeRunsPerUser,
    });
    return clone((first(data)?.run ?? data) as ExecutionRun);
  }
  async get(ownerId: string, repositoryId: string, executionId: string) {
    const data = await this.call("get_repository_execution", {
      input_owner_id: ownerId, input_repository_id: repositoryId, input_execution_id: executionId,
    });
    return first(data) ? clone((first(data)?.run ?? first(data)) as ExecutionRun) : null;
  }
  async list(ownerId: string, repositoryId: string, cursor = "", limit = 20) {
    const data = await this.call("list_repository_executions", {
      input_owner_id: ownerId, input_repository_id: repositoryId, input_cursor: cursor, input_limit: limit,
    });
    const row = first(data);
    return { runs: clone((row?.runs ?? []) as ExecutionRun[]), nextCursor: row?.next_cursor as string ?? null };
  }
  async approve(input: ExecutionApprovalInput) {
    return this.mutate("approve_repository_execution", input);
  }
  async reject(input: ExecutionApprovalInput) {
    return this.mutate("reject_repository_execution", input);
  }
  private async mutate(name: string, input: ExecutionApprovalInput) {
    const data = await this.call(name, {
      input_owner_id: input.ownerId, input_repository_id: input.repositoryId,
      input_execution_id: input.executionId, input_execution_version: input.executionVersion,
      input_repository_revision: input.repositoryRevision, input_idempotency_key: input.idempotencyKey,
      input_work_unit_ids: input.workUnitIds ?? null,
    });
    return clone((first(data)?.run ?? data) as ExecutionRun);
  }
  async leaseNext(input: ExecutionLeaseInput, quotas: ExecutionQuotas) {
    const data = await this.call("lease_repository_execution_work_unit", {
      input_owner_id: input.ownerId, input_repository_id: input.repositoryId,
      input_execution_id: input.executionId, input_worker_id: input.workerId,
      input_lease_ms: input.leaseMs, input_max_concurrent_leases: quotas.concurrentLeasesPerUser,
    });
    return leaseFromRow(first(data));
  }
  async heartbeat(input: ExecutionClaimInput, leaseMs: number) {
    const data = await this.call("heartbeat_repository_execution_work_unit", {
      ...this.claimParameters(input), input_lease_ms: leaseMs,
    });
    const lease = leaseFromRow(first(data));
    if (!lease) throw new ExecutionOrchestratorError("execution_claim_fence_rejected", "Lease was not updated.");
    return lease;
  }
  async publishOutput(input: ExecutionClaimInput, output: AgentWorkUnitOutput, idempotencyKey: string, quotas: ExecutionQuotas) {
    validateAgentOutput(output, quotas.outputBytes);
    const data = await this.call("publish_repository_execution_output", {
      ...this.claimParameters(input), input_output: output,
      input_idempotency_key: idempotencyKey, input_max_output_bytes: quotas.outputBytes,
    });
    return Number(first(data)?.output_version ?? data);
  }
  async submitReview(input: {
    ownerId: string; repositoryId: string; executionId: string; workUnitId: string;
    reviewerId: string; reviewerType: WorkUnitReview["reviewerType"]; verdict: ReviewVerdict;
    findings: string[]; requiredCorrections: string[]; reviewedOutputVersion: number; idempotencyKey: string;
  }) {
    const data = await this.call("submit_repository_execution_review", {
      input_owner_id: input.ownerId, input_repository_id: input.repositoryId,
      input_execution_id: input.executionId, input_work_unit_id: input.workUnitId,
      input_reviewer_id: input.reviewerId, input_reviewer_type: input.reviewerType,
      input_verdict: input.verdict, input_findings: input.findings,
      input_required_corrections: input.requiredCorrections,
      input_reviewed_output_version: input.reviewedOutputVersion,
      input_idempotency_key: input.idempotencyKey,
    });
    return clone((first(data)?.review ?? data) as WorkUnitReview);
  }
  async failUnit(input: ExecutionClaimInput, code: string, message: string, retryable: boolean) {
    await this.call("fail_repository_execution_work_unit", {
      ...this.claimParameters(input), input_code: code, input_message: message, input_retryable: retryable,
    });
  }
  async cancel(ownerId: string, repositoryId: string, executionId: string, idempotencyKey: string) {
    const data = await this.call("cancel_repository_execution", {
      input_owner_id: ownerId, input_repository_id: repositoryId,
      input_execution_id: executionId, input_idempotency_key: idempotencyKey,
    });
    return clone((first(data)?.run ?? data) as ExecutionRun);
  }
  async supersede(ownerId: string, repositoryId: string, executionId: string, reason: string) {
    await this.call("supersede_repository_execution", {
      input_owner_id: ownerId, input_repository_id: repositoryId,
      input_execution_id: executionId, input_reason: reason,
    });
  }
  async recover(now = new Date()) {
    const data = await this.call("recover_repository_execution_leases", { input_expired_before: now.toISOString() });
    return Number(first(data)?.recovered_count ?? data ?? 0);
  }
  async collect(ownerId: string, repositoryId: string, retainedRuns = env.EXECUTION_RETAINED_RUNS) {
    const data = await this.call("collect_repository_executions", {
      input_owner_id: ownerId, input_repository_id: repositoryId, input_retained_runs: retainedRuns,
    });
    return Number(first(data)?.deleted_count ?? data ?? 0);
  }
  async verify() {
    const data = await this.call("verify_repository_execution_contract", {
      input_orchestrator_version: REPOSITORY_EXECUTION_VERSION,
      input_guarded_execution_enabled: env.GUARDED_EXECUTION_ENABLED,
      input_retained_runs: env.EXECUTION_RETAINED_RUNS,
    });
    if (first(data)?.valid !== true && data !== true) {
      throw new ExecutionOrchestratorError("execution_startup_validation_failed", "Execution contract is invalid.");
    }
  }
  private claimParameters(input: ExecutionClaimInput) {
    return {
      input_owner_id: input.ownerId, input_repository_id: input.repositoryId,
      input_execution_id: input.executionId, input_work_unit_id: input.workUnitId,
      input_worker_id: input.workerId, input_claim_token: input.claimToken,
    };
  }
}

export const runtimeRepositoryExecutionStore: RepositoryExecutionStore =
  new SupabaseRepositoryExecutionStore(supabase);
