import { z } from "zod";

const GITHUB_OWNER_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;
const GITHUB_REPOSITORY_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const HEX_SHA_PATTERN = /^[a-fA-F0-9]{40}$/;
const GITHUB_HTTPS_REPOSITORY_URL_PATTERN =
  /^https:\/\/github\.com\/([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?)\/([a-zA-Z0-9._-]+?)(?:\.git)?\/?$/;
const GITHUB_SSH_REPOSITORY_URL_PATTERN =
  /^git@github\.com:([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?)\/([a-zA-Z0-9._-]+?)\.git$/;

function freezeSchema<TSchema extends z.ZodTypeAny>(schema: TSchema): TSchema {
  if (schema instanceof z.ZodObject) {
    schema.safeParse({});
  }

  return Object.freeze(schema);
}

function hasPathTraversal(value: string): boolean {
  return (
    value === "." ||
    value === ".." ||
    value.includes("../") ||
    value.includes("..\\") ||
    value.includes("/..") ||
    value.includes("\\..")
  );
}

function hasControlCharacters(value: string): boolean {
  return CONTROL_CHARACTER_PATTERN.test(value);
}

function isValidRepositoryName(value: string): boolean {
  return (
    GITHUB_REPOSITORY_NAME_PATTERN.test(value) &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !hasPathTraversal(value) &&
    !hasControlCharacters(value)
  );
}

function isValidBranchName(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes("..") &&
    !/\s/.test(value) &&
    !hasPathTraversal(value) &&
    !hasControlCharacters(value)
  );
}

function isSafeRelativeFilePath(value: string): boolean {
  if (value.startsWith("/") || value.startsWith("\\")) return false;

  return value
    .replaceAll("\\", "/")
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

export const RepositoryOwnerSchema = freezeSchema(z
  .string()
  .trim()
  .min(1, "repository owner is required")
  .max(39, "repository owner must be 39 characters or fewer")
  .regex(
    GITHUB_OWNER_PATTERN,
    "repository owner must use GitHub-compatible characters",
  ));

export const RepositoryNameSchema = freezeSchema(z
  .string()
  .trim()
  .min(1, "repository name is required")
  .max(100, "repository name must be 100 characters or fewer")
  .refine(isValidRepositoryName, {
    message: "repository name must be GitHub-compatible and path-safe",
  }));

export const RepositoryIdSchema = freezeSchema(z
  .string()
  .trim()
  .transform((value, ctx) => {
    const parts = value.split("/");
    if (parts.length !== 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "repository id must be formatted as owner/repo",
      });
      return z.NEVER;
    }

    const [owner, repo] = parts as [string, string];
    const parsed = z.object({
      owner: RepositoryOwnerSchema,
      repo: RepositoryNameSchema,
    }).safeParse({ owner, repo });

    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue(issue);
      }
      return z.NEVER;
    }

    return `${parsed.data.owner}/${parsed.data.repo}`;
  }));

export const SessionIdSchema = freezeSchema(z
  .string()
  .trim()
  .min(1, "session id is required")
  .max(128, "session id is too long")
  .regex(/^[a-zA-Z0-9._:-]+$/, "session id contains invalid characters"));

export const IndexingJobIdSchema = freezeSchema(z
  .string()
  .trim()
  .min(1, "indexing job id is required")
  .max(128, "indexing job id is too long")
  .regex(/^[a-zA-Z0-9._:-]+$/, "indexing job id contains invalid characters")
  .refine((value) => !hasPathTraversal(value), {
    message: "indexing job id must not contain path traversal",
  })
  .refine((value) => !hasControlCharacters(value), {
    message: "indexing job id must not contain control characters",
  }));

export const GithubRepositoryUrlSchema = freezeSchema(z
  .string()
  .trim()
  .superRefine((value, ctx) => {
    const match =
      value.match(GITHUB_HTTPS_REPOSITORY_URL_PATTERN) ??
      value.match(GITHUB_SSH_REPOSITORY_URL_PATTERN);

    if (!match) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "repository URL must be a valid GitHub repository URL",
      });
      return;
    }

    const owner = match[1] ?? "";
    const repo = match[2] ?? "";
    const parsed = z.object({
      owner: RepositoryOwnerSchema,
      repo: RepositoryNameSchema,
    }).safeParse({ owner, repo });

    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue(issue);
      }
    }
  }));

export const BranchNameSchema = freezeSchema(z
  .string()
  .trim()
  .min(1, "branch name is required")
  .max(255, "branch name is too long")
  .refine(isValidBranchName, {
    message: "branch name must be path-safe and contain no spaces",
  }));

export const CommitShaSchema = freezeSchema(z
  .string()
  .trim()
  .regex(HEX_SHA_PATTERN, "commit SHA must be 40 hexadecimal characters"));

export const FilePathSchema = freezeSchema(z
  .string()
  .trim()
  .min(1, "file path is required")
  .max(1000, "file path is too long")
  .refine((value) => !hasControlCharacters(value), {
    message: "file path must not contain control characters",
  })
  .refine(isSafeRelativeFilePath, {
    message: "file path must not contain path traversal",
  }));

export const QuestionTextSchema = freezeSchema(z
  .string()
  .trim()
  .min(1, "question is required")
  .max(4000, "question must be 4000 characters or fewer"));

export const SearchQuerySchema = freezeSchema(z
  .string()
  .trim()
  .max(500, "search query must be 500 characters or fewer"));

export const PaginationSchema = freezeSchema(z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
}));

export const ChunkLimitSchema = freezeSchema(z.coerce
  .number()
  .int()
  .min(1)
  .max(500, "chunk limit must be 500 or fewer"));

export function createPayloadSizeSchema(maxBytes: number) {
  return freezeSchema(z
    .string()
    .refine((value) => Buffer.byteLength(value, "utf8") <= maxBytes, {
      message: `payload must be ${maxBytes} bytes or fewer`,
    }));
}

export const CloneOptionsSchema = freezeSchema(z.object({
  branch: BranchNameSchema.optional(),
  shallow: z.boolean().default(true),
  recursive: z.boolean().default(false),
}));

export type RepositoryOwner = z.infer<typeof RepositoryOwnerSchema>;
export type RepositoryName = z.infer<typeof RepositoryNameSchema>;
export type RepositoryId = z.infer<typeof RepositoryIdSchema>;
export type SessionId = z.infer<typeof SessionIdSchema>;
export type IndexingJobId = z.infer<typeof IndexingJobIdSchema>;
export type GithubRepositoryUrl = z.infer<typeof GithubRepositoryUrlSchema>;
export type BranchName = z.infer<typeof BranchNameSchema>;
export type CommitSha = z.infer<typeof CommitShaSchema>;
export type RepositoryFilePath = z.infer<typeof FilePathSchema>;
export type QuestionText = z.infer<typeof QuestionTextSchema>;
export type SearchQuery = z.infer<typeof SearchQuerySchema>;
export type Pagination = z.infer<typeof PaginationSchema>;
export type ChunkLimit = z.infer<typeof ChunkLimitSchema>;
export type CloneOptions = z.infer<typeof CloneOptionsSchema>;
