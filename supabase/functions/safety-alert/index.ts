// H6 (safety-reports-no-alerting-sla): page a human when a safety report lands.
//
// Invoked server-side by the AFTER INSERT trigger on public.reports (via pg_net —
// see migration 20260710050000_safety_report_alerting.sql), NOT by clients. Deploy
// with `--no-verify-jwt` and protect with the SAFETY_ALERT_SECRET shared secret (the
// DB trigger sends it as the x-safety-secret header). Emails the on-call owner via
// Resend, the same transport support-submit already uses.
//
// Secrets:
//   SAFETY_ALERT_SECRET  — shared secret; must match the app.safety_alert_secret GUC.
//   SAFETY_ONCALL_EMAIL  — recipient (defaults to the support inbox).
//   RESEND_API_KEY       — email transport (if unset: logs + 200, never wedges the
//                          trigger so the report insert always succeeds).
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-safety-secret',
};

const SAFETY_FROM = 'GoHustlr Safety <support@gohustlr.com>';
const DEFAULT_NOTIFY = 'mainmail@gohustlr.com';
const ADMIN_URL = 'https://admin.gohustlr.com';

function esc(s: string): string {
  return (s || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!));
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    // App-level auth: only the DB trigger (which knows the shared secret) may call
    // this. Fail closed when the secret isn't configured — never an open relay.
    const expected = Deno.env.get('SAFETY_ALERT_SECRET');
    if (!expected) return json({ error: 'not_configured' }, 503);
    if (req.headers.get('x-safety-secret') !== expected) return json({ error: 'forbidden' }, 403);

    const payload = await req.json().catch(() => ({}));
    const reportId: string | null = payload?.report_id ?? payload?.record?.id ?? null;
    if (!reportId) return json({ error: 'missing_report_id' }, 400);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Re-read the report server-side (don't trust the posted body for content).
    const { data: report } = await supabase
      .from('reports')
      .select('id, reason, details, reporter_id, reported_user_id, job_id, booking_id, created_at')
      .eq('id', reportId)
      .maybeSingle();
    const r = report ?? payload?.record;
    if (!r) return json({ error: 'not_found' }, 404);

    // Enrich with the parties' display names (best-effort).
    const ids = [r.reporter_id, r.reported_user_id].filter(Boolean);
    const names: Record<string, string> = {};
    if (ids.length) {
      const { data: profs } = await supabase.from('profiles').select('id, name, username').in('id', ids);
      (profs ?? []).forEach((p: { id: string; name?: string; username?: string }) => {
        names[p.id] = p.name || (p.username ? `@${p.username}` : p.id);
      });
    }

    const to = Deno.env.get('SAFETY_ONCALL_EMAIL') || DEFAULT_NOTIFY;
    const reporter = names[r.reporter_id] || r.reporter_id || 'unknown';
    const reported = r.reported_user_id ? (names[r.reported_user_id] || r.reported_user_id) : '—';

    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
    if (!RESEND_API_KEY) {
      // No transport yet — log loudly and succeed so the trigger/insert isn't wedged.
      console.error(`[safety-alert] report ${r.id} (${r.reason}) — RESEND_API_KEY unset, cannot email ${to}`);
      return json({ ok: true, emailed: false });
    }

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: SAFETY_FROM,
        to: [to],
        subject: `⚠️ Safety report: ${r.reason}`,
        html: `<div style="font-family:Inter,Arial,sans-serif;font-size:14px;color:#181231;">
          <p style="font-size:16px;"><strong>New safety report</strong></p>
          <p><strong>Reason:</strong> ${esc(r.reason)}</p>
          <p><strong>Reporter:</strong> ${esc(reporter)}</p>
          <p><strong>Reported:</strong> ${esc(reported)}</p>
          ${r.details ? `<p style="white-space:pre-wrap;border-left:3px solid #E11D48;padding-left:12px;color:#5B5570;">${esc(r.details)}</p>` : ''}
          <p style="color:#5B5570;font-size:12px;">Report ${esc(r.id)}${r.job_id ? ` · job ${esc(r.job_id)}` : ''}${r.booking_id ? ` · booking ${esc(r.booking_id)}` : ''} · ${esc(String(r.created_at || ''))}</p>
          <p><a href="${ADMIN_URL}/reports" style="color:#3F25FE;">Open the reports queue →</a></p>
        </div>`,
      }),
    });
    if (!res.ok) {
      console.error('[safety-alert] resend error:', await res.text().catch(() => res.status));
      return json({ ok: false, emailed: false }, 502);
    }
    return json({ ok: true, emailed: true });
  } catch (err) {
    console.error('safety-alert:', err);
    return json({ error: 'Something went wrong.' }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
