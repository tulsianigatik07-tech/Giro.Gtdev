import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY;

if (!url || !key) {
  throw new Error("Missing env: SUPABASE_URL and SUPABASE_ANON_KEY are required");
}

export const supabase = createClient(url, key);
