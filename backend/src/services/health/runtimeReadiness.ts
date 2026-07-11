import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "../../config/env.js";
import { supabase } from "../../lib/supabase.js";
import type { IndexingJobStore } from "../indexing/jobs/indexingJobStore.js";
import { runtimeIndexingJobStore } from "../indexing/jobs/runtimeIndexingJobStore.js";
import {
  checkApplicationReadiness,
  type ApplicationReadiness,
  type ReadinessCheckDefinition,
} from "./readinessService.js";

type SupabaseProbeResult = { error: unknown };

async function probeTable(
  client: SupabaseClient,
  table: string,
  column: string,
): Promise<void> {
  const result = (await client.from(table).select(column).limit(1)) as SupabaseProbeResult;
  if (result.error) throw new Error("Dependency probe failed.");
}

function requireOpenAiConfiguration(): void {
  if (!env.OPENAI_API_KEY) {
    throw new Error("Required configuration is unavailable.");
  }
}

async function requireStorageAccess(): Promise<void> {
  const storageParent = path.join(process.cwd(), ".storage");
  try {
    await access(storageParent, constants.R_OK | constants.W_OK);
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      throw error;
    }
    await access(process.cwd(), constants.R_OK | constants.W_OK);
  }
}

function requireRuntimeInitialization(jobStore: IndexingJobStore): void {
  if (!jobStore || typeof jobStore.listJobs !== "function") {
    throw new Error("Runtime dependency is unavailable.");
  }
}

export function createRuntimeReadinessCheck(options: {
  client?: SupabaseClient;
  indexingJobStore?: IndexingJobStore;
  isShuttingDown?: () => boolean;
} = {}): () => Promise<ApplicationReadiness> {
  const client = options.client ?? supabase;
  const indexingJobStore = options.indexingJobStore ?? runtimeIndexingJobStore;
  const checks: readonly ReadinessCheckDefinition[] = [
    {
      name: "database",
      critical: true,
      successMessage: "Database connectivity is available.",
      failureMessage: "Database connectivity is unavailable.",
      check: () => probeTable(client, "repositories", "repository_id"),
    },
    {
      name: "indexing_store",
      critical: true,
      successMessage: "Indexing job store is available.",
      failureMessage: "Indexing job store is unavailable.",
      check: () => probeTable(client, "indexing_jobs", "job_id"),
    },
    {
      name: "openai_configuration",
      critical: true,
      successMessage: "OpenAI configuration is available.",
      failureMessage: "OpenAI configuration is missing.",
      check: requireOpenAiConfiguration,
    },
    {
      name: "storage",
      critical: true,
      successMessage: "Repository storage is available.",
      failureMessage: "Repository storage is unavailable.",
      check: requireStorageAccess,
    },
    {
      name: "runtime_initialization",
      critical: true,
      successMessage: "Runtime dependencies are initialized.",
      failureMessage: "Runtime dependencies are not initialized.",
      check: () => requireRuntimeInitialization(indexingJobStore),
    },
  ];

  return () => {
    if (options.isShuttingDown?.()) {
      return Promise.resolve(
        Object.freeze({
          status: "not_ready",
          checks: Object.freeze([
            Object.freeze({
              name: "runtime_shutdown",
              status: "fail",
              critical: true,
              message: "Application shutdown is in progress.",
            }),
          ]),
        }),
      );
    }
    return checkApplicationReadiness(checks);
  };
}
