// Sends an Expo push notification to a target user's registered devices.
// Called by the client at booking/message events. Auth: any signed-in user may
// notify another (notifications are non-sensitive event pings). Recipient tokens
// are read with the service role. Dead tokens (DeviceNotRegistered) are pruned.
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Require a valid signed-in caller.
    const authToken = req.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
    const { data: { user }, error: authErr } = await supabase.auth.getUser(authToken);
    if (authErr || !user) return json({ error: 'Unauthorized' }, 401);

    const { userId, title, body, data } = await req.json();
    if (!userId || !title) return json({ error: 'userId and title are required' }, 400);

    // Don't notify yourself.
    if (userId === user.id) return json({ sent: 0, skipped: 'self' });

    // Anti-spoof: only allow notifying someone you share a booking with, so this
    // endpoint can't be used to plant arbitrary alerts in a stranger's inbox. We
    // also collect the shared job_ids so a caller can only deep-link to a gig the
    // two users actually transacted on.
    const [asEarner, asPoster] = await Promise.all([
      supabase.from('bookings').select('id, job_id, jobs!bookings_job_id_fkey!inner(poster_id)')
        .eq('earner_id', user.id).eq('jobs.poster_id', userId),
      supabase.from('bookings').select('id, job_id, jobs!bookings_job_id_fkey!inner(poster_id)')
        .eq('earner_id', userId).eq('jobs.poster_id', user.id),
    ]);
    const sharedRows = [...(asEarner.data ?? []), ...(asPoster.data ?? [])];
    if (!sharedRows.length) return json({ error: 'Not allowed to notify this user' }, 403);
    const sharedJobIds = new Set(sharedRows.map((r: any) => r.job_id).filter(Boolean));

    // Anti-spam rate limit: cap sends per caller so a booking counterparty can't
    // loop this endpoint to flood the target's devices + persistent Alerts inbox.
    // Service-role table (push_send_rate) with no client policies; mirrors the
    // assistant_rate pattern. Best-effort — fail open if the table is missing, but
    // log loudly so a missing cap is surfaced in monitoring, not hidden.
    try {
      await supabase.from('push_send_rate').insert({ user_id: user.id });
      const sinceMin = new Date(Date.now() - 60_000).toISOString();
      const { count } = await supabase
        .from('push_send_rate')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .gte('created_at', sinceMin);
      if ((count ?? 0) > 30) return json({ error: 'rate_limited' }, 429);
      // Opportunistic cleanup so the table stays bounded per active user.
      supabase.from('push_send_rate').delete().eq('user_id', user.id)
        .lt('created_at', new Date(Date.now() - 3_600_000).toISOString()).then(() => {}, () => {});
    } catch (e) {
      console.error('send-push: rate-limit check unavailable (cap NOT enforced):', e);
    }

    // Harden caller-supplied content against notification spoofing / phishing and
    // deep-link manipulation: strip control chars, cap length, whitelist the type
    // and routing tab, and only honor a job deep-link that belongs to a shared job.
    const KNOWN_TYPES = new Set(['update', 'booking', 'message', 'review', 'payment', 'amendment', 'tip', 'system']);
    const KNOWN_TABS = new Set(['HomeTab', 'EarnTab', 'GigsTab', 'MessagesTab', 'ProfileTab']);
    const CTRL = new RegExp("[\u0000-\u001F\u007F]", "g");
    const clean = (s: unknown, max: number) =>
      String(s ?? "").replace(CTRL, "").trim().slice(0, max);
    const safeTitle = clean(title, 100);
    if (!safeTitle) return json({ error: 'title required' }, 400);
    const safeBody = clean(body, 280);
    const rawType = data && typeof data.type === 'string' ? data.type : 'update';
    const safeType = KNOWN_TYPES.has(rawType) ? rawType : 'update';
    const rawTab = data && typeof data.tab === 'string' ? data.tab : null;
    const safeTab = rawTab && KNOWN_TABS.has(rawTab) ? rawTab : null;
    const rawJobId = data && typeof data.jobId === 'string' ? data.jobId : null;
    const safeJobId = rawJobId && sharedJobIds.has(rawJobId) ? rawJobId : null;
    const safeData: Record<string, unknown> = { type: safeType };
    if (safeTab) safeData.tab = safeTab;
    if (safeJobId) safeData.jobId = safeJobId;

    // Persist an in-app alert (best-effort) so the recipient sees it in their
    // Alerts inbox even without a push-capable device. A missing column (before
    // the inbox migration) just logs and continues.
    try {
      await supabase.from('notifications').insert({
        user_id: userId,
        type: safeType,
        title: safeTitle,
        body: safeBody || null,
        job_id: safeJobId,
        data: safeData,
      });
    } catch (e) {
      console.error('send-push: notification insert failed', e);
    }

    const { data: rows } = await supabase
      .from('push_tokens')
      .select('token')
      .eq('user_id', userId);

    const tokens = (rows ?? [])
      .map(r => r.token)
      .filter((t: string) => typeof t === 'string' && t.startsWith('ExponentPushToken'));

    if (!tokens.length) return json({ sent: 0 });

    const messages = tokens.map((to: string) => ({
      to,
      title: safeTitle,
      body: safeBody,
      data: safeData,
      sound: 'default',
      priority: 'high',
    }));

    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(messages),
    });
    const result = await res.json();

    // Prune tokens Expo reports as no longer registered.
    const tickets = Array.isArray(result?.data) ? result.data : [];
    const dead: string[] = [];
    tickets.forEach((t: any, i: number) => {
      if (t?.status === 'error' && t?.details?.error === 'DeviceNotRegistered') {
        dead.push(tokens[i]);
      }
    });
    if (dead.length) {
      await supabase.from('push_tokens').delete().eq('user_id', userId).in('token', dead);
    }

    return json({ sent: tokens.length, pruned: dead.length });
  } catch (err: any) {
    console.error('send-push:', err);
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
