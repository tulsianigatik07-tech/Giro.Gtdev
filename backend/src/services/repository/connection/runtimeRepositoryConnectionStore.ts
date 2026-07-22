import { supabase } from "../../../lib/supabase.js";
import { SupabaseRepositoryConnectionStore } from "./supabaseRepositoryConnectionStore.js";

export const runtimeRepositoryConnectionStore = new SupabaseRepositoryConnectionStore(supabase);
