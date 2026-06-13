// Reusable middleware: validates that the authenticated user still owns the
// repository targeted by the session identified by the `:id` route param.
//
// Read-only validation only — never mutates session state, ownership store, or
// auth state. Intended to run AFTER authMiddleware() (which already enforces
// the 401 unauthorized / invalid_token cases). This factory is delivered for
// reuse and tested in isolation; it does not wire itself into any route.

import type { MiddlewareHandler } from "hono";
import { fail } from "../lib/response.js";
import { getAuthenticatedUser } from "../services/auth/authContext.js";
import { getSessionById } from "../services/sessions/sessionService.js";
import { requireRepositoryAccess } from "../services/repository/ownershipGuard.js";

export const requireSessionRepositoryOwnership = (): MiddlewareHandler => {
  return async (c, next) => {
    const user = getAuthenticatedUser(c);
    if (!user) {
      return fail(
        c,
        { code: "unauthorized", message: "Authentication required" },
        401,
      );
    }

    const id = c.req.param("id");
    const session = id ? getSessionById(id) : null;
    if (!session) {
      return fail(
        c,
        { code: "session_not_found", message: "Session not found" },
        404,
      );
    }

    const repoId = `${session.owner}/${session.repo}`;
    const result = requireRepositoryAccess({ repoId, userId: user.userId });
    if (!result.ok) {
      return fail(c, { code: result.code, message: result.message }, result.status);
    }

    await next();
  };
};
