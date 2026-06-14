import { supabase } from './supabase';
import { stripeEdge } from './stripeClient';

// ID verification state on a profile.
//   'none'     — never requested
//   'pending'  — user submitted, awaiting review by the provider/back-office
//   'verified' — confirmed (profiles.verified is also true; drives the badge)
//   'rejected' — provider could not confirm; user may retry

export async function fetchVerificationStatus(userId) {
  const { data } = await supabase
    .from('profiles')
    .select('verified, id_verification_status')
    .eq('id', userId)
    .single();
  return {
    verified: !!data?.verified,
    status: data?.id_verification_status || 'none',
  };
}

// Kick off a Stripe Identity verification. The edge function creates a
// VerificationSession (marking the profile 'pending') and returns the hosted
// verification URL; the caller opens it. Stripe's webhook later flips
// profiles.verified + id_verification_status once the ID + selfie are confirmed.
// Returns { url } on success, or { alreadyVerified: true }.
export async function requestVerification() {
  return stripeEdge.createIdentitySession();
}
