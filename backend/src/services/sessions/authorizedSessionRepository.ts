import { logger } from "../../lib/logger.js";
import { authorizeRepository, type AuthorizedRepositoryContext } from "../repository/ownershipGuard.js";
import { normalizeRepositoryId } from "../security/repositoryIdentity.js";
import { getSessionById } from "./sessionService.js";
import type { Session } from "./types.js";

export type AuthorizedSessionRepositoryResult =
  | { ok: true; session: Session; repository: AuthorizedRepositoryContext }
  | { ok: false; status: 400 | 403 | 404; code: string; message: string };

export async function authorizeSessionRepository(input: {
  sessionId: string;
  userId: string;
  requestedRepositoryId?: string;
  requestId?: string;
  operation: string;
}): Promise<AuthorizedSessionRepositoryResult> {
  const session = await getSessionById(input.sessionId);
  if (!session) {
    return { ok: false, status: 404, code: "session_not_found", message: "Session not found" };
  }
  if (session.userId !== input.userId) {
    logger.warn("session_authorization_denied", {
      requestId: input.requestId,
      userId: input.userId,
      route: input.operation,
      reasonCode: "session_owner_mismatch",
    });
    return { ok: false, status: 403, code: "session_not_owned", message: "Session does not belong to authenticated user" };
  }

  const sessionRepositoryId = normalizeRepositoryId(`${session.owner}/${session.repo}`).repositoryId;
  if (input.requestedRepositoryId && normalizeRepositoryId(input.requestedRepositoryId).repositoryId !== sessionRepositoryId) {
    logger.warn("session_repository_mismatch", {
      requestId: input.requestId,
      userId: input.userId,
      repositoryId: sessionRepositoryId,
      route: input.operation,
      reasonCode: "session_repository_mismatch",
    });
    return { ok: false, status: 400, code: "session_repository_mismatch", message: "Session repository does not match the request." };
  }

  const repository = await authorizeRepository({
    repositoryId: sessionRepositoryId,
    userId: input.userId,
    log: { requestId: input.requestId, operation: input.operation },
  });
  if (!repository.ok) return repository;
  return { ok: true, session, repository: repository.repository };
}
