// Account deletion (Apple 5.1.1(v) / Play / GDPR-CCPA). The caller deletes their
// OWN account: validate the JWT, remove their storage objects (buckets don't
// cascade), then the profile is SCRUBBED and the auth row is emptied and permanently
// banned. It is deliberately NOT deleted: profiles_id_fkey cascades from auth.users, and
// that cascade reaches jobs → bookings → payments, i.e. the COUNTERPARTY's financial
// records. See the tombstone block below.
// Financial records of record remain in Stripe.
import Stripe from 'npm:stripe@22';
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
    // Fail CLOSED on a query error, for the same reason the report check below does.
    // These three .select()s return { data: null, error } when they fail, and the
    // count below reads `earnerBookings?.length ?? 0` — so a dropped connection or a
    // PostgREST hiccup silently produced "0 unsettled" and let the deletion proceed,
    // turning the one control protecting a worker's payout into a no-op at exactly
    // the moment it was needed. The cascade is irreversible; not knowing has to mean
    // "don't".
    const [
      { data: earnerBookings, error: earnerErr },
      { data: ownedJobs, error: jobsErr },
    ] = await Promise.all([
      admin.from('bookings').select('id').eq('earner_id', user.id).in('status', UNSETTLED_STATUSES),
      admin.from('jobs').select('id').eq('poster_id', user.id),
    ]);
    let posterUnsettled: { id: string }[] = [];
    const ownedJobIds = (ownedJobs ?? []).map((j) => j.id);
    let posterErr: unknown = null;
    if (ownedJobIds.length) {
      const { data, error } = await admin
        .from('bookings').select('id').in('job_id', ownedJobIds).in('status', UNSETTLED_STATUSES);
      posterUnsettled = data ?? [];
      posterErr = error;
    }
    if (earnerErr || jobsErr || posterErr) {
      return json({
        error: 'SETTLEMENT_CHECK_FAILED',
        message: 'We could not check your open bookings. Please try again, or contact support to delete your account.',
      }, 503);
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
        const stripe = new Stripe(stripeKey, { apiVersion: '2026-07-29.dahlia' });
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

    // 3. Scrub the support queue's copy of this person's identity. MUST run before
    // the auth delete, while support_tickets.user_id still points at them.
    //
    // support_tickets.user_id is `on delete set null` (20260705040000), so the ticket
    // deliberately outlives the account — but the table also denormalises `email`
    // (not null) and `name`, and those are NOT cleared by that cascade. The result is
    // that someone who asked to be deleted keeps a plain-text email address and real
    // name sitting in the support queue forever, with nothing left linking it to a
    // profile to explain why.
    //
    // Tombstoning rather than deleting the rows preserves what `set null` was clearly
    // for — the operational record of a support interaction — while removing the
    // direct identifiers. Best-effort: a failure here must not strand the user in a
    // half-deleted state, so it is logged and the deletion proceeds.
    //
    // RESIDUAL: support_ticket_messages.body is free text the user typed and may
    // contain identifiers they volunteered. Scrubbing it would gut the support record;
    // that is a retention-policy decision, not a code one.
    try {
      const { error: scrubErr } = await admin
        .from('support_tickets')
        .update({ email: 'deleted-user@removed.invalid', name: null })
        .eq('user_id', user.id);
      if (scrubErr) console.error('delete-account: support ticket scrub failed', scrubErr);
    } catch (e) {
      console.error('delete-account: support ticket scrub threw', e);
    }

    // 4. TOMBSTONE the profile.
    //
    // Deleting the auth user cascades to the profile, and the profile cascades to
    // jobs → bookings → payments. PROVEN on a staged row: a booking and its payment went
    // 1 → 0. Since delete-account only blocks UNSETTLED bookings, what cascaded away was
    // precisely the COMPLETED, PAID work — so a poster's erasure destroyed every earner's
    // record of money they had actually been paid. That is the earner's tax evidence, and
    // the earner did not ask for anything to be deleted.
    //
    // Transaction records are a recognised exception to erasure, and those rows are not
    // only the deleting party's. So the profile is scrubbed of every identifier and KEPT,
    // which is the same call this function already makes for support_tickets a few lines
    // above — "preserves what set null was clearly for … while removing the direct
    // identifiers".
    //
    // Order matters: scrub BEFORE the auth delete. If the auth delete succeeds and the
    // scrub has not run, the cascade has already taken the records.
    const { error: tombErr } = await admin.rpc('tombstone_profile', { p_user: user.id });
    if (tombErr) {
      // FAIL CLOSED. Proceeding would delete the counterparty's financial records, which
      // is the exact harm this exists to prevent — better to leave the account intact and
      // have the person retry.
      console.error('delete-account: tombstone failed, refusing to delete', tombErr);
      return json({
        error: 'Could not complete deletion. Nothing was removed — please try again or contact support.',
      }, 500);
    }

    // 5. Neutralise the AUTH row rather than deleting it.
    //
    // This is the part that makes the tombstone actually work. `profiles_id_fkey`
    // references auth.users with ON DELETE CASCADE (confdeltype 'c', read from
    // pg_constraint), so auth.admin.deleteUser removes the profile — and the profile
    // cascades to jobs → bookings → payments. Scrubbing the profile and THEN deleting
    // the auth user would have destroyed exactly the records the scrub was protecting.
    //
    // So the auth row is emptied and permanently banned instead: the email is replaced
    // (freeing the real address for reuse), metadata and phone are cleared, and the
    // account can never be signed into again. What remains is an opaque uuid with no
    // personal data attached — the same tombstone shape already used for the profile and
    // for support_tickets above.
    const { error: delErr } = await admin.auth.admin.updateUserById(user.id, {
      email: `deleted-${user.id}@removed.invalid`,
      phone: undefined,
      user_metadata: {},
      app_metadata: { deleted: true },
      ban_duration: '876000h', // 100 years — Supabase has no "forever", this is it
    });
    if (delErr) return json({ error: delErr.message }, 500);

    // Kill every live session so the ban takes effect immediately rather than at the
    // next token refresh.
    try {
      await admin.auth.admin.signOut(user.id, 'global');
    } catch (e) {
      console.error('delete-account: could not revoke sessions', e);
    }

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
