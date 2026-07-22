import { env } from "../../config/env.js";
import { supabase } from "../../lib/supabase.js";
import { MemoryRateLimitStore } from "./memoryRateLimitStore.js";
import type { RateLimitStore } from "./rateLimitStore.js";
import { SupabaseRateLimitStore } from "./supabaseRateLimitStore.js";

export const rateLimitBackend = env.RATE_LIMIT_BACKEND ?? (
  env.NODE_ENV === "production" ? "supabase" : "memory"
);

export const runtimeRateLimitStore: RateLimitStore = rateLimitBackend === "supabase"
  ? new SupabaseRateLimitStore(supabase)
  : new MemoryRateLimitStore();
