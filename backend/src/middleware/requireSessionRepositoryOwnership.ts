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
import { authorizeSessionRepository } from "../services/sessions/authorizedSessionRepository.js";

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
    const result = await authorizeSessionRepository({
      sessionId: id ?? "",
      userId: user.userId,
      requestId: c.get("requestId"),
      operation: "session_repository_middleware",
    });
    if (!result.ok) {
      return fail(c, { code: result.code, message: result.message }, result.status);
    }

    await next();
  };
};
