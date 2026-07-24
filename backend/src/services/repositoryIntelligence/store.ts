import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "../../config/env.js";
import { supabase } from "../../lib/supabase.js";
import type { RepositorySnapshotIdentity } from "../indexing/snapshots/repositorySnapshotStore.js";
import {
  assertRepositoryQuota,
  repositoryQuotaErrorFromMessage,
  serializedArtifactBytes,
} from "../repository/quotas/repositoryQuota.js";
import type {
  RepositoryIntelligenceDiagnostic,
  RepositoryIntelligenceRecord,
  RepositoryIntelligenceSnapshot,
  RepositoryIntelligenceValidation,
} from "./types.js";
import { REPOSITORY_INTELLIGENCE_ANALYSIS_VERSION } from "./types.js";
import {
  validatePublicationIntegrity,
  validateRepositoryIntelligence,
} from "./validation.js";

export interface BeginIntelligenceResult {
  alreadyPublished: boolean;
  intelligenceVersion: string;
}

export interface RepositoryIntelligenceStore {
  begin(
    identity: RepositorySnapshotIdentity,
    snapshot: Pick<RepositoryIntelligenceSnapshot,
      "intelligenceVersion" | "graphVersion" | "embeddingVersion" | "parserVersion" | "analysisVersion">,
    signal?: AbortSignal,
  ): Promise<BeginIntelligenceResult>;
  stage(
    identity: RepositorySnapshotIdentity,
    snapshot: RepositoryIntelligenceSnapshot,
    signal?: AbortSignal,
  ): Promise<void>;
  validate(
    identity: RepositorySnapshotIdentity,
    intelligenceVersion: string,
    signal?: AbortSignal,
  ): Promise<RepositoryIntelligenceValidation>;
  publish(identity: RepositorySnapshotIdentity, intelligenceVersion: string, signal?: AbortSignal): Promise<void>;
  fail(
    identity: RepositorySnapshotIdentity,
    intelligenceVersion: string,
    diagnostics: readonly RepositoryIntelligenceDiagnostic[],
    signal?: AbortSignal,
  ): Promise<void>;
  loadPublished(
    repositoryId: string,
    repositoryRevision?: string,
    signal?: AbortSignal,
  ): Promise<RepositoryIntelligenceRecord | null>;
  collect(repositoryId: string, retentionCount?: number, signal?: AbortSignal): Promise<number>;
  recover(signal?: AbortSignal): Promise<number>;
  verify(signal?: AbortSignal): Promise<void>;
}

interface MemoryVersion {
  identity: RepositorySnapshotIdentity;
  record: RepositoryIntelligenceRecord | null;
  validation: RepositoryIntelligenceValidation | null;
  diagnostics: RepositoryIntelligenceDiagnostic[];
  status: RepositoryIntelligenceRecord["status"];
  publicationOrder: number | null;
}

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryRepositoryIntelligenceStore implements RepositoryIntelligenceStore {
  private readonly versions = new Map<string, MemoryVersion>();
  private readonly publications = new Map<string, string>();
  private order = 0;

  async begin(
    identity: RepositorySnapshotIdentity,
    snapshot: Pick<RepositoryIntelligenceSnapshot,
      "intelligenceVersion" | "graphVersion" | "embeddingVersion" | "parserVersion" | "analysisVersion">,
  ): Promise<BeginIntelligenceResult> {
    const current = this.publications.get(identity.repositoryId);
    const published = current ? this.versions.get(current) : null;
    if (published?.record?.repositoryRevision === identity.revision &&
        current === snapshot.intelligenceVersion && published.status === "published") {
      return { alreadyPublished: true, intelligenceVersion: snapshot.intelligenceVersion };
    }
    const existing = this.versions.get(snapshot.intelligenceVersion);
    if (existing && ["building", "validating"].includes(existing.status) &&
        existing.identity.jobId !== identity.jobId) {
      throw new Error("repository_intelligence_publication_in_progress");
    }
    this.versions.set(snapshot.intelligenceVersion, {
      identity: clone(identity),
      record: existing?.record ?? null,
      validation: null,
      diagnostics: [],
      status: "building",
      publicationOrder: existing?.publicationOrder ?? null,
    });
    return { alreadyPublished: false, intelligenceVersion: snapshot.intelligenceVersion };
  }

  async stage(identity: RepositorySnapshotIdentity, snapshot: RepositoryIntelligenceSnapshot): Promise<void> {
    const version = this.versions.get(snapshot.intelligenceVersion);
    if (!version || version.status !== "building" ||
        version.identity.jobId !== identity.jobId ||
        version.identity.workerId !== identity.workerId ||
        version.identity.claimToken !== identity.claimToken) {
      throw new Error("indexing_job_lease_conflict");
    }
    assertRepositoryQuota(
      "artifact_size",
      serializedArtifactBytes(snapshot),
      env.REPOSITORY_INTELLIGENCE_MAX_BYTES,
    );
    const previous = this.publications.get(identity.repositoryId) ?? null;
    version.record = {
      ...clone(snapshot),
      status: "building",
      createdAt: new Date().toISOString(),
      validatedAt: null,
      publishedAt: null,
      publicationMetadata: {
        repositoryRevision: snapshot.repositoryRevision,
        graphVersion: snapshot.graphVersion,
        embeddingVersion: snapshot.embeddingVersion,
        previousIntelligenceVersion: previous,
      },
    };
  }

  async validate(
    identity: RepositorySnapshotIdentity,
    intelligenceVersion: string,
  ): Promise<RepositoryIntelligenceValidation> {
    const version = this.versions.get(intelligenceVersion);
    if (!version?.record || version.status !== "building" || version.identity.jobId !== identity.jobId) {
      throw new Error("Repository intelligence is not ready for validation.");
    }
    version.status = "validating";
    version.record.status = "validating";
    const validation = validateRepositoryIntelligence(
      version.record,
      version.record.publicationMetadata.previousIntelligenceVersion,
    );
    version.validation = clone(validation);
    version.diagnostics = clone(validation.diagnostics);
    version.record.validatedAt = validation.validatedAt;
    if (!validation.valid) {
      version.status = "failed";
      version.record.status = "failed";
      throw new Error(`Repository intelligence validation failed: ${
        validation.diagnostics.map((item) => item.code).join(",")
      }`);
    }
    return validation;
  }

  async publish(identity: RepositorySnapshotIdentity, intelligenceVersion: string): Promise<void> {
    const version = this.versions.get(intelligenceVersion);
    if (!version?.record || !version.validation?.valid ||
        !["validating", "published"].includes(version.status) ||
        version.record.repositoryRevision !== identity.revision) {
      throw new Error("Validated repository intelligence is required for publication.");
    }
    const previous = this.publications.get(identity.repositoryId);
    if (previous && previous !== intelligenceVersion) {
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
    this.publications.set(identity.repositoryId, intelligenceVersion);
  }

  async fail(
    identity: RepositorySnapshotIdentity,
    intelligenceVersion: string,
    diagnostics: readonly RepositoryIntelligenceDiagnostic[],
  ): Promise<void> {
    const version = this.versions.get(intelligenceVersion);
    if (!version || version.identity.jobId !== identity.jobId ||
        !["building", "validating"].includes(version.status)) return;
    version.status = "failed";
    if (version.record) version.record.status = "failed";
    version.diagnostics = clone([...diagnostics]);
  }

  async loadPublished(
    repositoryId: string,
    repositoryRevision?: string,
    signal?: AbortSignal,
  ): Promise<RepositoryIntelligenceRecord | null> {
    signal?.throwIfAborted();
    const current = this.publications.get(repositoryId);
    const version = current ? this.versions.get(current) : null;
    if (!version?.record || version.status !== "published" ||
        (repositoryRevision && version.record.repositoryRevision !== repositoryRevision)) return null;
    return clone(version.record);
  }

  async collect(repositoryId: string, retentionCount = env.REPOSITORY_INTELLIGENCE_RETENTION_COUNT): Promise<number> {
    const current = this.publications.get(repositoryId);
    const rollback = [...this.versions.entries()]
      .filter(([, version]) => version.identity.repositoryId === repositoryId &&
        ["published", "superseded"].includes(version.status))
      .sort((a, b) => (b[1].publicationOrder ?? 0) - (a[1].publicationOrder ?? 0))
      .slice(0, Math.max(2, retentionCount))
      .map(([key]) => key);
    const retain = new Set(rollback);
    if (current) retain.add(current);
    let removed = 0;
    for (const [key, version] of this.versions) {
      if (version.identity.repositoryId !== repositoryId ||
          ["building", "validating"].includes(version.status) || retain.has(key)) continue;
      this.versions.delete(key);
      removed += 1;
    }
    return removed;
  }

  async recover(): Promise<number> {
    let recovered = 0;
    for (const version of this.versions.values()) {
      if (["building", "validating"].includes(version.status)) {
        version.status = "failed";
        if (version.record) version.record.status = "failed";
        version.diagnostics.push({ code: "startup_recovery", message: "Interrupted intelligence build." });
        recovered += 1;
      }
    }
    return recovered;
  }

  async verify(): Promise<void> {
    const records = [...this.versions.values()].flatMap((version) =>
      version.record ? [version.record] : []);
    validatePublicationIntegrity(records);
    for (const [repositoryId, versionId] of this.publications) {
      const version = this.versions.get(versionId);
      if (!version?.record || version.status !== "published" ||
          version.record.repositoryId !== repositoryId ||
          version.record.analysisVersion !== REPOSITORY_INTELLIGENCE_ANALYSIS_VERSION) {
        throw new Error("Repository intelligence publication contract is invalid.");
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
  if (!error) return;
  const quota = repositoryQuotaErrorFromMessage(error.message);
  if (quota) throw quota;
  throw new Error(`${fallback}${error.message ? `: ${error.message}` : ""}`);
}

function firstRow(data: unknown): Record<string, unknown> | null {
  if (Array.isArray(data)) return data[0] as Record<string, unknown> | undefined ?? null;
  return data && typeof data === "object" ? data as Record<string, unknown> : null;
}

function recordFromRow(row: Record<string, unknown>): RepositoryIntelligenceRecord {
  const snapshot = clone(row.snapshot as RepositoryIntelligenceSnapshot);
  return {
    ...snapshot,
    status: String(row.status) as RepositoryIntelligenceRecord["status"],
    createdAt: String(row.created_at),
    validatedAt: row.validated_at ? String(row.validated_at) : null,
    publishedAt: row.published_at ? String(row.published_at) : null,
    publicationMetadata: clone(row.publication_metadata as RepositoryIntelligenceRecord["publicationMetadata"]),
  };
}

export class SupabaseRepositoryIntelligenceStore implements RepositoryIntelligenceStore {
  private readonly client: DatabaseClient;
  constructor(client: DatabaseClient | SupabaseClient) {
    this.client = client as DatabaseClient;
  }

  async begin(
    identity: RepositorySnapshotIdentity,
    snapshot: Pick<RepositoryIntelligenceSnapshot,
      "intelligenceVersion" | "graphVersion" | "embeddingVersion" | "parserVersion" | "analysisVersion">,
    signal?: AbortSignal,
  ): Promise<BeginIntelligenceResult> {
    const { data, error } = await rpc(this.client, "begin_repository_intelligence_version", {
      input_repository_id: identity.repositoryId,
      input_repository_revision: identity.revision,
      input_intelligence_version: snapshot.intelligenceVersion,
      input_graph_version: snapshot.graphVersion,
      input_embedding_version: snapshot.embeddingVersion,
      input_parser_version: snapshot.parserVersion,
      input_analysis_version: snapshot.analysisVersion,
      input_job_id: identity.jobId,
      input_worker_id: identity.workerId,
      input_claim_token: identity.claimToken,
    }, signal);
    assertNoError(error, "Repository intelligence staging failed");
    const row = firstRow(data);
    if (!row) throw new Error("Repository intelligence staging returned no state.");
    return { alreadyPublished: row.already_published === true, intelligenceVersion: snapshot.intelligenceVersion };
  }

  async stage(
    identity: RepositorySnapshotIdentity,
    snapshot: RepositoryIntelligenceSnapshot,
    signal?: AbortSignal,
  ): Promise<void> {
    assertRepositoryQuota(
      "artifact_size",
      serializedArtifactBytes(snapshot),
      env.REPOSITORY_INTELLIGENCE_MAX_BYTES,
    );
    const { error } = await rpc(this.client, "stage_repository_intelligence_version", {
      input_repository_id: identity.repositoryId,
      input_repository_revision: identity.revision,
      input_intelligence_version: snapshot.intelligenceVersion,
      input_job_id: identity.jobId,
      input_worker_id: identity.workerId,
      input_claim_token: identity.claimToken,
      input_snapshot: snapshot,
      input_subsystems: snapshot.subsystems,
      input_metrics: snapshot.metrics,
    }, signal);
    assertNoError(error, "Repository intelligence persistence failed");
  }

  async validate(identity: RepositorySnapshotIdentity, intelligenceVersion: string, signal?: AbortSignal) {
    const { data, error } = await rpc(this.client, "validate_repository_intelligence_version", {
      input_repository_id: identity.repositoryId,
      input_repository_revision: identity.revision,
      input_intelligence_version: intelligenceVersion,
      input_job_id: identity.jobId,
      input_worker_id: identity.workerId,
      input_claim_token: identity.claimToken,
      input_max_bytes: env.REPOSITORY_INTELLIGENCE_MAX_BYTES,
    }, signal);
    assertNoError(error, "Repository intelligence validation failed");
    const row = firstRow(data);
    return {
      valid: row?.is_valid === true,
      diagnostics: clone((row?.diagnostics ?? []) as RepositoryIntelligenceDiagnostic[]),
      validatedAt: String(row?.validated_at ?? new Date().toISOString()),
    };
  }

  async publish(_identity: RepositorySnapshotIdentity, _intelligenceVersion: string): Promise<void> {
    // Published atomically by publish_repository_snapshot.
  }

  async fail(
    identity: RepositorySnapshotIdentity,
    intelligenceVersion: string,
    diagnostics: readonly RepositoryIntelligenceDiagnostic[],
    signal?: AbortSignal,
  ): Promise<void> {
    const { error } = await rpc(this.client, "fail_repository_intelligence_version", {
      input_repository_id: identity.repositoryId,
      input_intelligence_version: intelligenceVersion,
      input_job_id: identity.jobId,
      input_diagnostics: diagnostics,
    }, signal);
    assertNoError(error, "Repository intelligence failure recording failed");
  }

  async loadPublished(repositoryId: string, repositoryRevision?: string, signal?: AbortSignal) {
    const { data, error } = await rpc(this.client, "get_published_repository_intelligence", {
      input_repository_id: repositoryId,
      input_repository_revision: repositoryRevision ?? null,
    }, signal);
    assertNoError(error, "Repository intelligence lookup failed");
    const row = firstRow(data);
    return row ? recordFromRow(row) : null;
  }

  async collect(repositoryId: string, retentionCount = env.REPOSITORY_INTELLIGENCE_RETENTION_COUNT, signal?: AbortSignal) {
    const { data, error } = await rpc(this.client, "collect_repository_intelligence_versions", {
      input_repository_id: repositoryId,
      input_retention_count: Math.max(2, retentionCount),
    }, signal);
    assertNoError(error, "Repository intelligence retention failed");
    return Number(firstRow(data)?.deleted_count ?? data ?? 0);
  }

  async recover(signal?: AbortSignal) {
    const { data, error } = await rpc(this.client, "recover_repository_intelligence_versions", {}, signal);
    assertNoError(error, "Repository intelligence recovery failed");
    return Number(firstRow(data)?.recovered_count ?? data ?? 0);
  }

  async verify(signal?: AbortSignal): Promise<void> {
    const { data, error } = await rpc(this.client, "verify_repository_intelligence_contract", {
      input_analysis_version: REPOSITORY_INTELLIGENCE_ANALYSIS_VERSION,
    }, signal);
    assertNoError(error, "Repository intelligence startup validation failed");
    if (firstRow(data)?.valid !== true && data !== true) {
      throw new Error("Repository intelligence startup validation returned an invalid contract.");
    }
  }
}

export const runtimeRepositoryIntelligenceStore: RepositoryIntelligenceStore =
  new SupabaseRepositoryIntelligenceStore(supabase);
