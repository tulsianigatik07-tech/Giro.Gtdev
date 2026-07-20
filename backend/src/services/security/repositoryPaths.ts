import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { lstatSync, realpathSync, statSync } from "node:fs";
import {
  repositoryStorageRoot,
  type CanonicalRepositoryStorageRoot,
} from "../../config/repositoryStorage.js";
import { normalizeRepositoryId } from "./repositoryIdentity.js";

export type RepositoryCheckoutKey = string & { readonly __checkoutKey: unique symbol };
export type TrustedRepositoryCheckoutPath = string & { readonly __checkoutPath: unique symbol };
export type TrustedRepositoryFilePath = string & { readonly __repositoryFilePath: unique symbol };

export type RepositoryPathReason =
  | "invalid_path"
  | "absolute_path_attempt"
  | "path_traversal_attempt"
  | "symlink_escape_attempt"
  | "unsafe_checkout"
  | "unsafe_cleanup_rejection";

export class RepositoryPathSecurityError extends Error {
  readonly reasonCode: RepositoryPathReason;

  constructor(reasonCode: RepositoryPathReason, message = "Repository path is not allowed.") {
    super(message);
    this.name = "RepositoryPathSecurityError";
    this.reasonCode = reasonCode;
  }
}

function isContained(parent: string, candidate: string, allowSame: boolean): boolean {
  const relative = path.relative(parent, candidate);
  if (relative === "") return allowSame;
  return !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function assertNoInvalidCharacters(value: string): void {
  if (!value || value.includes("\0") || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new RepositoryPathSecurityError("invalid_path");
  }
}

function rejectEncodedTraversal(value: string): void {
  let decoded = value;
  for (let depth = 0; depth < 3; depth += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) return;
      if (
        path.isAbsolute(next) ||
        path.win32.isAbsolute(next) ||
        next.replaceAll("\\", "/").split("/").some((part) => part === "..")
      ) {
        throw new RepositoryPathSecurityError("path_traversal_attempt");
      }
      decoded = next;
    } catch (error) {
      if (error instanceof RepositoryPathSecurityError) throw error;
      throw new RepositoryPathSecurityError("invalid_path");
    }
  }
}

function validateRelativePath(childPath: string, allowEmpty: boolean): string {
  const input = childPath.trim();
  if (allowEmpty && (input === "" || input === ".")) return "";
  assertNoInvalidCharacters(input);
  rejectEncodedTraversal(input);
  if (path.isAbsolute(input) || path.win32.isAbsolute(input) || input.startsWith("\\")) {
    throw new RepositoryPathSecurityError("absolute_path_attempt");
  }
  const normalizedSeparators = input.replaceAll("\\", "/");
  const parts = normalizedSeparators.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new RepositoryPathSecurityError("path_traversal_attempt");
  }
  return parts.join(path.sep);
}

export function repositoryCheckoutKey(repositoryId: string): RepositoryCheckoutKey {
  const identity = normalizeRepositoryId(repositoryId);
  return `repo-${createHash("sha256").update(identity.repositoryId, "utf8").digest("hex")}` as RepositoryCheckoutKey;
}

export function repositoryCheckoutPath(
  repositoryId: string,
  storageRoot: CanonicalRepositoryStorageRoot = repositoryStorageRoot,
): TrustedRepositoryCheckoutPath {
  const target = path.resolve(storageRoot, repositoryCheckoutKey(repositoryId));
  if (!isContained(storageRoot, target, false)) {
    throw new RepositoryPathSecurityError("unsafe_checkout");
  }
  return target as TrustedRepositoryCheckoutPath;
}

export async function validateRepositoryCheckout(
  repositoryId: string,
  options: { mustExist?: boolean; storageRoot?: CanonicalRepositoryStorageRoot } = {},
): Promise<TrustedRepositoryCheckoutPath> {
  const storageRoot = options.storageRoot ?? repositoryStorageRoot;
  const checkout = repositoryCheckoutPath(repositoryId, storageRoot);
  let checkoutInfo;
  try {
    checkoutInfo = await lstat(checkout);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !options.mustExist) return checkout;
    throw new RepositoryPathSecurityError("unsafe_checkout", "Repository checkout is unavailable.");
  }
  if (checkoutInfo.isSymbolicLink() || !checkoutInfo.isDirectory()) {
    throw new RepositoryPathSecurityError("unsafe_checkout", "Repository checkout is unsafe.");
  }
  const canonical = await realpath(checkout);
  if (!isContained(storageRoot, canonical, false) || canonical !== checkout) {
    throw new RepositoryPathSecurityError("symlink_escape_attempt");
  }
  return canonical as TrustedRepositoryCheckoutPath;
}

export async function ensureRepositoryStorageRoot(): Promise<void> {
  await mkdir(repositoryStorageRoot, { recursive: true, mode: 0o700 });
}

export async function resolveRepositoryPath(
  checkout: TrustedRepositoryCheckoutPath,
  childPath: string,
  options: {
    allowCheckoutRoot?: boolean;
    mustExist?: boolean;
    requireFile?: boolean;
    requireDirectory?: boolean;
  } = {},
): Promise<TrustedRepositoryFilePath> {
  const relative = validateRelativePath(childPath, options.allowCheckoutRoot === true);
  const lexical = path.resolve(checkout, relative);
  if (!isContained(checkout, lexical, options.allowCheckoutRoot === true)) {
    throw new RepositoryPathSecurityError("path_traversal_attempt");
  }

  let info;
  try {
    info = await lstat(lexical);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !options.mustExist) {
      return lexical as TrustedRepositoryFilePath;
    }
    throw new RepositoryPathSecurityError("invalid_path", "Repository path is unavailable.");
  }

  let canonical = lexical;
  if (info.isSymbolicLink()) {
    try {
      canonical = await realpath(lexical);
    } catch {
      throw new RepositoryPathSecurityError("symlink_escape_attempt", "Repository symlink is unavailable.");
    }
    if (!isContained(checkout, canonical, options.allowCheckoutRoot === true)) {
      throw new RepositoryPathSecurityError("symlink_escape_attempt");
    }
  } else {
    canonical = await realpath(lexical);
    if (!isContained(checkout, canonical, options.allowCheckoutRoot === true)) {
      throw new RepositoryPathSecurityError("symlink_escape_attempt");
    }
  }

  const targetInfo = info.isSymbolicLink() ? await stat(canonical) : info;
  if (options.requireFile && !targetInfo.isFile()) {
    throw new RepositoryPathSecurityError("invalid_path", "Repository path is not a regular file.");
  }
  if (options.requireDirectory && !targetInfo.isDirectory()) {
    throw new RepositoryPathSecurityError("invalid_path", "Repository path is not a directory.");
  }
  return canonical as TrustedRepositoryFilePath;
}

export async function removeRepositoryCheckout(
  repositoryId: string,
  options: { storageRoot?: CanonicalRepositoryStorageRoot } = {},
): Promise<boolean> {
  const storageRoot = options.storageRoot ?? repositoryStorageRoot;
  const checkout = repositoryCheckoutPath(repositoryId, storageRoot);
  if ((checkout as string) === (storageRoot as string) || path.dirname(checkout) !== storageRoot) {
    throw new RepositoryPathSecurityError("unsafe_cleanup_rejection");
  }
  try {
    const info = await lstat(checkout);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new RepositoryPathSecurityError("unsafe_cleanup_rejection");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  await validateRepositoryCheckout(repositoryId, { mustExist: true, storageRoot });
  await rm(checkout, { recursive: true, force: false, maxRetries: 2 });
  return true;
}

export async function collectContainedDirectories(
  checkout: TrustedRepositoryCheckoutPath,
  options: { ignore?: (relativePath: string, name: string) => boolean } = {},
): Promise<string[]> {
  const found: string[] = [];
  const pending: Array<{ absolute: string; relative: string }> = [{ absolute: checkout, relative: "" }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    let entries;
    try {
      entries = await readdir(current.absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      if (options.ignore?.(relative, entry.name)) continue;
      try {
        const absolute = await resolveRepositoryPath(checkout, relative, { mustExist: true, requireDirectory: true });
        found.push(relative);
        pending.push({ absolute, relative });
      } catch { /* skip unsafe or raced directories */ }
    }
  }
  return found.sort((left, right) => left.localeCompare(right));
}

export function isRepositoryPathSecurityError(error: unknown): error is RepositoryPathSecurityError {
  return error instanceof RepositoryPathSecurityError;
}

export function resolveRepositoryPathSync(
  checkout: TrustedRepositoryCheckoutPath,
  childPath: string,
  options: { requireFile?: boolean; requireDirectory?: boolean } = {},
): TrustedRepositoryFilePath {
  const relative = validateRelativePath(childPath, false);
  const lexical = path.resolve(checkout, relative);
  if (!isContained(checkout, lexical, false)) throw new RepositoryPathSecurityError("path_traversal_attempt");
  let info;
  try {
    info = lstatSync(lexical);
  } catch {
    throw new RepositoryPathSecurityError("invalid_path", "Repository path is unavailable.");
  }
  let canonical: string;
  try {
    canonical = realpathSync.native(lexical);
  } catch {
    throw new RepositoryPathSecurityError(info.isSymbolicLink() ? "symlink_escape_attempt" : "invalid_path");
  }
  if (!isContained(checkout, canonical, false)) throw new RepositoryPathSecurityError("symlink_escape_attempt");
  const targetInfo = info.isSymbolicLink() ? statSync(canonical) : info;
  if (options.requireFile && !targetInfo.isFile()) throw new RepositoryPathSecurityError("invalid_path");
  if (options.requireDirectory && !targetInfo.isDirectory()) throw new RepositoryPathSecurityError("invalid_path");
  return canonical as TrustedRepositoryFilePath;
}
