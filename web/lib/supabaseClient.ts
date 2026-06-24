import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config";

// Browser Supabase client (singleton). persistSession uses localStorage in the
// browser and falls back to in-memory storage during SSR — safe either way.
// detectSessionInUrl handles the password-reset / magic-link return.
let _client: SupabaseClient | null = null;

function makeClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
      flowType: "pkce",
    },
  });
}

export function getSupabase(): SupabaseClient {
  if (!_client) _client = makeClient();
  return _client;
}

export const supabase = getSupabase();
