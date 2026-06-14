import { supabase } from './supabase';

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

// Kick off a verification request. With no real provider wired up yet this
// just records intent (status → 'pending'). When Stripe Identity / Checkr is
// integrated, this is where we'd create a verification session and return its
// URL/token; a webhook would later flip profiles.verified + status to 'verified'.
export async function requestVerification(userId) {
  const { error } = await supabase
    .from('profiles')
    .update({
      id_verification_status: 'pending',
      id_verification_requested_at: new Date().toISOString(),
    })
    .eq('id', userId);
  if (error) throw error;
  return true;
}
