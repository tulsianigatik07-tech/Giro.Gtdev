// POST /chat — streaming repository-aware AI chat.

import { Hono } from "hono";
import { z } from "zod";
import { stream } from "hono/streaming";
import { runRepositoryChat } from "../services/ai/chat.js";

const ChatBody = z.object({
  query: z.string().min(1, "Query must not be empty"),
});

const chatRouter = new Hono();

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
    const result = await runRepositoryChat(parsed.data.query);

    c.header("Content-Type", "text/plain; charset=utf-8");
    c.header("x-total-chunks", String(result.contextStats.totalChunks));
    c.header("x-estimated-tokens", String(result.contextStats.estimatedTokens));
    c.header(
      "x-citations",
      JSON.stringify(result.citations.slice(0, 10)),
    );

    return stream(c, async (s) => {
      for await (const chunk of result.stream) {
        await s.write(chunk);
      }
    });
  } catch (err) {
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
