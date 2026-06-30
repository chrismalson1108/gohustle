import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config";

// Browser Supabase client (singleton). persistSession uses localStorage in the
// browser and falls back to in-memory storage during SSR — safe either way.
// detectSessionInUrl handles the password-reset / magic-link return.

// supabase-js serializes every auth call behind a Web Locks API lock that is
// shared across ALL tabs of the origin. If one tab holds it while stuck (a
// backgrounded or hung tab), getSession()/updateUser()/etc. in other tabs wait
// on it forever — which froze the confirm-email and password-reset flows on an
// infinite spinner. This replacement keeps the normal cross-tab coordination but
// waits at most a few seconds to acquire the lock, then proceeds WITHOUT it
// rather than deadlocking.
async function nonDeadlockingLock<R>(
  name: string,
  acquireTimeout: number,
  fn: () => Promise<R>,
): Promise<R> {
  if (typeof navigator === "undefined" || !navigator.locks?.request) return fn();
  const timeout = acquireTimeout > 0 ? acquireTimeout : 5000;
  try {
    return await navigator.locks.request(
      name,
      { mode: "exclusive", signal: AbortSignal.timeout(timeout) },
      fn,
    );
  } catch (err) {
    const errName = (err as { name?: string } | null)?.name;
    // Couldn't acquire the lock before the timeout — run anyway instead of
    // hanging. (A real error thrown by fn() is rethrown, never re-run.)
    if (errName === "AbortError" || errName === "TimeoutError") return fn();
    throw err;
  }
}

let _client: SupabaseClient | null = null;

function makeClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
      flowType: "pkce",
      lock: nonDeadlockingLock,
    },
  });
}

export function getSupabase(): SupabaseClient {
  if (!_client) _client = makeClient();
  return _client;
}

export const supabase = getSupabase();
