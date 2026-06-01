import OpenAI from "openai";

const openai = new OpenAI();

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const MAX_EMBEDDING_CHARS = 8000;

export async function generateEmbedding(text: string): Promise<number[]> {
  let normalized = text.replace(/\s+/g, " ").trim();

  if (normalized.length > MAX_EMBEDDING_CHARS) {
    const sliced = normalized.slice(0, MAX_EMBEDDING_CHARS);
    const lastSpace = sliced.lastIndexOf(" ");
    normalized = lastSpace > 0 ? sliced.slice(0, lastSpace) : sliced;
  }

  try {
    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: normalized,
    });
    const vector = response.data[0]?.embedding;
    if (!vector) throw new Error("Embedding response contained no data");
    return vector;
  } catch (err) {
    throw new Error(
      `Embedding generation failed: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }
}
