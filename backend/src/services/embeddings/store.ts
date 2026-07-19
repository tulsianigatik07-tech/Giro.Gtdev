import { supabase } from "../../lib/supabase.js";
import { env } from "../../config/env.js";
import { createDeadline } from "../../runtime/deadline.js";

interface StoreInput {
  repository: string;
  filePath: string;
  language: string;
  chunkIndex: number;
  content: string;
  summary: string | null;
  startLine: number;
  endLine: number;
  embedding: number[];
  repositoryRevision?: string;
  tokenCount?: number;
}

function stableChunkId(input: StoreInput, revision: string): string {
  return createHash("sha256").update([
    input.repository, revision, input.filePath, input.chunkIndex, input.content,
  ].join("\u0000")).digest("hex");
}

export async function storeChunkEmbedding(
  input: StoreInput,
  options: { signal?: AbortSignal; databaseClient?: typeof supabase } = {},
): Promise<void> {
  const deadline = createDeadline(env.DATABASE_REQUEST_TIMEOUT_MS, { parentSignal: options.signal });
  try {
    const repositoryRevision = input.repositoryRevision ?? "unversioned";
    const { error } = await (options.databaseClient ?? supabase).from("repository_chunks").upsert({
      id: stableChunkId(input, repositoryRevision),
      repository: input.repository,
      repository_revision: repositoryRevision,
      file_path: input.filePath,
      language: input.language,
      chunk_index: input.chunkIndex,
      content: input.content,
      summary: input.summary,
      start_line: input.startLine,
      end_line: input.endLine,
      content_hash: createHash("sha256").update(input.content).digest("hex"),
      token_count: input.tokenCount ?? Math.max(1, Math.ceil(input.content.length / 4)),
      character_count: input.content.length,
      embedding: input.embedding,
      metadata: {},
      updated_at: new Date().toISOString(),
    }, { onConflict: "repository,repository_revision,file_path,chunk_index" })
      .abortSignal(deadline.signal);

    if (deadline.signal.aborted) throw deadline.signal.reason;
    if (error) throw new Error("Failed to store chunk.");
  } finally {
    deadline.dispose();
  }
}

export async function deleteRepositoryRetrievalData(
  repository: string,
  keepRevision?: string,
  databaseClient: Pick<typeof supabase, "rpc"> = supabase,
): Promise<void> {
  const { error } = await databaseClient.rpc("delete_repository_retrieval_data", {
    input_repository: repository,
    input_keep_revision: keepRevision ?? null,
  });
  if (error) throw new Error("Failed to remove repository retrieval data.");
}
import { createHash } from "node:crypto";
