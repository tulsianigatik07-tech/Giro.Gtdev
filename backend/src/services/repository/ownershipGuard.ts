import { logger } from "../../lib/logger.js";
import { mapMaybePromise, type MaybePromise } from "../../lib/maybePromise.js";
import { repositoryCheckoutKey, repositoryCheckoutPath, type RepositoryCheckoutKey, type TrustedRepositoryCheckoutPath } from "../security/repositoryPaths.js";
import { normalizeRepositoryId, type RepositoryIdentity } from "../security/repositoryIdentity.js";
import { repositoryStore as runtimeRepositoryStore } from "./store/runtimeRepositoryStore.js";
import type { RepositoryRecord, RepositoryStore, RepositoryStoreStatus } from "./store/repositoryStore.js";

export type AuthorizedRepositoryContext = Readonly<{
  repositoryId: string;
  owner: string;
  repo: string;
  authenticatedUserId: string;
  indexedRevision: string | null;
  checkoutKey: RepositoryCheckoutKey;
  checkoutPath: TrustedRepositoryCheckoutPath;
  lifecycleState: RepositoryStoreStatus;
}>;

export type RepositoryAccessResult =
  | { ok: true; repository: AuthorizedRepositoryContext }
  | { ok: false; status: 403 | 404; code: string; message: string };

export type RepositoryConnectionAuthorization =
  | { ok: true; identity: RepositoryIdentity; existing: AuthorizedRepositoryContext | null }
  | { ok: false; status: 403; code: string; message: string };

export type RepositoryAuthorizationLogContext = Readonly<{
  requestId?: string;
  route?: string;
  operation?: string;
}>;

function recordMatchesIdentity(record: RepositoryRecord, identity: RepositoryIdentity): boolean {
  return record.repositoryId === identity.repositoryId &&
    record.owner === identity.owner &&
    record.repo === identity.repo;
}

function denial(
  status: 403 | 404,
  code: string,
  message: string,
  input: { userId: string; repositoryId: string; log?: RepositoryAuthorizationLogContext },
  reasonCode: string,
): RepositoryAccessResult {
  logger.warn("repository_authorization_denied", {
    requestId: input.log?.requestId,
    userId: input.userId,
    repositoryId: input.repositoryId,
    route: input.log?.route,
    operation: input.log?.operation,
    reasonCode,
  });
  return { ok: false, status, code, message };
}

export function authorizeRepository(input: {
  repositoryId: string;
  userId: string;
  store?: RepositoryStore;
  log?: RepositoryAuthorizationLogContext;
}): RepositoryAccessResult;
export function authorizeRepository(input: {
  repositoryId: string;
  userId: string;
  store?: RepositoryStore;
  log?: RepositoryAuthorizationLogContext;
}): MaybePromise<RepositoryAccessResult> {
  const identity = normalizeRepositoryId(input.repositoryId);
  const store = input.store ?? runtimeRepositoryStore;
  return mapMaybePromise(store.getRepository(identity.repositoryId), (record) => {
    if (!record || !recordMatchesIdentity(record, identity)) {
      return denial(
        404,
        "repo_not_connected",
        "Repository not connected. Call POST /repos/connect first.",
        { ...input, repositoryId: identity.repositoryId },
        record ? "repository_record_identity_mismatch" : "repository_not_found",
      );
    }
    if (!record.ownerUserId || record.ownerUserId !== input.userId) {
      return denial(
        403,
        "repo_not_owned",
        "You do not have access to this repository.",
        { ...input, repositoryId: identity.repositoryId },
        record.ownerUserId ? "repository_owner_mismatch" : "repository_owner_missing",
      );
    }
    return {
      ok: true,
      repository: Object.freeze({
        repositoryId: record.repositoryId,
        owner: record.owner,
        repo: record.repo,
        authenticatedUserId: input.userId,
        indexedRevision: record.indexedRevision,
        checkoutKey: repositoryCheckoutKey(record.repositoryId),
        checkoutPath: repositoryCheckoutPath(record.repositoryId),
        lifecycleState: record.status,
      }),
    };
  });
}

/** Compatibility name retained so existing callers converge on the canonical service. */
export function requireRepositoryAccess(input: {
  repoId: string;
  userId: string;
  store?: RepositoryStore;
  log?: RepositoryAuthorizationLogContext;
}): RepositoryAccessResult;
export function requireRepositoryAccess(input: {
  repoId: string;
  userId: string;
  store?: RepositoryStore;
  log?: RepositoryAuthorizationLogContext;
}): MaybePromise<RepositoryAccessResult> {
  return authorizeRepository({
    repositoryId: input.repoId,
    userId: input.userId,
    store: input.store,
    log: input.log,
  });
}

export function authorizeRepositoryConnection(input: {
  repositoryId: string;
  userId: string;
  store?: RepositoryStore;
  log?: RepositoryAuthorizationLogContext;
}): MaybePromise<RepositoryConnectionAuthorization> {
  const identity = normalizeRepositoryId(input.repositoryId);
  const store = input.store ?? runtimeRepositoryStore;
  return mapMaybePromise(store.getRepository(identity.repositoryId), (record) => {
    if (!record) return { ok: true, identity, existing: null };
    if (!recordMatchesIdentity(record, identity) || !record.ownerUserId || record.ownerUserId !== input.userId) {
      return denial(
        403,
        "repo_not_owned",
        "You do not have access to this repository.",
        { ...input, repositoryId: identity.repositoryId },
        record.ownerUserId ? "repository_owner_mismatch" : "repository_owner_missing",
      ) as Extract<RepositoryConnectionAuthorization, { ok: false }>;
    }
    return {
      ok: true,
      identity,
      existing: Object.freeze({
        repositoryId: record.repositoryId,
        owner: record.owner,
        repo: record.repo,
        authenticatedUserId: input.userId,
        indexedRevision: record.indexedRevision,
        checkoutKey: repositoryCheckoutKey(record.repositoryId),
        checkoutPath: repositoryCheckoutPath(record.repositoryId),
        lifecycleState: record.status,
      }),
    };
  });
}
