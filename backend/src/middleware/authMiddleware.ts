// JWT auth middleware factory. Defined only — NOT registered anywhere.
// Verifies a Bearer token and stores the authenticated user on the context.

import type { MiddlewareHandler } from "hono";
import { fail } from "../lib/response.js";
import { parseBearerToken, verifyAccessToken } from "../services/auth/jwt.js";
import { setAuthenticatedUser } from "../services/auth/authContext.js";

export const authMiddleware = (): MiddlewareHandler => {
  return async (c, next) => {
    const token = parseBearerToken(c.req.header("Authorization"));
    if (!token) {
      return fail(
        c,
        { code: "unauthorized", message: "Missing or malformed Authorization header" },
        401,
      );
    }

    const payload = await verifyAccessToken(token);
    if (!payload) {
      return fail(c, { code: "invalid_token", message: "Invalid token" }, 401);
    }

    setAuthenticatedUser(c, { userId: payload.userId, email: payload.email });
    await next();
  };
};
