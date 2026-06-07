// Typed helpers for storing/reading the authenticated user on the Hono context.

import type { Context } from "hono";
import type { AuthenticatedUser } from "./authTypes.js";

export type AuthVariables = {
  authenticatedUser: AuthenticatedUser;
};

const KEY = "authenticatedUser";

export function setAuthenticatedUser(c: Context, user: AuthenticatedUser): void {
  c.set(KEY, user);
}

export function getAuthenticatedUser(c: Context): AuthenticatedUser | undefined {
  return c.get(KEY) as AuthenticatedUser | undefined;
}

export function requireAuthenticatedUser(c: Context): AuthenticatedUser {
  const user = getAuthenticatedUser(c);
  if (!user) {
    throw new Error("Authenticated user is required");
  }
  return user;
}
