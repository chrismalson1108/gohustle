// Referral helpers. Port of src/lib/referrals.js.
import { supabase } from "./supabaseClient";

// Random, non-reversible code. Deliberately NOT derived from the user id — a
// UUID-prefix code leaked a fragment of the internal id and was trivially
// enumerable. Ambiguous characters (0/O/1/I/L) are excluded for shareability.
function genCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 7; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

export async function getReferralCode(userId: string): Promise<string> {
  const { data } = await supabase.from("profiles").select("referral_code").eq("id", userId).single();
  if (data?.referral_code) return data.referral_code;
  const code = genCode();
  try {
    await supabase.from("profiles").update({ referral_code: code }).eq("id", userId);
  } catch {
    /* ignore */
  }
  return code;
}

export async function recordReferral(referredId: string, code?: string | null): Promise<void> {
  if (!code) return;
  const c = String(code).trim().toUpperCase();
  if (!c) return;
  const { data: ref } = await supabase.from("profiles").select("id").eq("referral_code", c).maybeSingle();
  if (!ref || ref.id === referredId) return;
  try {
    await supabase.from("referrals").upsert({ referred_id: referredId, referrer_id: ref.id }, { onConflict: "referred_id" });
  } catch {
    /* ignore */
  }
}

export async function fetchReferralCount(userId: string): Promise<number> {
  const { count } = await supabase
    .from("referrals")
    .select("referred_id", { count: "exact", head: true })
    .eq("referrer_id", userId);
  return count || 0;
}
