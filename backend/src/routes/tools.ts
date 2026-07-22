import { Hono } from "hono";
import { z } from "zod";
import { readFileContents } from "../services/tools/readFile.js";
import { grepSearch } from "../services/tools/grepSearch.js";
import { listDirectory } from "../services/tools/listDirectory.js";
import { findSymbol } from "../services/tools/findSymbol.js";
import { buildFileTree } from "../services/tools/fileTree.js";
import { RepositoryIdSchema } from "../validation/repositorySchemas.js";
import { authorizeRepositoryRequest } from "../services/security/repositoryRequestGuard.js";
import { isRepositoryPathSecurityError } from "../services/security/repositoryPaths.js";
import { validatePublishedRepositoryCheckout } from "../services/repository/ownershipGuard.js";
import { logger } from "../lib/logger.js";

const toolsRouter = new Hono<{ Variables: { requestId: string } }>();

function toolFailure(c: Parameters<typeof authorizeRepositoryRequest>[0], error: unknown, operation: string) {
  if (isRepositoryPathSecurityError(error)) {
    logger.warn("repository_path_rejected", {
      requestId: c.get("requestId"),
      route: c.req.path,
      operation,
      reasonCode: error.reasonCode,
    });
    return c.json({ success: false, requestId: c.get("requestId"), error: "Repository path is not allowed" }, 400);
  }
  return c.json({ success: false, requestId: c.get("requestId"), error: "Tool failed" }, 500);
}

async function authorizedCheckout(c: Parameters<typeof authorizeRepositoryRequest>[0], repositoryId: string, operation: string) {
  const access = await authorizeRepositoryRequest(c, repositoryId, operation);
  if (!access.ok) return access;
  return { ok: true as const, checkout: await validatePublishedRepositoryCheckout(access.repository) };
}

toolsRouter.post("/read-file", async (c) => {
  const requestId = c.get("requestId");
  const parsed = z.object({ repositoryId: RepositoryIdSchema, relativePath: z.string().min(1) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: "Validation failed", details: parsed.error.errors }, 400);
  try {
    const access = await authorizedCheckout(c, parsed.data.repositoryId, "read_file");
    if (!access.ok) return access.response;
    return c.json({ success: true, requestId, data: await readFileContents(access.checkout, parsed.data.relativePath) });
  } catch (err) { return toolFailure(c, err, "read_file"); }
});

toolsRouter.post("/grep", async (c) => {
  const requestId = c.get("requestId");
  const parsed = z.object({ repositoryId: RepositoryIdSchema, query: z.string().min(1) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: "Validation failed", details: parsed.error.errors }, 400);
  try {
    const access = await authorizedCheckout(c, parsed.data.repositoryId, "grep");
    if (!access.ok) return access.response;
    return c.json({ success: true, requestId, data: await grepSearch(access.checkout, parsed.data.query) });
  } catch (err) { return toolFailure(c, err, "grep"); }
});

toolsRouter.post("/list-dir", async (c) => {
  const requestId = c.get("requestId");
  const parsed = z.object({ repositoryId: RepositoryIdSchema, relativePath: z.string().optional() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: "Validation failed", details: parsed.error.errors }, 400);
  try {
    const access = await authorizedCheckout(c, parsed.data.repositoryId, "list_directory");
    if (!access.ok) return access.response;
    return c.json({ success: true, requestId, data: await listDirectory(access.checkout, parsed.data.relativePath) });
  } catch (err) { return toolFailure(c, err, "list_directory"); }
});

toolsRouter.post("/find-symbol", async (c) => {
  const requestId = c.get("requestId");
  const parsed = z.object({ repositoryId: RepositoryIdSchema, symbol: z.string().min(1) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: "Validation failed", details: parsed.error.errors }, 400);
  try {
    const access = await authorizedCheckout(c, parsed.data.repositoryId, "find_symbol");
    if (!access.ok) return access.response;
    return c.json({ success: true, requestId, data: await findSymbol(access.checkout, parsed.data.symbol) });
  } catch (err) { return toolFailure(c, err, "find_symbol"); }
});

toolsRouter.post("/file-tree", async (c) => {
  const requestId = c.get("requestId");
  const parsed = z.object({ repositoryId: RepositoryIdSchema }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: "Validation failed", details: parsed.error.errors }, 400);
  try {
    const access = await authorizedCheckout(c, parsed.data.repositoryId, "file_tree");
    if (!access.ok) return access.response;
    return c.json({ success: true, requestId, data: await buildFileTree(access.checkout) });
  } catch (err) { return toolFailure(c, err, "file_tree"); }
});

export default toolsRouter;
