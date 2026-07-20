import type { Context } from "hono";
import { fail } from "../../lib/response.js";
import { logger } from "../../lib/logger.js";
import { setRequestLogContext } from "../../middleware/requestContext.js";
import { getAuthenticatedUser } from "../auth/authContext.js";
import { authorizeRepository, type AuthorizedRepositoryContext } from "../repository/ownershipGuard.js";
import { normalizeRepositoryId, RepositoryIdentityError } from "./repositoryIdentity.js";

export type RepositoryRequestAuthorization =
  | { ok: true; repository: AuthorizedRepositoryContext }
  | { ok: false; response: Response };

export async function authorizeRepositoryRequest(
  c: Context,
  rawRepositoryId: string,
  operation: string,
): Promise<RepositoryRequestAuthorization> {
  const user = getAuthenticatedUser(c);
  if (!user) {
    return {
      ok: false,
      response: fail(c, { code: "unauthorized", message: "Authentication required" }, 401),
    };
  }

  let repositoryId: string;
  try {
    repositoryId = normalizeRepositoryId(rawRepositoryId).repositoryId;
    setRequestLogContext(c, { repositoryId, operation });
  } catch (error) {
    if (!(error instanceof RepositoryIdentityError)) throw error;
    logger.warn("malformed_repository_identity", {
      requestId: c.get("requestId"),
      userId: user.userId,
      route: c.req.path,
      operation,
      reasonCode: error.reasonCode,
    });
    return {
      ok: false,
      response: fail(c, { code: "validation_error", message: "Repository identity is invalid." }, 400),
    };
  }

  const access = await authorizeRepository({
    repositoryId,
    userId: user.userId,
    log: { requestId: c.get("requestId"), route: c.req.path, operation },
  });
  if (!access.ok) {
    return {
      ok: false,
      response: fail(c, { code: access.code, message: access.message }, access.status),
    };
  }
  return { ok: true, repository: access.repository };
}
