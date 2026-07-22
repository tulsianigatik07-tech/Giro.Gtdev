import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { shouldIgnoreFile, shouldIgnorePath, IGNORED_DIRS } from "../ignore.js";
import { resolveRepositoryPath, type TrustedRepositoryCheckoutPath } from "../../security/repositoryPaths.js";
import { assertRepositoryQuota, runtimeRepositoryQuotas, type RepositoryQuotas } from "./repositoryQuota.js";

export interface QuotaScannedFile {
  filePath: string;
  size: number;
  language: string;
}

export interface RepositoryQuotaScan {
  repositoryBytes: number;
  indexedTextBytes: number;
  sourceFileCount: number;
  directoryCount: number;
  symlinkCount: number;
  binaryFileCount: number;
  languages: Record<string, number>;
  files: QuotaScannedFile[];
}

async function isBinaryFile(file: string, size: number): Promise<boolean> {
  if (size === 0) return false;
  const handle = await open(file, "r");
  try {
    const sample = Buffer.allocUnsafe(Math.min(size, 8_192));
    const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
    return sample.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

export async function scanRepositoryQuota(
  checkout: TrustedRepositoryCheckoutPath,
  quotas: RepositoryQuotas = runtimeRepositoryQuotas,
  signal?: AbortSignal,
): Promise<RepositoryQuotaScan> {
  const result: RepositoryQuotaScan = {
    repositoryBytes: 0,
    indexedTextBytes: 0,
    sourceFileCount: 0,
    directoryCount: 0,
    symlinkCount: 0,
    binaryFileCount: 0,
    languages: {},
    files: [],
  };

  async function walk(directory: string, relative: string, inGit: boolean): Promise<void> {
    signal?.throwIfAborted();
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      signal?.throwIfAborted();
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const gitEntry = inGit || childRelative === ".git";
      if (entry.isSymbolicLink()) {
        if (!gitEntry) {
          result.symlinkCount += 1;
          assertRepositoryQuota("symlink_count", result.symlinkCount, quotas.maxSymlinks);
        }
        continue;
      }
      if (entry.isDirectory()) {
        if (!gitEntry) {
          const depth = childRelative.split("/").length;
          assertRepositoryQuota("directory_depth", depth, quotas.maxDirectoryDepth);
          result.directoryCount += 1;
        }
        const safeDirectory = await resolveRepositoryPath(checkout, childRelative, {
          mustExist: true,
          requireDirectory: true,
        });
        await walk(safeDirectory, childRelative, gitEntry);
        continue;
      }
      if (!entry.isFile()) continue;
      const safeFile = await resolveRepositoryPath(checkout, childRelative, { mustExist: true, requireFile: true });
      const info = await stat(safeFile);
      result.repositoryBytes += info.size;
      assertRepositoryQuota("repository_size", result.repositoryBytes, quotas.maxRepositoryBytes);
      if (gitEntry) continue;
      result.sourceFileCount += 1;
      assertRepositoryQuota("file_count", result.sourceFileCount, quotas.maxFiles);
      assertRepositoryQuota("file_size", info.size, quotas.maxFileBytes);
      const binary = await isBinaryFile(safeFile, info.size);
      if (binary) {
        result.binaryFileCount += 1;
        assertRepositoryQuota("binary_file_count", result.binaryFileCount, quotas.maxBinaryFiles);
        continue;
      }
      if (shouldIgnorePath(childRelative) || shouldIgnoreFile(entry.name) ||
        childRelative.split("/").some((part) => IGNORED_DIRS.has(part))) continue;
      result.indexedTextBytes += info.size;
      assertRepositoryQuota("indexed_text_bytes", result.indexedTextBytes, quotas.maxIndexedTextBytes);
      const extension = path.extname(entry.name).toLowerCase() || "none";
      result.languages[extension] = (result.languages[extension] ?? 0) + 1;
      result.files.push({ filePath: childRelative, size: info.size, language: extension });
    }
  }

  await walk(checkout, "", false);
  result.files.sort((left, right) => left.filePath.localeCompare(right.filePath));
  return result;
}
