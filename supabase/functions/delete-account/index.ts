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

const BUCKETS = ['avatars', 'job-photos', 'chat-photos', 'completion-photos', 'receipts'];

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

    // 2. Release any in-flight escrow holds tied to this user (as poster OR earner)
    // BEFORE the booking/payment rows cascade away — otherwise the authorized card
    // holds are orphaned in Stripe with no row left to capture or cancel. Best-effort:
    // never block a compliance deletion on this (uncaptured holds also auto-expire).
    try {
      const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
      if (stripeKey) {
        const stripe = new Stripe(stripeKey);
        const [{ data: asEarner }, { data: myJobs }] = await Promise.all([
          admin.from('bookings').select('id').eq('earner_id', user.id),
          admin.from('jobs').select('id').eq('poster_id', user.id),
        ]);
        const jobIds = (myJobs ?? []).map((j) => j.id);
        let asPoster: { id: string }[] = [];
        if (jobIds.length) {
          const { data } = await admin.from('bookings').select('id').in('job_id', jobIds);
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
