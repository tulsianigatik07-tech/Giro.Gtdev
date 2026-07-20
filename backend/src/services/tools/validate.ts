import { resolveRepositoryPath, type TrustedRepositoryCheckoutPath } from "../security/repositoryPaths.js";

export const MAX_FILE_SIZE = 512 * 1024;
export const MAX_GREP_RESULTS = 100;
export const MAX_TREE_DEPTH = 6;

export function validateSafePath(
  repoPath: TrustedRepositoryCheckoutPath,
  relativePath: string,
  options: { allowCheckoutRoot?: boolean; requireFile?: boolean; requireDirectory?: boolean } = {},
) {
  return resolveRepositoryPath(repoPath, relativePath, { ...options, mustExist: true });
}
