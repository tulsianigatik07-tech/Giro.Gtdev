// POST /chat — streaming repository-aware AI chat.

import { Hono } from "hono";
import { z } from "zod";
import { stream } from "hono/streaming";
import { runRepositoryChat } from "../services/ai/chat.js";
import { getRequestDeadline } from "../middleware/requestTimeout.js";
import { isDeadlineExceeded } from "../runtime/deadline.js";
import { isDependencyUnavailable } from "../runtime/circuitBreaker.js";

const ChatBody = z.object({
  query: z.string().min(1, "Query must not be empty"),
});

const chatRouter = new Hono<{ Variables: { requestId: string } }>();

chatRouter.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = ChatBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { success: false, error: "Validation failed", details: parsed.error.errors },
      400,
    );
  }

  try {
    const result = await runRepositoryChat(parsed.data.query, {
      signal: getRequestDeadline(c)?.signal,
      requestId: c.get("requestId"),
    });

    c.header("Content-Type", "text/plain; charset=utf-8");
    c.header("x-total-chunks", String(result.contextStats.totalChunks));
    c.header("x-estimated-tokens", String(result.contextStats.estimatedTokens));
    c.header(
      "x-citations",
      JSON.stringify(result.citations.slice(0, 10)),
    );
    if (result.confidence) {
      c.header("x-retrieval-confidence", JSON.stringify(result.confidence));
    }

    return stream(c, async (s) => {
      for await (const chunk of result.stream) {
        await s.write(chunk);
      }
    });
  } catch (err) {
    if (isDeadlineExceeded(err) || isDependencyUnavailable(err)) throw err;
    return c.json(
      {
        success: false,
        error: err instanceof Error ? err.message : "Chat failed",
      },
      500,
    );
  }
});

export default chatRouter;
