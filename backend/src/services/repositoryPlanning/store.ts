import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "../../config/env.js";
import { supabase } from "../../lib/supabase.js";
import type {
  RepositoryExecutionPlan,
  RepositoryPlanDiagnostic,
  RepositoryPlanIdentity,
  RepositoryPlanRecord,
  RepositoryPlanValidation,
  RepositoryPlanValidationContext,
} from "./types.js";
import { REPOSITORY_PLANNER_VERSION } from "./types.js";
import { validateRepositoryPlan, verifyPlanPublicationIntegrity } from "./validation.js";

export interface BeginRepositoryPlanResult {
  alreadyPublished: boolean;
  planVersion: string;
}

export interface RepositoryPlanningStore {
  begin(identity: RepositoryPlanIdentity, signal?: AbortSignal): Promise<BeginRepositoryPlanResult>;
  stage(
    plan: RepositoryExecutionPlan,
    context: RepositoryPlanValidationContext,
    signal?: AbortSignal,
  ): Promise<void>;
  validate(planVersion: string, signal?: AbortSignal): Promise<RepositoryPlanValidation>;
  publish(planVersion: string, signal?: AbortSignal): Promise<void>;
  fail(
    planVersion: string,
    diagnostics: readonly RepositoryPlanDiagnostic[],
    signal?: AbortSignal,
  ): Promise<void>;
  loadPublished(
    repositoryId: string,
    taskHash: string,
    signal?: AbortSignal,
  ): Promise<RepositoryPlanRecord | null>;
  collect(
    repositoryId: string,
    taskHash: string,
    retentionCount?: number,
    signal?: AbortSignal,
  ): Promise<number>;
  recover(signal?: AbortSignal): Promise<number>;
  verify(signal?: AbortSignal): Promise<void>;
}

interface MemoryPlanVersion {
  identity: RepositoryPlanIdentity;
  record: RepositoryPlanRecord | null;
  context: RepositoryPlanValidationContext | null;
  validation: RepositoryPlanValidation | null;
  diagnostics: RepositoryPlanDiagnostic[];
  status: RepositoryPlanRecord["status"];
  publicationOrder: number | null;
}

const clone = <T>(value: T): T => structuredClone(value);
const publicationKey = (repositoryId: string, taskHash: string) => `${repositoryId}\0${taskHash}`;

export class MemoryRepositoryPlanningStore implements RepositoryPlanningStore {
  private readonly versions = new Map<string, MemoryPlanVersion>();
  private readonly publications = new Map<string, string>();
  private order = 0;

  async begin(identity: RepositoryPlanIdentity): Promise<BeginRepositoryPlanResult> {
    const current = this.publications.get(publicationKey(identity.repositoryId, identity.taskHash));
    if (current === identity.planVersion && this.versions.get(current)?.status === "published") {
      return { alreadyPublished: true, planVersion: identity.planVersion };
    }
    const existing = this.versions.get(identity.planVersion);
    if (existing && ["building", "validating"].includes(existing.status)) {
      throw new Error("repository_plan_publication_in_progress");
    }
    this.versions.set(identity.planVersion, {
      identity: clone(identity),
      record: existing?.record ?? null,
      context: null,
      validation: null,
      diagnostics: [],
      status: "building",
      publicationOrder: existing?.publicationOrder ?? null,
    });
    return { alreadyPublished: false, planVersion: identity.planVersion };
  }

  async stage(plan: RepositoryExecutionPlan, context: RepositoryPlanValidationContext): Promise<void> {
    const version = this.versions.get(plan.planVersion);
    if (!version || version.status !== "building") {
      throw new Error("Repository plan is not building.");
    }
    const previous = this.publications.get(publicationKey(plan.repositoryId, plan.taskHash)) ?? null;
    version.context = clone(context);
    version.record = {
      ...clone(plan),
      status: "building",
      createdAt: new Date().toISOString(),
      validatedAt: null,
      publishedAt: null,
      publicationMetadata: {
        previousPlanVersion: previous,
        repositoryRevision: plan.repositoryRevision,
        intelligenceVersion: plan.intelligenceVersion,
        graphVersion: plan.graphVersion,
        embeddingVersion: plan.embeddingVersion,
      },
    };
  }

  async validate(planVersion: string): Promise<RepositoryPlanValidation> {
    const version = this.versions.get(planVersion);
    if (!version?.record || !version.context || version.status !== "building") {
      throw new Error("Repository plan is not ready for validation.");
    }
    version.status = "validating";
    version.record.status = "validating";
    const validation = validateRepositoryPlan(
      version.record,
      version.context,
      version.record.publicationMetadata.previousPlanVersion,
    );
    version.validation = clone(validation);
    version.diagnostics = clone(validation.diagnostics);
    version.record.validatedAt = validation.validatedAt;
    if (!validation.valid) {
      version.status = "failed";
      version.record.status = "failed";
      throw new Error(`Repository plan validation failed: ${
        validation.diagnostics.map((item) => item.code).join(",")
      }`);
    }
    return validation;
  }

  async publish(planVersion: string): Promise<void> {
    const version = this.versions.get(planVersion);
    if (!version?.record || !version.validation?.valid ||
        !["validating", "published"].includes(version.status)) {
      throw new Error("Validated repository plan is required for publication.");
    }
    const key = publicationKey(version.record.repositoryId, version.record.taskHash);
    const previous = this.publications.get(key);
    if (previous && previous !== planVersion) {
      const previousVersion = this.versions.get(previous);
      if (previousVersion?.record) {
        previousVersion.status = "superseded";
        previousVersion.record.status = "superseded";
      }
    }
    version.status = "published";
    version.record.status = "published";
    version.record.publishedAt ??= new Date().toISOString();
    version.publicationOrder = ++this.order;
    this.publications.set(key, planVersion);
  }

  async fail(planVersion: string, diagnostics: readonly RepositoryPlanDiagnostic[]): Promise<void> {
    const version = this.versions.get(planVersion);
    if (!version || !["building", "validating"].includes(version.status)) return;
    version.status = "failed";
    if (version.record) version.record.status = "failed";
    version.diagnostics = clone([...diagnostics]);
  }

  async loadPublished(repositoryId: string, taskHash: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const versionId = this.publications.get(publicationKey(repositoryId, taskHash));
    const version = versionId ? this.versions.get(versionId) : null;
    return version?.record && version.status === "published" ? clone(version.record) : null;
  }

  async collect(repositoryId: string, taskHash: string, retentionCount = env.REPOSITORY_PLAN_RETENTION_COUNT) {
    const key = publicationKey(repositoryId, taskHash);
    const current = this.publications.get(key);
    const history = [...this.versions.entries()].filter(([, version]) =>
      version.identity.repositoryId === repositoryId &&
      version.identity.taskHash === taskHash &&
      ["published", "superseded"].includes(version.status))
      .sort((a, b) => (b[1].publicationOrder ?? 0) - (a[1].publicationOrder ?? 0));
    const rollback = history.find(([versionId]) => versionId !== current)?.[0];
    const retain = new Set(history.slice(0, Math.max(2, retentionCount)).map(([versionId]) => versionId));
    if (current) retain.add(current);
    if (rollback) retain.add(rollback);
    let removed = 0;
    for (const [versionId, version] of this.versions) {
      if (version.identity.repositoryId !== repositoryId ||
          version.identity.taskHash !== taskHash ||
          ["building", "validating"].includes(version.status) ||
          retain.has(versionId)) continue;
      this.versions.delete(versionId);
      removed += 1;
    }
    return removed;
  }

  async recover(): Promise<number> {
    let recovered = 0;
    for (const version of this.versions.values()) {
      if (!["building", "validating"].includes(version.status)) continue;
      version.status = "failed";
      if (version.record) version.record.status = "failed";
      version.diagnostics.push({ code: "startup_recovery", message: "Interrupted repository plan." });
      recovered += 1;
    }
    return recovered;
  }

  async verify(): Promise<void> {
    const records = [...this.versions.values()].flatMap((version) => version.record ? [version.record] : []);
    verifyPlanPublicationIntegrity(records);
    for (const [key, versionId] of this.publications) {
      const version = this.versions.get(versionId);
      if (!version?.record || version.status !== "published" ||
          publicationKey(version.record.repositoryId, version.record.taskHash) !== key ||
          version.record.plannerVersion !== REPOSITORY_PLANNER_VERSION) {
        throw new Error("Repository planning publication contract is invalid.");
      }
    }
  }
}

interface RpcQuery extends PromiseLike<{ data: unknown; error: { message?: string } | null }> {
  abortSignal?(signal: AbortSignal): RpcQuery;
}
interface DatabaseClient { rpc(name: string, parameters?: Record<string, unknown>): RpcQuery }

async function rpc(
  client: DatabaseClient,
  name: string,
  parameters: Record<string, unknown> = {},
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  let query = client.rpc(name, parameters);
  if (signal && query.abortSignal) query = query.abortSignal(signal);
  return query;
}

function assertNoError(error: { message?: string } | null, fallback: string): void {
  if (error) throw new Error(`${fallback}${error.message ? `: ${error.message}` : ""}`);
}

function firstRow(data: unknown): Record<string, unknown> | null {
  if (Array.isArray(data)) return data[0] as Record<string, unknown> | undefined ?? null;
  return data && typeof data === "object" ? data as Record<string, unknown> : null;
}

function recordFromRow(row: Record<string, unknown>): RepositoryPlanRecord {
  const plan = clone(row.plan as RepositoryExecutionPlan);
  return {
    ...plan,
    status: String(row.status) as RepositoryPlanRecord["status"],
    createdAt: String(row.created_at),
    validatedAt: row.validated_at ? String(row.validated_at) : null,
    publishedAt: row.published_at ? String(row.published_at) : null,
    publicationMetadata: clone(row.publication_metadata as RepositoryPlanRecord["publicationMetadata"]),
  };
}

export class SupabaseRepositoryPlanningStore implements RepositoryPlanningStore {
  private readonly client: DatabaseClient;
  constructor(client: DatabaseClient | SupabaseClient) {
    this.client = client as DatabaseClient;
  }

  async begin(identity: RepositoryPlanIdentity, signal?: AbortSignal): Promise<BeginRepositoryPlanResult> {
    const { data, error } = await rpc(this.client, "begin_repository_plan_version", {
      input_plan_version: identity.planVersion,
      input_task_hash: identity.taskHash,
      input_repository_id: identity.repositoryId,
      input_repository_revision: identity.repositoryRevision,
      input_intelligence_version: identity.intelligenceVersion,
      input_graph_version: identity.graphVersion,
      input_embedding_version: identity.embeddingVersion,
      input_planner_version: identity.plannerVersion,
      input_schema_version: identity.schemaVersion,
    }, signal);
    assertNoError(error, "Repository plan staging failed");
    return {
      alreadyPublished: firstRow(data)?.already_published === true,
      planVersion: identity.planVersion,
    };
  }

  async stage(plan: RepositoryExecutionPlan, context: RepositoryPlanValidationContext, signal?: AbortSignal) {
    const { error } = await rpc(this.client, "stage_repository_plan_version", {
      input_plan_version: plan.planVersion,
      input_plan: plan,
      input_affected_files: plan.affectedFiles,
      input_ordered_phases: plan.implementationPhases,
      input_validation_context: context,
    }, signal);
    assertNoError(error, "Repository plan persistence failed");
  }

  async validate(planVersion: string, signal?: AbortSignal) {
    const { data, error } = await rpc(this.client, "validate_repository_plan_version", {
      input_plan_version: planVersion,
    }, signal);
    assertNoError(error, "Repository plan validation failed");
    const row = firstRow(data);
    return {
      valid: row?.is_valid === true,
      diagnostics: clone((row?.diagnostics ?? []) as RepositoryPlanDiagnostic[]),
      validatedAt: String(row?.validated_at ?? new Date().toISOString()),
    };
  }

  async publish(planVersion: string, signal?: AbortSignal): Promise<void> {
    const { error } = await rpc(this.client, "publish_repository_plan_version", {
      input_plan_version: planVersion,
    }, signal);
    assertNoError(error, "Repository plan publication failed");
  }

  async fail(planVersion: string, diagnostics: readonly RepositoryPlanDiagnostic[], signal?: AbortSignal) {
    const { error } = await rpc(this.client, "fail_repository_plan_version", {
      input_plan_version: planVersion,
      input_diagnostics: diagnostics,
    }, signal);
    assertNoError(error, "Repository plan failure recording failed");
  }

  async loadPublished(repositoryId: string, taskHash: string, signal?: AbortSignal) {
    const { data, error } = await rpc(this.client, "get_published_repository_plan", {
      input_repository_id: repositoryId,
      input_task_hash: taskHash,
    }, signal);
    assertNoError(error, "Repository plan lookup failed");
    const row = firstRow(data);
    return row ? recordFromRow(row) : null;
  }

  async collect(
    repositoryId: string,
    taskHash: string,
    retentionCount = env.REPOSITORY_PLAN_RETENTION_COUNT,
    signal?: AbortSignal,
  ) {
    const { data, error } = await rpc(this.client, "collect_repository_plan_versions", {
      input_repository_id: repositoryId,
      input_task_hash: taskHash,
      input_retention_count: Math.max(2, retentionCount),
    }, signal);
    assertNoError(error, "Repository plan retention failed");
    return Number(firstRow(data)?.deleted_count ?? data ?? 0);
  }

  async recover(signal?: AbortSignal) {
    const { data, error } = await rpc(this.client, "recover_repository_plan_versions", {}, signal);
    assertNoError(error, "Repository plan recovery failed");
    return Number(firstRow(data)?.recovered_count ?? data ?? 0);
  }

  async verify(signal?: AbortSignal): Promise<void> {
    const { data, error } = await rpc(this.client, "verify_repository_planning_contract", {
      input_planner_version: REPOSITORY_PLANNER_VERSION,
    }, signal);
    assertNoError(error, "Repository planning startup validation failed");
    if (firstRow(data)?.valid !== true && data !== true) {
      throw new Error("Repository planning startup validation returned an invalid contract.");
    }
  }
}

export const runtimeRepositoryPlanningStore: RepositoryPlanningStore =
  new SupabaseRepositoryPlanningStore(supabase);
