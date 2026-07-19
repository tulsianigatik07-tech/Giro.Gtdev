import { supabase } from "../../../lib/supabase.js";
import { env } from "../../../config/env.js";
import { SupabaseIndexingJobStore } from "./supabaseIndexingJobStore.js";

// Shared by the API and one-shot worker process. The injected server client
// must use the service role because indexing_jobs has no frontend RLS policies.
export const runtimeIndexingJobStore = new SupabaseIndexingJobStore({
  client: supabase,
  defaultMaxAttempts: env.INDEXING_WORKER_MAX_ATTEMPTS,
});
