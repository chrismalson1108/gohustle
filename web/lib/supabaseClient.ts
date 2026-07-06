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

// Password reset must NOT use PKCE: a PKCE recovery link stores a code-verifier in
// the REQUESTING browser's localStorage, so opening the emailed link on any other
// device/browser (phone mail app, different default browser, private window) would
// dead-end at "Auth session missing". This implicit-flow client is used for BOTH
// ends of recovery: resetPasswordForEmail (so the emailed link carries a hash
// token any browser can consume) AND consuming that hash on /reset-password.
//
// IMPORTANT: the main PKCE client CANNOT consume an implicit recovery hash — its
// _getSessionFromURL throws "Not a valid PKCE flow url." on an #access_token. So
// /reset-password reads the hash and calls THIS client's setSession() directly.
// detectSessionInUrl stays false (we parse the hash ourselves, deterministically,
// without racing the main client). persistSession stays false so the recovery
// session lives only in memory for the reset page — it is ISOLATED from the app's
// main session (a recovery link can never browse the app) and leaves no token in
// storage after the tab closes. setSession keeps the session in memory regardless
// of persistSession, so updateUser({ password }) works within the page lifetime.
let _recoveryClient: SupabaseClient | null = null;
export function getRecoveryClient(): SupabaseClient {
  if (!_recoveryClient) {
    _recoveryClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        flowType: "implicit",
        storageKey: "sb-recovery", // isolated from the main client's session
      },
    });
  }
  return _recoveryClient;
}

// supabase-js persists the session under `sb-<project-ref>-auth-token` (its
// default storageKey). Exposed so sign-out can purge it directly as a failsafe
// when the SDK call is slow — never change this derivation or existing users
// would be logged out.
const projectRef = new URL(SUPABASE_URL).hostname.split(".")[0];
export const SESSION_STORAGE_KEY = `sb-${projectRef}-auth-token`;

export function purgePersistedSession(): void {
  try {
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
    window.localStorage.removeItem(`${SESSION_STORAGE_KEY}-code-verifier`);
  } catch {
    // storage unavailable (SSR/private mode) — nothing to purge
  }
}
