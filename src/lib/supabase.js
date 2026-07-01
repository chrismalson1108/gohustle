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
