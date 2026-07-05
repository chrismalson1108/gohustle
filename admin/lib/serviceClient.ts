import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_URL } from "./config";

// Service-role client — bypasses RLS. MUST only be used after requireAdmin()
// has vouched for the caller. The 'server-only' import makes any accidental
// client-bundle inclusion a build error.
let _service: SupabaseClient | null = null;

export function getServiceClient(): SupabaseClient {
  if (!_service) {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
    _service = createClient(SUPABASE_URL, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _service;
}
