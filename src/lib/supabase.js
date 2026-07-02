import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';

const SUPABASE_URL = 'https://nfioebqsgmmzhbksxozc.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_1jX6yS1Wlx6_SxJ_07TnIw_VsYEE_Pu';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    // No URL-based session detection on native — deep links are handled manually.
    detectSessionInUrl: false,
    // PKCE so the Google OAuth redirect returns a ?code we exchange for a session
    // (exchangeCodeForSession). Does not affect email/password sign-in.
    flowType: 'pkce',
  },
});

// Password reset must NOT use PKCE from this app: the recovery email link opens in
// a BROWSER (the web reset page), which can never hold this app's code-verifier —
// a PKCE recovery link would dead-end at "Auth session missing". This separate
// implicit-flow client is used ONLY for resetPasswordForEmail, so the emailed link
// carries a token any browser can consume. No session persistence needed/wanted.
export const recoveryAuthClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
    flowType: 'implicit',
    storage: AsyncStorage,
    storageKey: 'sb-recovery-noop', // isolated; never written (persistSession false)
  },
});

// supabase-js persists the session under `sb-<project-ref>-auth-token` (its default
// storageKey). Exposed so sign-out can purge it directly as a failsafe when the SDK
// call is slow — never change this derivation or existing users would be logged out.
const projectRef = SUPABASE_URL.replace('https://', '').split('.')[0];
export const SESSION_STORAGE_KEY = `sb-${projectRef}-auth-token`;

export function purgePersistedSession() {
  return Promise.all([
    AsyncStorage.removeItem(SESSION_STORAGE_KEY),
    AsyncStorage.removeItem(`${SESSION_STORAGE_KEY}-code-verifier`),
  ]).catch(() => {});
}
