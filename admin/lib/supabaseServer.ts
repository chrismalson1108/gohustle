import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config";

// Cookie-backed Supabase client for server components / server actions. Runs as
// the SIGNED-IN ADMIN (anon key + their session) — used only to establish
// identity (getUser / AAL). All data access goes through the service client
// after requireAdmin() passes.
export async function getServerSupabase() {
  const cookieStore = await cookies();
  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // Server components can't set cookies — token refresh cookies are
          // written by proxy.ts / server actions instead. Safe to ignore.
        }
      },
    },
  });
}
