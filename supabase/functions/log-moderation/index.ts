// Records a client-detected keyword moderation block into the admin Moderation
// queue (reports table, source='auto'). The block itself already happened on the
// client and is independently enforced by the DB trigger (public.contains_prohibited)
// — this only gives admins VISIBILITY into who is tripping / probing the filter.
//
// Fire-and-forget from the client; never blocks the user. Best-effort + lightly
// rate-limited so one user rapidly probing the filter can't flood the queue.
import { createClient } from 'npm:@supabase/supabase-js@2.112.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SURFACES = new Set(['gig', 'message', 'review', 'bio', 'note', 'cert', 'text']);

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const authToken = req.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
    const { data: { user }, error: authErr } = await supabase.auth.getUser(authToken);
    if (authErr || !user) return json({ error: 'Unauthorized' }, 401);

    const body = await req.json();
    const term = String(body?.term ?? '').replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 60);
    const surface = SURFACES.has(body?.surface) ? body.surface : 'text';
    const snippet = String(body?.snippet ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
    const bookingId = typeof body?.bookingId === 'string' && /^[0-9a-f-]{36}$/i.test(body.bookingId) ? body.bookingId : null;
    if (!term) return json({ logged: false, reason: 'no_term' });

    // Membership check: only associate this report with a booking the caller is
    // actually a party to (earner or the gig's poster). Otherwise a user who knows
    // any live booking UUID could steer the admin "view conversation" link to an
    // unrelated pair's private DMs. Drop the id to null if the caller isn't a party.
    let safeBookingId: string | null = null;
    if (bookingId) {
      const { data: bk } = await supabase
        .from('bookings')
        .select('earner_id, jobs!bookings_job_id_fkey!inner(poster_id)')
        .eq('id', bookingId)
        .maybeSingle();
      const posterId = (bk as any)?.jobs?.poster_id;
      if (bk && ((bk as any).earner_id === user.id || posterId === user.id)) safeBookingId = bookingId;
    }

    // Anti-flood: at most ~20 auto-reports from this user in the last 5 min.
    // Best-effort — if the count query fails, still log.
    try {
      const since = new Date(Date.now() - 5 * 60_000).toISOString();
      const { count } = await supabase
        .from('reports')
        .select('id', { count: 'exact', head: true })
        .eq('reporter_id', user.id)
        .eq('source', 'auto')
        .gte('created_at', since);
      if ((count ?? 0) >= 20) return json({ logged: false, reason: 'rate_limited' });
    } catch (_) { /* fall through and log anyway */ }

    try {
      await supabase.from('reports').insert({
        reporter_id: user.id,
        reported_user_id: user.id,
        booking_id: safeBookingId,
        reason: `Auto-moderation: blocked keyword ("${term}")`,
        details: `Blocked ${surface} text${snippet ? ` — "${snippet}"` : ''}`,
        source: 'auto',
      });
    } catch (e) {
      console.error('log-moderation: insert failed', e);
      return json({ logged: false });
    }
    return json({ logged: true });
  } catch (err) {
    console.error('log-moderation:', err);
    return json({ logged: false });
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
