import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { validateSafePath, MAX_FILE_SIZE } from "./validate.js";
import type { TrustedRepositoryCheckoutPath } from "../security/repositoryPaths.js";
import { detectLanguageFromExtension } from "../context/language.js";
import type { FileReadResult } from "./types.js";

export async function readFileContents(
  repoPath: TrustedRepositoryCheckoutPath,
  relativePath: string,
): Promise<FileReadResult> {
  const absolute = await validateSafePath(repoPath, relativePath, { requireFile: true });

  const info = await stat(absolute);
  if (!info.isFile()) throw new Error("Path is not a regular file");
  if (info.size > MAX_FILE_SIZE) throw new Error("File exceeds 512KB limit");

  const content = await readFile(absolute, "utf-8");
  const ext = path.extname(relativePath).toLowerCase();

  return {
    filePath: relativePath.replace(/\\/g, "/"),
    content,
    lineCount: content.split("\n").length,
    language: detectLanguageFromExtension(ext),
    sizeBytes: info.size,
  };
}
