import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { processLock } from "@supabase/auth-js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config";

// Browser Supabase client (singleton). persistSession uses localStorage in the
// browser and falls back to in-memory storage during SSR — safe either way.
// detectSessionInUrl handles the password-reset / magic-link return.

// supabase-js serializes auth calls behind a Web Locks API lock SHARED across all
// tabs of the origin. With many tabs open, that cross-tab contention made every
// auth call (getSession/updateUser/signOut) slow and could deadlock and freeze the
// app. Use the library's in-memory `processLock` instead: it still serializes auth
// calls WITHIN a tab, but never waits on — or deadlocks against — other tabs.
let _client: SupabaseClient | null = null;

function makeClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
      flowType: "pkce",
      lock: processLock,
    },
  });
}

export function getSupabase(): SupabaseClient {
  if (!_client) _client = makeClient();
  return _client;
}

export const supabase = getSupabase();
