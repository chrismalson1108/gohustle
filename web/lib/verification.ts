// Stripe Identity verification state. Port of src/lib/verification.js.
import { supabase } from "./supabaseClient";
import { stripeEdge } from "./edge";

export async function fetchVerificationStatus(userId: string): Promise<{ verified: boolean; status: string }> {
  const { data } = await supabase
    .from("profiles")
    .select("verified, id_verification_status")
    .eq("id", userId)
    .single();
  return { verified: !!data?.verified, status: data?.id_verification_status || "none" };
}

// Kicks off a Stripe Identity session and returns the hosted verification URL.
export function requestVerification() {
  return stripeEdge.createIdentitySession();
}
