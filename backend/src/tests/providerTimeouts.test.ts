import assert from "node:assert/strict";
import { test } from "node:test";
import { APIConnectionTimeoutError } from "openai";
import { normalizeAiProviderError } from "../services/ai/provider.js";
import { normalizeEmbeddingProviderError } from "../services/embeddings/embedder.js";
import { DeadlineExceededError } from "../runtime/deadline.js";

test("OpenAI SDK timeout is normalized without raw provider details", () => {
  const normalized = normalizeAiProviderError(new APIConnectionTimeoutError());
  assert.ok(normalized instanceof DeadlineExceededError);
  assert.equal(normalized.message, "Operation deadline exceeded");
});

test("embedding timeout is normalized and retry-safe at its caller", () => {
  const normalized = normalizeEmbeddingProviderError(new APIConnectionTimeoutError());
  assert.ok(normalized instanceof DeadlineExceededError);
  assert.equal(normalized.message.includes("OpenAI"), false);
});

test("embedding non-timeout failures do not leak upstream errors", () => {
  const normalized = normalizeEmbeddingProviderError(new Error("sk-secret https://provider.test"));
  assert.equal(normalized.message, "Embedding generation failed.");
});
