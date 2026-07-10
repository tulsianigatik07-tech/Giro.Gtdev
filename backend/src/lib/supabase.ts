import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY;

if (!url || !key) {
  throw new Error(
    "Missing env: SUPABASE_URL and a server-side Supabase key are required",
  );
}

export const supabase = createClient(url, key);
