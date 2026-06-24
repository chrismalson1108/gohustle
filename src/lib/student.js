// .edu student verification — thin wrappers over the edge functions.
import { supabase } from './supabase';

const FUNCTIONS_URL = 'https://nfioebqsgmmzhbksxozc.supabase.co/functions/v1';
const SUPABASE_ANON_KEY = 'sb_publishable_1jX6yS1Wlx6_SxJ_07TnIw_VsYEE_Pu';

async function callFn(name, body) {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(`${FUNCTIONS_URL}/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session?.access_token}`,
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || data.error || 'Verification failed');
    err.code = data.error;
    throw err;
  }
  return data;
}

// Email a one-time code to the user's .edu address.
export function startStudentVerification(email) {
  return callFn('student-verify-start', { email });
}

// Confirm the code → flips the profile to Verified Student.
export function confirmStudentVerification(email, code) {
  return callFn('student-verify-confirm', { email, code });
}
