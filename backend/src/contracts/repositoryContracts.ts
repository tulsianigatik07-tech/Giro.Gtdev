import { z } from "zod";
import { RepositoryNameSchema, RepositoryOwnerSchema } from "../validation/repositorySchemas.js";
import { normalizeRepositoryId } from "../services/security/repositoryIdentity.js";

export { RepositoryOwnerSchema, RepositoryNameSchema };

export const RepositoryIdentifierSchema = z
  .string()
  .trim()
  .transform((value, ctx) => {
    try {
      const identity = normalizeRepositoryId(value);
      return { owner: identity.owner, repo: identity.repo };
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "repository identifier must be 'owner/repo'",
      });
      return z.NEVER;
    }
  });

export const RepositoryConnectRequestSchema = z.object({
  repoUrl: z.string().trim().min(1, "repoUrl is required"),
});

export const RepositoryCleanupRequestSchema = z.object({
  owner: RepositoryOwnerSchema,
  repo: RepositoryNameSchema,
});

export const RepositoryWorkspaceParamsSchema = z.object({
  owner: RepositoryOwnerSchema,
  repo: RepositoryNameSchema,
});

export const RepositoryDashboardParamsSchema = z.object({
  owner: RepositoryOwnerSchema,
  repo: RepositoryNameSchema,
});

export function parseRepositoryIdentifier(
  identifier: string,
): z.infer<typeof RepositoryIdentifierSchema> {
  return RepositoryIdentifierSchema.parse(identifier);
}

export function validateRepositoryOwner(owner: string): string {
  return RepositoryOwnerSchema.parse(owner);
}

export function validateRepositoryName(repo: string): string {
  return RepositoryNameSchema.parse(repo);
}
