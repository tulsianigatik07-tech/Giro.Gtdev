import { Hono } from "hono";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { readFileContents } from "../services/tools/readFile.js";
import { grepSearch } from "../services/tools/grepSearch.js";
import { listDirectory } from "../services/tools/listDirectory.js";
import { findSymbol } from "../services/tools/findSymbol.js";
import { buildFileTree } from "../services/tools/fileTree.js";

const toolsRouter = new Hono();

toolsRouter.post("/read-file", async (c) => {
  const requestId = randomUUID();
  const parsed = z.object({ repoPath: z.string().min(1), relativePath: z.string().min(1) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: "Validation failed", details: parsed.error.errors }, 400);
  try { return c.json({ success: true, requestId, data: await readFileContents(parsed.data.repoPath, parsed.data.relativePath) }); }
  catch (err) { return c.json({ success: false, requestId, error: err instanceof Error ? err.message : "Tool failed" }, 500); }
});

toolsRouter.post("/grep", async (c) => {
  const requestId = randomUUID();
  const parsed = z.object({ repoPath: z.string().min(1), query: z.string().min(1) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: "Validation failed", details: parsed.error.errors }, 400);
  try { return c.json({ success: true, requestId, data: await grepSearch(parsed.data.repoPath, parsed.data.query) }); }
  catch (err) { return c.json({ success: false, requestId, error: err instanceof Error ? err.message : "Tool failed" }, 500); }
});

toolsRouter.post("/list-dir", async (c) => {
  const requestId = randomUUID();
  const parsed = z.object({ repoPath: z.string().min(1), relativePath: z.string().optional() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: "Validation failed", details: parsed.error.errors }, 400);
  try { return c.json({ success: true, requestId, data: await listDirectory(parsed.data.repoPath, parsed.data.relativePath) }); }
  catch (err) { return c.json({ success: false, requestId, error: err instanceof Error ? err.message : "Tool failed" }, 500); }
});

toolsRouter.post("/find-symbol", async (c) => {
  const requestId = randomUUID();
  const parsed = z.object({ repoPath: z.string().min(1), symbol: z.string().min(1) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: "Validation failed", details: parsed.error.errors }, 400);
  try { return c.json({ success: true, requestId, data: await findSymbol(parsed.data.repoPath, parsed.data.symbol) }); }
  catch (err) { return c.json({ success: false, requestId, error: err instanceof Error ? err.message : "Tool failed" }, 500); }
});

toolsRouter.post("/file-tree", async (c) => {
  const requestId = randomUUID();
  const parsed = z.object({ repoPath: z.string().min(1) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: "Validation failed", details: parsed.error.errors }, 400);
  try { return c.json({ success: true, requestId, data: await buildFileTree(parsed.data.repoPath) }); }
  catch (err) { return c.json({ success: false, requestId, error: err instanceof Error ? err.message : "Tool failed" }, 500); }
});

export default toolsRouter;
