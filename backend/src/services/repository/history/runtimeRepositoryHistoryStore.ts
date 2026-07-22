import { env } from "../../../config/env.js";
import { supabase } from "../../../lib/supabase.js";
import { MemoryRepositoryHistoryStore } from "./memoryRepositoryHistoryStore.js";
import type { RepositoryHistoryStore } from "./repositoryHistoryStore.js";
import { SupabaseRepositoryHistoryStore } from "./supabaseRepositoryHistoryStore.js";

export const repositoryHistoryStore: RepositoryHistoryStore = env.NODE_ENV === "test"
  ? new MemoryRepositoryHistoryStore()
  : new SupabaseRepositoryHistoryStore(supabase);
