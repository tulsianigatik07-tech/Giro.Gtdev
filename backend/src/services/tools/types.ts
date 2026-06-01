export interface FileReadResult {
  filePath: string;
  content: string;
  lineCount: number;
  language: string;
  sizeBytes: number;
}

export interface GrepMatch {
  filePath: string;
  lineNumber: number;
  matchedLine: string;
}

export interface GrepResult {
  query: string;
  totalMatches: number;
  truncated: boolean;
  matches: GrepMatch[];
}

export interface DirectoryEntry {
  name: string;
  type: "file" | "directory";
  sizeBytes: number;
  modifiedAt: string;
}

export interface DirectoryListing {
  path: string;
  entries: DirectoryEntry[];
}

export interface SymbolMatch {
  symbol: string;
  filePath: string;
  lineNumber: number;
  matchedLine: string;
}

export interface FileTreeNode {
  name: string;
  type: "file" | "directory";
  children?: FileTreeNode[];
}
