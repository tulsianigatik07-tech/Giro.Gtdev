import { createClient } from "@supabase/supabase-js";
import { env } from "../config/env.js";

const key = env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_ANON_KEY!;

export const supabase = createClient(env.SUPABASE_URL, key);
