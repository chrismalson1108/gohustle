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

    // Persist an in-app alert (best-effort) so the recipient sees it in their
    // Alerts inbox even without a push-capable device. A missing column (before
    // the inbox migration) just logs and continues.
    try {
      await supabase.from('notifications').insert({
        user_id: userId,
        type: (data?.type as string) || 'update',
        title,
        body: body ?? null,
        job_id: (data?.jobId as string) ?? null,
        data: data ?? {},
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
      title,
      body: body ?? '',
      data: data ?? {},
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
    return json({ error: err.message }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
