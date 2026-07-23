import { createHash } from "node:crypto";
import { env } from "../../config/env.js";
import { CHUNKING_STRATEGY_VERSION } from "../context/chunker.js";
import { EMBEDDING_DIMENSION, EMBEDDING_MODEL } from "./embedder.js";

export interface EmbeddingIndexConfiguration {
  repositoryId: string;
  repositoryRevision: string;
  embeddingProvider: typeof env.EMBEDDINGS_PROVIDER;
  embeddingModel: string;
  embeddingDimension: number;
  embeddingVersion: string;
  chunkingStrategyVersion: string;
}

export function createEmbeddingVersion(input: Omit<EmbeddingIndexConfiguration, "embeddingVersion">): string {
  const digest = createHash("sha256")
    .update([
      input.repositoryId,
      input.repositoryRevision,
      input.embeddingProvider,
      input.embeddingModel,
      String(input.embeddingDimension),
      input.chunkingStrategyVersion,
    ].join("\u0000"))
    .digest("hex");
  return `embedding-index-${digest}`;
}

export function runtimeEmbeddingIndexConfiguration(
  repositoryId: string,
  repositoryRevision: string,
): EmbeddingIndexConfiguration {
  const input = {
    repositoryId,
    repositoryRevision,
    embeddingProvider: env.EMBEDDINGS_PROVIDER,
    embeddingModel: EMBEDDING_MODEL,
    embeddingDimension: EMBEDDING_DIMENSION,
    chunkingStrategyVersion: CHUNKING_STRATEGY_VERSION,
  };
  return Object.freeze({
    ...input,
    embeddingVersion: createEmbeddingVersion(input),
  });
}
