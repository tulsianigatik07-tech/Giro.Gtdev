import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { validateRepoPath, validateSafePath, MAX_FILE_SIZE } from "./validate.js";
import { detectLanguageFromExtension } from "../context/language.js";
import type { FileReadResult } from "./types.js";

export async function readFileContents(
  repoPath: string,
  relativePath: string,
): Promise<FileReadResult> {
  validateRepoPath(repoPath);
  const absolute = validateSafePath(repoPath, relativePath);

  const info = await stat(absolute);
  if (info.isDirectory()) throw new Error("Path is a directory");
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
