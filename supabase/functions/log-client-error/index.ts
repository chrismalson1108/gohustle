// Client crash/error sink. captureError() in both clients POSTs here fire-and-forget
// so a production error lands somewhere a human can see it (admin console) instead of
// a 100-entry in-memory ring buffer that dies with the process.
//
// Auth: signed-in callers only. Crashes CAN happen pre-auth, and those are lost — an
// accepted trade: an unauthenticated write endpoint fed by untrusted clients is a spam
// and cost vector, and the errors that matter operationally (booking, capture, tip,
// verify, post) are all post-auth. The root ErrorBoundary still renders its fallback
// either way; only the reporting is gated.
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Generous enough that a genuine crash-loop still reports (you want to SEE a loop),
// tight enough that one client cannot fill the table.
const MAX_PER_USER_PER_HOUR = 60;
const MAX_MESSAGE_CHARS = 500;
const MAX_CONTEXT_CHARS = 2000;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const token = req.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return json({ ok: false }, 401);

    const body = (await req.json().catch(() => ({}))) as {
      message?: unknown; context?: unknown; platform?: unknown;
      appVersion?: unknown; fatal?: unknown; dev?: unknown;
    };

    const message = String(body.message ?? '').trim().slice(0, MAX_MESSAGE_CHARS);
    if (!message) return json({ ok: false }, 400);

    // context is caller-controlled. Cap its serialized size and store it as a plain
    // jsonb blob — the admin UI must render it as TEXT, never as markup.
    let context: unknown = null;
    try {
      const s = JSON.stringify(body.context ?? {});
      context = s.length > MAX_CONTEXT_CHARS ? { truncated: s.slice(0, MAX_CONTEXT_CHARS) } : JSON.parse(s);
    } catch {
      context = null;
    }

    const platform = ['ios', 'android', 'web'].includes(String(body.platform))
      ? String(body.platform)
      : null;

    // INSERT BEFORE COUNTING, so concurrent reports are visible to each other — the
    // same ordering send-push and student-verify-start rely on for their caps.
    // Over-limit rows are pruned immediately below rather than pre-checked.
    // Keep the id so the row can actually be pruned if it turns out to be over cap.
    const { data: inserted } = await supabase.from('client_errors').insert({
      user_id: user.id,
      platform,
      app_version: String(body.appVersion ?? '').slice(0, 32) || null,
      message,
      context,
      fatal: body.fatal === true,
      // Only an explicit true marks a row as dev. An older client that doesn't send
      // the field reports as production — the safe direction, since hiding a real
      // crash is far worse than showing a stray dev one.
      dev: body.dev === true,
    }).select('id').single();

    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count } = await supabase
      .from('client_errors')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .gte('created_at', since);
    if ((count ?? 0) > MAX_PER_USER_PER_HOUR) {
      // Over cap: this row is noise, so actually remove it. The comment above has
      // always said over-limit rows are "pruned immediately below" — but nothing
      // pruned, so the cap only ever changed the response body while every single
      // call still wrote a row. A client stuck in an error loop could grow the table
      // without bound and bury real reports on the admin /errors page under its own
      // noise, which is the opposite of what an error sink is for.
      //
      // Deleting by the id just inserted (rather than pruning oldest) keeps this
      // scoped to the caller's own row: no other user's telemetry can be evicted.
      if (inserted?.id) {
        await supabase.from('client_errors').delete().eq('id', inserted.id);
      }
      // Report success anyway — the client must never retry or surface anything to
      // the user for a telemetry write.
      return json({ ok: true, throttled: true });
    }

    return json({ ok: true });
  } catch (err) {
    console.error('log-client-error:', err);
    // Never fail loudly: a telemetry endpoint that errors is worse than one that
    // silently drops, because the caller is already handling a crash.
    return json({ ok: true });
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
