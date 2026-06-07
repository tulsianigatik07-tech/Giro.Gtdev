// JWT utilities built on Hono's built-in jwt (no external crypto libraries).

import { sign, verify } from "hono/jwt";
import { env } from "../../config/env.js";
import type { AuthTokenPayload } from "./authTypes.js";

const ALG = "HS256";
const BEARER_RE = /^Bearer$/i;

export async function signAccessToken(
  payload: AuthTokenPayload,
): Promise<string> {
  // Only userId + email are embedded; no sensitive data.
  return sign(
    { userId: payload.userId, email: payload.email },
    env.JWT_SECRET,
    ALG,
  );
}

function isValidPayload(value: unknown): value is AuthTokenPayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.userId === "string" && typeof record.email === "string";
}

export async function verifyAccessToken(
  token: string,
): Promise<AuthTokenPayload | null> {
  try {
    const decoded = await verify(token, env.JWT_SECRET, ALG);
    if (!isValidPayload(decoded)) return null;
    return { userId: decoded.userId, email: decoded.email };
  } catch {
    return null;
  }
}

export function parseBearerToken(
  header: string | undefined | null,
): string | null {
  if (typeof header !== "string") return null;
  const trimmed = header.trim();
  if (trimmed.length === 0) return null;

  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) return null;

  const scheme = trimmed.slice(0, spaceIdx);
  if (!BEARER_RE.test(scheme)) return null;

  const token = trimmed.slice(spaceIdx + 1).trim();
  if (token.length === 0) return null;

  return token;
}
