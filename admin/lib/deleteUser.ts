import "server-only";
import Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";

// Port of supabase/functions/delete-account/index.ts for ADMIN-initiated
// deletion (the edge function authenticates the account owner; here the caller
// is a vetted admin). Same sequence: storage objects → escrow-hold release →
// auth.admin.deleteUser (cascades profile + user rows). Keep the two in sync.
// `certificates` was missing here and in the edge function, so uploaded credential
// documents survived deletion in a public bucket. Keep this list in sync.
const BUCKETS = [
  "avatars", "job-photos", "chat-photos", "completion-photos", "receipts", "certificates",
];

// Booking states where the poster's card is authorized and the earner is owed.
const UNSETTLED_STATUSES = ["confirmed", "completed"];

// Only holds on un-started bookings may be voided. Mirrors the edge function.
const CANCELLABLE_STATUSES = ["pending", "declined", "cancelled"];

export async function deleteUserCascade(service: SupabaseClient, userId: string): Promise<void> {
  // 0. Refuse while money is in flight — same defect and same reasoning as the edge
  // function: cancelling an 'authorized' hold on a completed booking and then
  // cascading the booking/payment rows away leaves the earner unpaid with no in-app
  // record. Filtering the cancel loop alone would not help; the cascade still removes
  // the rows and the hold expires unclaimed.
  //
  // Admin deletion throws rather than returning a code: every server action here runs
  // inside run(), which renders a thrown message straight back to the console (same
  // pattern as assertActionableTarget). So the admin is told what is outstanding and
  // can settle it, instead of silently destroying a worker's payout.
  // Fail CLOSED on a query error. These .select()s return { data: null, error } when
  // they fail, and the count below reads `earnerUnsettled?.length ?? 0` — so a
  // transient failure silently produced "0 unsettled" and let the cascade run,
  // disabling the one control protecting a worker's payout precisely when it was
  // needed. Deletion is irreversible; not knowing has to mean "don't".
  const [
    { data: earnerUnsettled, error: earnerErr },
    { data: ownedJobs, error: jobsErr },
  ] = await Promise.all([
    service.from("bookings").select("id").eq("earner_id", userId).in("status", UNSETTLED_STATUSES),
    service.from("jobs").select("id").eq("poster_id", userId),
  ]);
  let posterUnsettled: { id: string }[] = [];
  const ownedJobIds = (ownedJobs ?? []).map((j) => j.id);
  let posterErr: unknown = null;
  if (ownedJobIds.length) {
    const { data, error } = await service
      .from("bookings").select("id").in("job_id", ownedJobIds).in("status", UNSETTLED_STATUSES);
    posterUnsettled = data ?? [];
    posterErr = error;
  }
  if (earnerErr || jobsErr || posterErr) {
    throw new Error(
      "Could not verify this user's open bookings, so deletion was refused. " +
        "Retry in a moment; if it keeps failing, settle their bookings manually before deleting.",
    );
  }
  const unsettled = (earnerUnsettled?.length ?? 0) + posterUnsettled.length;
  if (unsettled > 0) {
    throw new Error(
      `This user has ${unsettled} unsettled booking(s) (confirmed or completed). ` +
        `Deleting now would void the escrow hold and leave the earner unpaid with no record. ` +
        `Settle or cancel those bookings first, then delete.`,
    );
  }

  // 1. Storage objects aren't FK-cascaded. Batch-delete per bucket; bounded loop.
  for (const bucket of BUCKETS) {
    try {
      for (let guard = 0; guard < 100; guard++) {
        const { data: files } = await service.storage.from(bucket).list(userId, { limit: 100 });
        if (!files?.length) break;
        const { error: rmErr } = await service.storage
          .from(bucket)
          .remove(files.map((f) => `${userId}/${f.name}`));
        if (rmErr || files.length < 100) break;
      }
    } catch {
      // bucket missing / empty — keep going
    }
  }

  // 2. Release in-flight escrow holds (as poster OR earner) before the rows
  // cascade away. Best-effort: uncaptured holds also auto-expire in Stripe.
  try {
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (stripeKey) {
      const stripe = new Stripe(stripeKey);
      // Status filter is defence in depth behind the step-0 gate: even if that gate is
      // bypassed, never void the hold on work that was actually performed.
      const [{ data: asEarner }, { data: myJobs }] = await Promise.all([
        service.from("bookings").select("id").eq("earner_id", userId).in("status", CANCELLABLE_STATUSES),
        service.from("jobs").select("id").eq("poster_id", userId),
      ]);
      const jobIds = (myJobs ?? []).map((j) => j.id);
      let asPoster: { id: string }[] = [];
      if (jobIds.length) {
        const { data } = await service
          .from("bookings").select("id").in("job_id", jobIds).in("status", CANCELLABLE_STATUSES);
        asPoster = data ?? [];
      }
      const bookingIds = [
        ...new Set([...(asEarner ?? []).map((b) => b.id), ...asPoster.map((b) => b.id)]),
      ];
      if (bookingIds.length) {
        const { data: pays } = await service
          .from("payments")
          .select("payment_intent_id")
          .in("booking_id", bookingIds)
          .eq("status", "authorized");
        for (const p of pays ?? []) {
          try {
            await stripe.paymentIntents.cancel(p.payment_intent_id);
          } catch {
            // already captured/cancelled/expired — ignore
          }
        }
      }
    }
  } catch (e) {
    console.error("admin deleteUserCascade: escrow release failed (continuing)", e);
  }

  // 3. Scrub the support queue's copy of this person's identity. MUST run before the
  // auth delete, while support_tickets.user_id still points at them.
  //
  // support_tickets.user_id is `on delete set null`, so the ticket deliberately
  // outlives the account — but the table also denormalises `email` (not null) and
  // `name`, which that cascade does not touch. Without this, a deleted user's plain
  // email address and real name stay in the support queue indefinitely. Tombstoning
  // keeps the operational record that `set null` was for, minus the identifiers.
  // Best-effort, matching the edge function: a scrub failure must not strand the
  // deletion half-done.
  try {
    const { error: scrubErr } = await service
      .from("support_tickets")
      .update({ email: "deleted-user@removed.invalid", name: null })
      .eq("user_id", userId);
    if (scrubErr) console.error("admin deleteUserCascade: support ticket scrub failed", scrubErr);
  } catch (e) {
    console.error("admin deleteUserCascade: support ticket scrub threw", e);
  }

  // 4. Delete the auth user → cascades profile + all user-scoped rows.
  const { error } = await service.auth.admin.deleteUser(userId);
  if (error) throw new Error(`auth delete failed: ${error.message}`);
}
