// Types for the repository chunking + context engine.

export type SourceFile = {
  filePath: string; // relative, forward-slash separated
  absolutePath: string;
  extension: string; // includes leading dot, e.g. '.ts'
  language: string;
  sizeBytes: number;
  content: string;
};

export type CodeChunk = {
  chunkId: string; // `${filePath}:${startLine}-${endLine}`
  filePath: string;
  startLine: number; // 1-based
  endLine: number; // 1-based, inclusive
  language: string;
  content: string;
  tokenEstimate: number; // Math.ceil(content.length / 4)
};

export type ContextBuildResult = {
  totalFilesRead: number;
  totalChunks: number;
  chunks: CodeChunk[];
};

export type {
  EnrichedContextChunk,
  EnrichedAssembledContext,
  EnrichedAssemblyRequest,
} from "./contextTypes.js";
