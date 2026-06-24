import { supabase } from './supabase';

const FUNCTIONS_URL = 'https://nfioebqsgmmzhbksxozc.supabase.co/functions/v1';
const SUPABASE_ANON_KEY = 'sb_publishable_1jX6yS1Wlx6_SxJ_07TnIw_VsYEE_Pu';

// Calls the `assistant` edge function (Claude tool-use loop) with the running
// transcript. Returns { reply, actions } — actions tell the UI which slices of
// state to refresh (a gig was created, a booking made, the profile changed).
export async function askAssistant(messages) {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(`${FUNCTIONS_URL}/assistant`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session?.access_token}`,
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ messages }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || data.error || 'Assistant error');
    err.code = data.error;
    throw err;
  }
  return data;
}
