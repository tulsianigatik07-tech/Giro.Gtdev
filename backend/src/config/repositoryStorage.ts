import { constants, mkdirSync, realpathSync } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { env } from "./env.js";

export type CanonicalRepositoryStorageRoot = string & { readonly __storageRoot: unique symbol };

export function resolveRepositoryStorageRoot(configuredValue: string): CanonicalRepositoryStorageRoot {
  const value = configuredValue.trim();
  if (!value || value.includes("\0")) throw new Error("Repository storage root is invalid.");
  const absolute = path.resolve(value);
  const parsed = path.parse(absolute);
  if (absolute === parsed.root) throw new Error("Repository storage root cannot be a filesystem root.");
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  const canonical = realpathSync.native(absolute);
  if (canonical === path.parse(canonical).root) {
    throw new Error("Repository storage root cannot be a filesystem root.");
  }
  return canonical as CanonicalRepositoryStorageRoot;
}

export const repositoryStorageRoot = resolveRepositoryStorageRoot(env.REPOSITORY_STORAGE_ROOT);

export async function checkRepositoryStorageAccess(
  root: CanonicalRepositoryStorageRoot = repositoryStorageRoot,
  mode = constants.R_OK | constants.W_OK,
): Promise<void> {
  await access(root, mode);
}
