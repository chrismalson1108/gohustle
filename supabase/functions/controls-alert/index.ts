// Control sweep alerting + morning triage digest.
//
// Invoked server-side by pg_cron via pg_net (see 20260806030000_schedule_controls.sql),
// never by clients. Deploy with `--no-verify-jwt`; protected by the same shared-secret
// pattern as safety-alert, with the secret read from app_flags.controls_alert.value.
//
// Two modes, because "something is on fire" and "here is your morning" are different
// jobs and collapsing them is how people learn to ignore both:
//
//   mode=page    fired after every sweep. Emails ONLY if something newly needs a human:
//                a new critical/high finding, a control that errored, or a control that
//                has gone stale. Silent otherwise — an alert channel that speaks when
//                nothing is wrong stops being read.
//   mode=digest  fired once each morning. Always emails. Summarises open findings and,
//                when ANTHROPIC_API_KEY is set, asks Claude to triage them: what matters
//                most, likely cause, and what to do first.
//
// The division of labour is deliberate. DETECTION is deterministic SQL in the control
// functions — it must never miss, and it is testable. The model only ever reads findings
// that SQL already produced, to PRIORITISE and EXPLAIN them. It cannot cause a finding
// to be missed, because it is not in the detection path at all. Being occasionally wrong
// about what to look at first is survivable; being silently wrong about what exists is
// not.
//
// Secrets:
//   RESEND_API_KEY     — email transport. If unset, logs and returns ok (never wedges
//                        the sweep) but reports emailed:false so a control can catch it.
//   CONTROLS_EMAIL     — recipient (defaults to the support inbox).
//   ANTHROPIC_API_KEY  — optional; enables triage. Absent = plain digest, no failure.
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-controls-secret',
};

const FROM = 'GoHustlr Controls <support@gohustlr.com>';
const DEFAULT_TO = 'mainmail@gohustlr.com';
const ADMIN_URL = 'https://admin.gohustlr.com';
const SEV_ORDER = ['critical', 'high', 'medium', 'low'];
const SEV_COLOR: Record<string, string> = {
  critical: '#EA4637', high: '#E0A44A', medium: '#5038FF', low: '#6B6482',
};

function esc(s: string): string {
  return (s || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!));
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Auth against the secret stored in app_flags, so it can be rotated from the
    // console without a redeploy. Fail closed when unset — never an open relay.
    const { data: cfgRow } = await supabase
      .from('app_flags').select('value').eq('key', 'controls_alert').maybeSingle();
    const expected = (cfgRow?.value as Record<string, string> | null)?.secret;
    if (!expected) return json({ error: 'not_configured' }, 503);
    if (req.headers.get('x-controls-secret') !== expected) return json({ error: 'forbidden' }, 403);

    const body = await req.json().catch(() => ({}));
    const mode: string = body?.mode === 'digest' ? 'digest' : 'page';

    // Open findings, worst first.
    const { data: findings } = await supabase
      .from('control_findings')
      .select('control_key, entity_id, severity, detail, first_seen_at, last_seen_at')
      .is('resolved_at', null)
      .order('last_seen_at', { ascending: false })
      .limit(200);

    const { data: controls } = await supabase
      .from('controls')
      .select('key, title, severity, domain, enabled, last_run_at, last_error, last_violations');

    const open = findings ?? [];
    const errored = (controls ?? []).filter((c) => c.enabled && c.last_error);
    const stale = (controls ?? []).filter(
      (c) => c.enabled && (!c.last_run_at || Date.parse(c.last_run_at) < Date.now() - 6 * 3600_000),
    );

    // A finding first seen within the last sweep window is "new". page mode only
    // speaks for new severe findings, or for a monitoring system that is itself
    // unwell — a control erroring or having gone quiet is as urgent as a violation,
    // because both mean you are no longer being told the truth.
    const sinceMs = Number.isFinite(Number(body?.since_minutes)) ? Number(body.since_minutes) : 90;
    const cutoff = Date.now() - sinceMs * 60_000;
    const fresh = open.filter(
      (f) => ['critical', 'high'].includes(f.severity) && Date.parse(f.first_seen_at) >= cutoff,
    );

    if (mode === 'page' && fresh.length === 0 && errored.length === 0 && stale.length === 0) {
      return json({ ok: true, emailed: false, reason: 'nothing_new' });
    }

    const byS: Record<string, number> = {};
    for (const f of open) byS[f.severity] = (byS[f.severity] ?? 0) + 1;
    const titleOf = (k: string) => (controls ?? []).find((c) => c.key === k)?.title ?? k;

    // Optional triage. Wrapped so a model or network failure degrades to the plain
    // digest — the alert must still land.
    let triage = '';
    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (mode === 'digest' && anthropicKey && (open.length || errored.length || stale.length)) {
      try {
        const payload = {
          open_findings: open.slice(0, 60).map((f) => ({
            control: f.control_key, title: titleOf(f.control_key), severity: f.severity,
            entity: f.entity_id, detail: f.detail, first_seen: f.first_seen_at,
          })),
          controls_erroring: errored.map((c) => ({ key: c.key, error: c.last_error })),
          controls_stale: stale.map((c) => c.key),
        };
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': anthropicKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-5',
            max_tokens: 1200,
            system:
              'You triage automated control findings for a two-sided gig marketplace ' +
              '(Stripe manual-capture escrow, Supabase Postgres). The findings were ' +
              'produced by deterministic SQL checks; treat them as facts. Your job is ' +
              'PRIORITISATION and EXPLANATION only — never claim something is fine ' +
              'because you cannot see it, and never invent findings. Output short HTML ' +
              '(<p>, <ul>, <li>, <strong> only). Lead with the single thing to do first. ' +
              'Group related findings that share a likely root cause. If a control is ' +
              'erroring or stale, say plainly that detection is degraded and treat that ' +
              'as more urgent than most individual findings. Be concise and concrete.',
            messages: [{
              role: 'user',
              content: 'Triage this morning\'s control findings:\n\n' + JSON.stringify(payload, null, 1),
            }],
          }),
        });
        if (res.ok) {
          const j = await res.json();
          triage = (j?.content ?? []).map((b: { text?: string }) => b?.text ?? '').join('').trim();
        } else {
          console.error('[controls-alert] anthropic error:', res.status, await res.text().catch(() => ''));
        }
      } catch (e) {
        console.error('[controls-alert] triage failed, sending plain digest:', e);
      }
    }

    const rows = open
      .slice()
      .sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity))
      .slice(0, 40)
      .map((f) => `<tr>
        <td style="padding:6px 10px;border-bottom:1px solid #EDE9E0;color:${SEV_COLOR[f.severity] ?? '#363636'};font-weight:700;">${esc(f.severity)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #EDE9E0;">${esc(titleOf(f.control_key))}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #EDE9E0;font-family:ui-monospace,monospace;font-size:12px;color:#6B6482;">${esc(String(f.entity_id || '—'))}</td>
      </tr>`).join('');

    const health = [
      errored.length ? `<p style="color:#EA4637;"><strong>${errored.length} control(s) ERRORING — detection is degraded:</strong><br>${errored.map((c) => `${esc(c.key)}: ${esc(String(c.last_error).slice(0, 200))}`).join('<br>')}</p>` : '',
      stale.length ? `<p style="color:#E0A44A;"><strong>${stale.length} control(s) have not run in 6h:</strong> ${stale.map((c) => esc(c.key)).join(', ')}</p>` : '',
    ].join('');

    const subject = mode === 'digest'
      ? `GoHustlr controls — ${open.length} open (${byS.critical ?? 0} critical, ${byS.high ?? 0} high)`
      : `⚠️ GoHustlr controls: ${fresh.length} new${errored.length ? ` · ${errored.length} erroring` : ''}${stale.length ? ` · ${stale.length} stale` : ''}`;

    const to = Deno.env.get('CONTROLS_EMAIL') || DEFAULT_TO;
    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
    if (!RESEND_API_KEY) {
      console.error(`[controls-alert] RESEND_API_KEY unset — cannot email ${to}; ${open.length} open findings`);
      return json({ ok: true, emailed: false, reason: 'no_transport', open: open.length });
    }

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM,
        to: [to],
        subject,
        html: `<div style="font-family:Inter,Arial,sans-serif;font-size:14px;color:#363636;max-width:720px;">
          <p style="font-size:16px;"><strong>${mode === 'digest' ? 'Control digest' : 'Control alert'}</strong></p>
          ${health}
          ${triage ? `<div style="background:#F7F4EC;border-left:3px solid #5038FF;padding:12px 16px;margin:16px 0;">${triage}</div>` : ''}
          ${open.length
            ? `<table style="border-collapse:collapse;width:100%;margin-top:8px;">
                 <tr><th align="left" style="padding:6px 10px;border-bottom:2px solid #363636;">Sev</th>
                     <th align="left" style="padding:6px 10px;border-bottom:2px solid #363636;">Control</th>
                     <th align="left" style="padding:6px 10px;border-bottom:2px solid #363636;">Entity</th></tr>
                 ${rows}
               </table>
               ${open.length > 40 ? `<p style="color:#6B6482;font-size:12px;">…and ${open.length - 40} more.</p>` : ''}`
            : '<p style="color:#15803D;">No open findings.</p>'}
          <p style="margin-top:18px;"><a href="${ADMIN_URL}/controls" style="color:#5038FF;">Open the controls queue →</a></p>
        </div>`,
      }),
    });
    if (!res.ok) {
      console.error('[controls-alert] resend error:', await res.text().catch(() => res.status));
      return json({ ok: false, emailed: false }, 502);
    }
    return json({ ok: true, emailed: true, mode, open: open.length, fresh: fresh.length });
  } catch (err) {
    console.error('controls-alert:', err);
    return json({ error: 'Something went wrong.' }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
