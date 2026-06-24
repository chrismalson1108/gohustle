// Account deletion (Apple 5.1.1(v) / Play / GDPR-CCPA). The caller deletes their
// OWN account: validate the JWT, remove their storage objects (buckets don't
// cascade), then auth.admin.deleteUser → cascades the profile and all user data.
// Financial records of record remain in Stripe.
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

    // 2. Delete the auth user → cascades profile + all user-scoped rows.
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
