// Account deletion (Apple 5.1.1(v) / Play / GDPR-CCPA). The caller deletes their
// OWN account: validate the JWT, remove their storage objects (buckets don't
// cascade), then auth.admin.deleteUser → cascades the profile and all user data.
// Financial records of record remain in Stripe.
import Stripe from 'npm:stripe@15';
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Every bucket a user can write to. `certificates` was missing, so uploaded
// credential documents (licence/certification scans, written by
// src/lib/certifications.js) survived account deletion indefinitely — they are not
// FK-cascaded, and the bucket is public, so a stored object URL stayed fetchable
// after the account was gone. That is a straightforward retention/GDPR defect.
const BUCKETS = [
  'avatars', 'job-photos', 'chat-photos', 'completion-photos', 'receipts', 'certificates',
];

// Booking states where money is committed but not yet settled: the poster's card is
// authorized and the earner is owed, or about to be. Deleting an account in one of
// these states destroys the payout path (see the gate in step 0).
const UNSETTLED_STATUSES = ['confirmed', 'completed'];

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const token = req.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
    const { data: { user }, error: authErr } = await admin.auth.getUser(token);
    if (authErr || !user) return json({ error: 'Unauthorized' }, 401);

    // 0. Refuse while money is in flight.
    //
    // Previously this function cancelled EVERY 'authorized' hold on any booking the
    // caller touched, with no filter on bookings.status, and then deleted the auth
    // user — cascading jobs -> bookings -> payments -> messages -> reviews away. For a
    // 'completed' booking (work performed, both parties marked done, awaiting only the
    // poster's verify+capture) that meant: the hold is voided, the poster is never
    // charged, the earner is never paid, and every in-app record of the job is erased.
    // One tap, and it scaled — a poster could accept ten gigs, let ten people do the
    // work, then clear all ten by deleting once.
    //
    // Note that filtering the cancel loop by status would NOT have fixed this: the
    // cascade still removes the booking and payment rows, so nobody can ever capture
    // and the hold simply expires unclaimed ~7 days later. The earner is unpaid either
    // way. The only real fix is to refuse deletion until the money is settled.
    //
    // 'confirmed' is included, not just 'completed': an earner can have done the work
    // and set earner_done while the poster has not marked done yet, so the booking is
    // still 'confirmed' and the same loss applies.
    //
    // This is a precondition, not a refusal to delete — the user is told exactly what
    // to clear, and every settle/cancel path remains available in-app. Apple 5.1.1(v)
    // requires that account deletion be offered, not that it override an unsettled
    // payment obligation to a third party.
    const [{ data: earnerBookings }, { data: ownedJobs }] = await Promise.all([
      admin.from('bookings').select('id').eq('earner_id', user.id).in('status', UNSETTLED_STATUSES),
      admin.from('jobs').select('id').eq('poster_id', user.id),
    ]);
    let posterUnsettled: { id: string }[] = [];
    const ownedJobIds = (ownedJobs ?? []).map((j) => j.id);
    if (ownedJobIds.length) {
      const { data } = await admin
        .from('bookings').select('id').in('job_id', ownedJobIds).in('status', UNSETTLED_STATUSES);
      posterUnsettled = data ?? [];
    }
    // Open safety report = evidence hold. Self-deletion cascades away the bookings,
    // messages, reviews and photos a moderator would need to act on a report filed
    // ABOUT this user, so someone under investigation could erase the case against
    // them at will — on a platform where the reports in question are things like
    // harassment or a no-show at someone's home.
    //
    // Scoped narrowly so this can't be weaponised: only UNRESOLVED reports, only ones
    // naming this user as the REPORTED party (being a reporter never blocks your own
    // deletion), and source='auto' content flags are excluded so an automated
    // moderation hit cannot trap an account. Reports are rate-limited to 10/hr
    // (20260726020000), so this cannot be spammed to pin someone indefinitely, and an
    // admin resolving the report clears the hold.
    const { count: openReports, error: reportErr } = await admin
      .from('reports')
      .select('id', { count: 'exact', head: true })
      .eq('reported_user_id', user.id)
      .neq('source', 'auto')
      .is('resolved_at', null);
    if (reportErr) {
      // Fail CLOSED: if we cannot tell whether evidence is under review, do not
      // destroy it. Support can complete the deletion manually.
      return json({
        error: 'REVIEW_CHECK_FAILED',
        message: 'We could not verify your account status. Please contact support to delete your account.',
      }, 503);
    }
    if ((openReports ?? 0) > 0) {
      return json({
        error: 'UNDER_REVIEW',
        message: 'Your account is under review and can\'t be deleted right now. Contact support if you think this is a mistake.',
      }, 409);
    }

    const unsettledCount = (earnerBookings?.length ?? 0) + posterUnsettled.length;
    if (unsettledCount > 0) {
      return json({
        error: 'UNSETTLED_BOOKINGS',
        count: unsettledCount,
        message:
          unsettledCount === 1
            ? 'You have 1 booking that is still open. Finish or cancel it so everyone gets paid, then delete your account.'
            : `You have ${unsettledCount} bookings that are still open. Finish or cancel them so everyone gets paid, then delete your account.`,
      }, 409);
    }

    // 1. Remove the user's files from each bucket (storage is not FK-cascaded).
    // Paginate: each pass deletes a batch, so re-listing from the start returns the
    // next one — handles users with >1000 objects. Bounded to avoid an infinite loop.
    for (const bucket of BUCKETS) {
      try {
        for (let guard = 0; guard < 100; guard++) {
          const { data: files } = await admin.storage.from(bucket).list(user.id, { limit: 100 });
          if (!files?.length) break;
          const { error: rmErr } = await admin.storage.from(bucket).remove(files.map((f) => `${user.id}/${f.name}`));
          if (rmErr || files.length < 100) break;
        }
      } catch (_) {
        // bucket missing / empty — keep going
      }
    }

    // 2. Release escrow holds on the bookings that remain — which, thanks to the gate
    // in step 0, can only be un-started ones (pending / declined / cancelled). Their
    // holds must be voided BEFORE the rows cascade away, or the authorization is
    // orphaned in Stripe with no row left to capture or cancel. Best-effort: never
    // block a compliance deletion on this (uncaptured holds also auto-expire).
    //
    // The status filter is defence in depth. Step 0 already refuses deletion while any
    // confirmed/completed booking exists, so this should be a no-op — but if that gate
    // is ever bypassed or reordered, this loop must still never void the hold on work
    // that was actually performed. A 'verified' booking is already captured, so its
    // payment row is not 'authorized' and it is untouched either way.
    const CANCELLABLE_STATUSES = ['pending', 'declined', 'cancelled'];
    try {
      const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
      if (stripeKey) {
        const stripe = new Stripe(stripeKey);
        const [{ data: asEarner }, { data: myJobs }] = await Promise.all([
          admin.from('bookings').select('id').eq('earner_id', user.id).in('status', CANCELLABLE_STATUSES),
          admin.from('jobs').select('id').eq('poster_id', user.id),
        ]);
        const jobIds = (myJobs ?? []).map((j) => j.id);
        let asPoster: { id: string }[] = [];
        if (jobIds.length) {
          const { data } = await admin
            .from('bookings').select('id').in('job_id', jobIds).in('status', CANCELLABLE_STATUSES);
          asPoster = data ?? [];
        }
        const bookingIds = [...new Set([...(asEarner ?? []).map((b) => b.id), ...asPoster.map((b) => b.id)])];
        if (bookingIds.length) {
          const { data: pays } = await admin
            .from('payments').select('payment_intent_id').in('booking_id', bookingIds).eq('status', 'authorized');
          for (const p of pays ?? []) {
            try { await stripe.paymentIntents.cancel(p.payment_intent_id); }
            catch (_) { /* already captured/cancelled/expired — ignore */ }
          }
        }
      }
    } catch (e) {
      console.error('delete-account: escrow hold release failed (continuing)', e);
    }

    // 3. Delete the auth user → cascades profile + all user-scoped rows.
    const { error: delErr } = await admin.auth.admin.deleteUser(user.id);
    if (delErr) return json({ error: delErr.message }, 500);

    return json({ success: true });
  } catch (err) {
    console.error('delete-account:', err);
    return json({ error: 'Could not delete account. Please contact support.' }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
