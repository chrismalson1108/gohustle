"use client";

import { createBrowserClient } from "@supabase/ssr";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config";
import type { SupabaseClient } from "@supabase/supabase-js";

// Browser client for the login / MFA pages only (cookie-persisted session so
// the server can read it). Console pages never query Supabase from the client.
let _client: SupabaseClient | null = null;

export function getBrowserSupabase(): SupabaseClient {
  if (!_client) _client = createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return _client;
}
