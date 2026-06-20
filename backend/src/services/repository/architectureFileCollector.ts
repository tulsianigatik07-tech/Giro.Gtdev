export interface ArchitectureFileCollectorInput {
    filePaths: readonly string[];
    ignoredPrefixes?: readonly string[];
  }
  
  export interface ArchitectureFileCollectorResult {
    files: readonly string[];
    ignored: readonly string[];
    totalInput: number;
    totalCollected: number;
    totalIgnored: number;
  }
  
  const DEFAULT_IGNORED_PREFIXES = [
    "node_modules/",
    ".git/",
    "dist/",
    "build/",
    "coverage/",
  ] as const;
  
  function normalizeFilePath(filePath: string): string {
    return filePath.trim().replaceAll("\\", "/").replace(/^\.\/+/, "");
  }
  
  function shouldIgnoreFile(
    filePath: string,
    ignoredPrefixes: readonly string[],
  ): boolean {
    return ignoredPrefixes.some((prefix) => filePath.startsWith(prefix));
  }
  
  export function collectArchitectureFiles(
    input: ArchitectureFileCollectorInput,
  ): ArchitectureFileCollectorResult {
    const ignoredPrefixes = input.ignoredPrefixes ?? DEFAULT_IGNORED_PREFIXES;
  
    const uniqueFiles = new Set<string>();
    const ignoredFiles = new Set<string>();
  
    for (const rawPath of input.filePaths) {
      const filePath = normalizeFilePath(rawPath);
  
      if (filePath.length === 0) {
        continue;
      }
  
      if (shouldIgnoreFile(filePath, ignoredPrefixes)) {
        ignoredFiles.add(filePath);
        continue;
      }
  
      uniqueFiles.add(filePath);
    }
  
    const files = [...uniqueFiles].sort();
    const ignored = [...ignoredFiles].sort();
  
    return {
      files,
      ignored,
      totalInput: input.filePaths.length,
      totalCollected: files.length,
      totalIgnored: ignored.length,
    };
  }