import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "../../lib/supabase.js";
import type { RepositorySnapshotIdentity } from "../indexing/snapshots/repositorySnapshotStore.js";
import type { EmbeddingIndexConfiguration } from "./indexVersion.js";
import { storeChunkEmbedding, type StoreEmbeddingInput } from "./store.js";

export type EmbeddingIndexStatus =
  | "building"
  | "validating"
  | "published"
  | "failed"
  | "superseded";

export interface EmbeddingIndexValidation {
  expectedVectorCount: number;
  vectorCount: number;
  orphanVectorCount: number;
  duplicateChunkHashCount: number;
  missingMetadataCount: number;
  dimensionMismatchCount: number;
  valid: boolean;
}

export interface BeginEmbeddingIndexResult {
  alreadyPublished: boolean;
  configuration: EmbeddingIndexConfiguration;
}

export interface EmbeddingIndexStore {
  begin(
    identity: RepositorySnapshotIdentity,
    configuration: EmbeddingIndexConfiguration,
    signal?: AbortSignal,
  ): Promise<BeginEmbeddingIndexResult>;
  hasChunk(embeddingVersion: string, chunkId: string, signal?: AbortSignal): Promise<boolean>;
  storeChunk(input: StoreEmbeddingInput, signal?: AbortSignal): Promise<void>;
  validate(
    identity: RepositorySnapshotIdentity,
    embeddingVersion: string,
    expectedVectorCount: number,
    signal?: AbortSignal,
  ): Promise<EmbeddingIndexValidation>;
  discard(identity: RepositorySnapshotIdentity, embeddingVersion: string, signal?: AbortSignal): Promise<void>;
  recover(signal?: AbortSignal): Promise<number>;
  verify(signal?: AbortSignal): Promise<void>;
}

interface RpcQuery extends PromiseLike<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}> { abortSignal?(signal: AbortSignal): RpcQuery }

interface SupabaseLike {
  rpc(name: string, parameters?: Record<string, unknown>): RpcQuery;
  from(name: string): any;
}

function firstRow(data: unknown): Record<string, unknown> | null {
  if (Array.isArray(data)) return (data[0] as Record<string, unknown> | undefined) ?? null;
  return data && typeof data === "object" ? data as Record<string, unknown> : null;
}

async function rpc(
  client: SupabaseLike,
  name: string,
  parameters: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ data: unknown; error: { code?: string; message?: string } | null }> {
  signal?.throwIfAborted();
  let query = client.rpc(name, parameters);
  if (signal && typeof query.abortSignal === "function") query = query.abortSignal(signal);
  return query;
}

function assertNoError(error: { message?: string } | null, message: string): void {
  if (error) throw new Error(message);
}

export class SupabaseEmbeddingIndexStore implements EmbeddingIndexStore {
  private readonly client: SupabaseLike;

  constructor(client: SupabaseLike | SupabaseClient) {
    this.client = client as SupabaseLike;
  }

  async begin(
    identity: RepositorySnapshotIdentity,
    configuration: EmbeddingIndexConfiguration,
    signal?: AbortSignal,
  ): Promise<BeginEmbeddingIndexResult> {
    const { data, error } = await rpc(this.client, "begin_embedding_index_version", {
      input_repository_id: configuration.repositoryId,
      input_repository_revision: configuration.repositoryRevision,
      input_embedding_provider: configuration.embeddingProvider,
      input_embedding_model: configuration.embeddingModel,
      input_embedding_dimension: configuration.embeddingDimension,
      input_embedding_version: configuration.embeddingVersion,
      input_chunking_strategy_version: configuration.chunkingStrategyVersion,
      input_job_id: identity.jobId,
      input_worker_id: identity.workerId,
      input_claim_token: identity.claimToken,
    }, signal);
    assertNoError(error, "Embedding index staging failed.");
    return {
      alreadyPublished: firstRow(data)?.already_published === true,
      configuration,
    };
  }

  async hasChunk(embeddingVersion: string, chunkId: string, signal?: AbortSignal): Promise<boolean> {
    let query = this.client.from("repository_chunks")
      .select("id")
      .eq("embedding_version", embeddingVersion)
      .eq("chunk_id", chunkId);
    if (signal && typeof query.abortSignal === "function") query = query.abortSignal(signal);
    const { data, error } = await query.maybeSingle();
    assertNoError(error, "Embedding chunk lookup failed.");
    return Boolean(data);
  }

  async storeChunk(input: StoreEmbeddingInput, signal?: AbortSignal): Promise<void> {
    await storeChunkEmbedding(input, {
      signal,
      databaseClient: this.client as typeof supabase,
    });
  }

  async validate(
    identity: RepositorySnapshotIdentity,
    embeddingVersion: string,
    expectedVectorCount: number,
    signal?: AbortSignal,
  ): Promise<EmbeddingIndexValidation> {
    const { data, error } = await rpc(this.client, "validate_embedding_index_version", {
      input_repository_id: identity.repositoryId,
      input_repository_revision: identity.revision,
      input_embedding_version: embeddingVersion,
      input_expected_vector_count: expectedVectorCount,
      input_job_id: identity.jobId,
      input_worker_id: identity.workerId,
      input_claim_token: identity.claimToken,
    }, signal);
    assertNoError(error, "Embedding index validation failed.");
    const row = firstRow(data);
    if (!row) throw new Error("Embedding index validation returned no result.");
    const validation = {
      expectedVectorCount: Number(row.expected_vector_count),
      vectorCount: Number(row.vector_count),
      orphanVectorCount: Number(row.orphan_vector_count),
      duplicateChunkHashCount: Number(row.duplicate_chunk_hash_count),
      missingMetadataCount: Number(row.missing_metadata_count),
      dimensionMismatchCount: Number(row.dimension_mismatch_count),
      valid: row.is_valid === true,
    };
    if (!validation.valid) throw new Error("Embedding index validation failed.");
    return validation;
  }

  async discard(
    identity: RepositorySnapshotIdentity,
    embeddingVersion: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const { error } = await rpc(this.client, "discard_embedding_index_version", {
      input_repository_id: identity.repositoryId,
      input_repository_revision: identity.revision,
      input_embedding_version: embeddingVersion,
      input_job_id: identity.jobId,
      input_worker_id: identity.workerId,
      input_claim_token: identity.claimToken,
    }, signal);
    assertNoError(error, "Embedding index cleanup failed.");
  }

  async recover(signal?: AbortSignal): Promise<number> {
    const { data, error } = await rpc(this.client, "recover_embedding_index_versions", {}, signal);
    assertNoError(error, "Embedding index recovery failed.");
    const row = firstRow(data);
    return Number(row?.cleaned_version_count ?? 0);
  }

  async verify(signal?: AbortSignal): Promise<void> {
    const { data, error } = await rpc(this.client, "verify_embedding_index_contract", {}, signal);
    assertNoError(error, "Embedding index startup validation failed.");
    const row = firstRow(data);
    if (row?.valid !== true) throw new Error("Embedding index startup validation failed.");
  }
}

interface MemoryVersion {
  configuration: EmbeddingIndexConfiguration;
  status: EmbeddingIndexStatus;
  jobId: string;
  chunks: Map<string, StoreEmbeddingInput>;
  validation: EmbeddingIndexValidation | null;
}

export class MemoryEmbeddingIndexStore implements EmbeddingIndexStore {
  private readonly versions = new Map<string, MemoryVersion>();
  private readonly publications = new Map<string, string>();

  async begin(
    identity: RepositorySnapshotIdentity,
    configuration: EmbeddingIndexConfiguration,
  ): Promise<BeginEmbeddingIndexResult> {
    const existing = this.versions.get(configuration.embeddingVersion);
    if (existing?.status === "published") {
      return { alreadyPublished: true, configuration };
    }
    if (existing && existing.status !== "failed" && existing.jobId !== identity.jobId) {
      throw new Error("Embedding index version is already being built.");
    }
    this.versions.set(configuration.embeddingVersion, {
      configuration: structuredClone(configuration),
      status: "building",
      jobId: identity.jobId,
      chunks: existing?.chunks ?? new Map(),
      validation: null,
    });
    return { alreadyPublished: false, configuration };
  }

  async hasChunk(embeddingVersion: string, chunkId: string): Promise<boolean> {
    return this.versions.get(embeddingVersion)?.chunks.has(chunkId) ?? false;
  }

  async storeChunk(input: StoreEmbeddingInput): Promise<void> {
    const version = this.versions.get(input.embeddingVersion);
    if (!version || version.status !== "building") {
      throw new Error("Embedding index is not mutable.");
    }
    if (input.embedding.length !== version.configuration.embeddingDimension) {
      throw new Error("Embedding dimension mismatch.");
    }
    version.chunks.set(input.chunkId, structuredClone(input));
  }

  async validate(
    identity: RepositorySnapshotIdentity,
    embeddingVersion: string,
    expectedVectorCount: number,
  ): Promise<EmbeddingIndexValidation> {
    const version = this.versions.get(embeddingVersion);
    if (!version || version.jobId !== identity.jobId || version.status !== "building") {
      throw new Error("Embedding index is not ready for validation.");
    }
    version.status = "validating";
    const chunks = [...version.chunks.values()];
    const hashes = new Set<string>();
    let duplicateChunkHashCount = 0;
    let missingMetadataCount = 0;
    let dimensionMismatchCount = 0;
    for (const chunk of chunks) {
      if (hashes.has(chunk.chunkHash)) duplicateChunkHashCount += 1;
      hashes.add(chunk.chunkHash);
      if (!chunk.filePath || !chunk.chunkId || !chunk.chunkHash || !chunk.repositoryRevision || !chunk.embeddingVersion) {
        missingMetadataCount += 1;
      }
      if (chunk.embedding.length !== version.configuration.embeddingDimension) {
        dimensionMismatchCount += 1;
      }
    }
    const validation = {
      expectedVectorCount,
      vectorCount: chunks.length,
      orphanVectorCount: 0,
      duplicateChunkHashCount,
      missingMetadataCount,
      dimensionMismatchCount,
      valid: chunks.length === expectedVectorCount &&
        duplicateChunkHashCount === 0 &&
        missingMetadataCount === 0 &&
        dimensionMismatchCount === 0,
    };
    version.validation = validation;
    if (!validation.valid) {
      version.status = "failed";
      throw new Error("Embedding index validation failed.");
    }
    return structuredClone(validation);
  }

  publish(repositoryId: string, repositoryRevision: string, embeddingVersion: string): void {
    const version = this.versions.get(embeddingVersion);
    if (!version?.validation?.valid || version.status !== "validating" ||
      version.configuration.repositoryId !== repositoryId ||
      version.configuration.repositoryRevision !== repositoryRevision) {
      throw new Error("Embedding index is not validated.");
    }
    const previous = this.publications.get(repositoryId);
    if (previous && previous !== embeddingVersion) {
      const previousVersion = this.versions.get(previous);
      if (previousVersion) previousVersion.status = "superseded";
    }
    version.status = "published";
    this.publications.set(repositoryId, embeddingVersion);
  }

  current(repositoryId: string, repositoryRevision: string): readonly StoreEmbeddingInput[] {
    const embeddingVersion = this.publications.get(repositoryId);
    const version = embeddingVersion ? this.versions.get(embeddingVersion) : undefined;
    if (!version || version.status !== "published" ||
      version.configuration.repositoryRevision !== repositoryRevision ||
      !version.validation?.valid) return [];
    return Object.freeze([...version.chunks.values()].map((chunk) => Object.freeze(structuredClone(chunk))));
  }

  async discard(identity: RepositorySnapshotIdentity, embeddingVersion: string): Promise<void> {
    const version = this.versions.get(embeddingVersion);
    if (!version || version.status === "published" || version.jobId !== identity.jobId) return;
    version.status = "failed";
    version.chunks.clear();
  }

  async recover(): Promise<number> {
    let cleaned = 0;
    for (const version of this.versions.values()) {
      if (version.status === "building" || version.status === "validating" || version.status === "failed") {
        if (version.chunks.size > 0) cleaned += 1;
        version.chunks.clear();
        version.status = "failed";
      }
    }
    return cleaned;
  }

  async verify(): Promise<void> {
    for (const [repositoryId, embeddingVersion] of this.publications) {
      const version = this.versions.get(embeddingVersion);
      if (!version || version.status !== "published" ||
        version.configuration.repositoryId !== repositoryId ||
        !version.validation?.valid) {
        throw new Error("Embedding index publication contract is invalid.");
      }
    }
  }
}

export const runtimeEmbeddingIndexStore = new SupabaseEmbeddingIndexStore(supabase);
