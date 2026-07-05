import "server-only";
import Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";

// Port of supabase/functions/delete-account/index.ts for ADMIN-initiated
// deletion (the edge function authenticates the account owner; here the caller
// is a vetted admin). Same sequence: storage objects → escrow-hold release →
// auth.admin.deleteUser (cascades profile + user rows). Keep the two in sync.
const BUCKETS = ["avatars", "job-photos", "chat-photos", "completion-photos", "receipts"];

export async function deleteUserCascade(service: SupabaseClient, userId: string): Promise<void> {
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
      const [{ data: asEarner }, { data: myJobs }] = await Promise.all([
        service.from("bookings").select("id").eq("earner_id", userId),
        service.from("jobs").select("id").eq("poster_id", userId),
      ]);
      const jobIds = (myJobs ?? []).map((j) => j.id);
      let asPoster: { id: string }[] = [];
      if (jobIds.length) {
        const { data } = await service.from("bookings").select("id").in("job_id", jobIds);
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

  // 3. Delete the auth user → cascades profile + all user-scoped rows.
  const { error } = await service.auth.admin.deleteUser(userId);
  if (error) throw new Error(`auth delete failed: ${error.message}`);
}
