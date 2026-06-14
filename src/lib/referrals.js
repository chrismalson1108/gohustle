import { supabase } from './supabase';

function genCode(userId) {
  return (userId || '').replace(/-/g, '').slice(0, 6).toUpperCase();
}

// Returns the user's referral code, creating one if missing.
export async function getReferralCode(userId) {
  const { data } = await supabase.from('profiles').select('referral_code').eq('id', userId).single();
  if (data?.referral_code) return data.referral_code;
  const code = genCode(userId);
  try { await supabase.from('profiles').update({ referral_code: code }).eq('id', userId); } catch (_) {}
  return code;
}

// Record that `referredId` was referred by whoever owns `code` (once).
export async function recordReferral(referredId, code) {
  if (!code) return;
  const c = String(code).trim().toUpperCase();
  if (!c) return;
  const { data: ref } = await supabase.from('profiles').select('id').eq('referral_code', c).maybeSingle();
  if (!ref || ref.id === referredId) return;
  try {
    await supabase.from('referrals').upsert(
      { referred_id: referredId, referrer_id: ref.id }, { onConflict: 'referred_id' });
  } catch (_) {}
}

export async function fetchReferralCount(userId) {
  const { count } = await supabase
    .from('referrals').select('referred_id', { count: 'exact', head: true })
    .eq('referrer_id', userId);
  return count || 0;
}
