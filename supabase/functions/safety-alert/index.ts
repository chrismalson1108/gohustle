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
//   RESEND_API_KEY       — email transport. If unset the function answers 503
//                          `email_not_configured`, exactly as the missing shared
//                          secret does. It used to answer 200 {ok:true,emailed:false}
//                          "so the trigger is never wedged" — but the trigger
//                          dispatches through pg_net, which is ASYNCHRONOUS and
//                          swallows every error (notify_safety_report wraps
//                          net.http_post in `exception when others then raise
//                          warning`), so this status code can never reach the insert.
//                          What the 200 actually did was hide the outage: the only
//                          check watching this last mile, ctl_alert_dispatch_failing,
//                          reads net._http_response for non-2xx, so a config state in
//                          which no safety report is ever emailed looked identical to
//                          a quiet week. That is the 2026-07-10 shape — four weeks of
//                          silent non-delivery. A 503 surfaces within the hour.
import { createClient } from 'npm:@supabase/supabase-js@2.112.3';

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

    // WHERE THE PERSON IS. jobs.location is masked at write by trg_mask_job_location
    // ("742 Evergreen Terrace, Springfield, IL" is stored as "Springfield, IL") and the
    // precise label lives in job_locations, which grants all to service_role — the key
    // this function already holds. Until 2026-09-05 nothing on the safety path read it:
    // this email carried names, ids and a /moderation link, and following the runbook
    // from there reached "Springfield, IL" and stopped. An earner who taps Get help from
    // a stranger's house was paging a human who could not say where they were.
    //
    // gig_shares already hands the exact address to whoever the earner sends a token to,
    // on the argument that a masked location helps nobody at 11pm. The on-call had less
    // than the earner's friend.
    //
    // Best-effort: a failed lookup must never wedge the page. Falls back to the masked
    // label and says so, rather than silently printing a city as if it were the address.
    let exactAddress: string | null = null;
    let maskedAddress: string | null = null;
    let startedAt: string | null = null;
    if (r.job_id) {
      const [{ data: job }, { data: loc }] = await Promise.all([
        supabase.from('jobs').select('location').eq('id', r.job_id).maybeSingle(),
        supabase.from('job_locations').select('exact_location').eq('job_id', r.job_id).maybeSingle(),
      ]);
      maskedAddress = job?.location ?? null;
      exactAddress = loc?.exact_location ?? null;
    }
    if (r.booking_id) {
      const { data: bk } = await supabase
        .from('bookings').select('started_at').eq('id', r.booking_id).maybeSingle();
      startedAt = bk?.started_at ?? null;
    }
    // "Is this happening now?" is RUNBOOK_SAFETY §1 step 2, and it was a click away on
    // another page. A gig that has started is the urgent case.
    const inProgress = Boolean(startedAt);
    // An SOS is not a routine report, and the subject is the whole message when it
    // arrives on a phone at 11pm. raise_gig_emergency stamps source='emergency'; the
    // moderation queue keys on the same field.
    const emergency = r.source === 'emergency';
    const addressLine = exactAddress
      ? esc(exactAddress)
      : maskedAddress
      ? `${esc(maskedAddress)} <em>(masked — no exact address on file for this gig)</em>`
      : null;

    const to = Deno.env.get('SAFETY_ONCALL_EMAIL') || DEFAULT_NOTIFY;
    const reporter = names[r.reporter_id] || r.reporter_id || 'unknown';
    const reported = r.reported_user_id ? (names[r.reported_user_id] || r.reported_user_id) : '—';

    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
    if (!RESEND_API_KEY) {
      // No transport: FAIL LOUDLY. A 200 here is a silent pager outage — see the
      // RESEND_API_KEY note in the header. The insert is safe either way because the
      // dispatch is asynchronous pg_net, so nothing downstream reads this status but
      // ctl_alert_dispatch_failing, which is exactly who should read it.
      console.error(`[safety-alert] report ${r.id} (${r.reason}) — RESEND_API_KEY unset, cannot email ${to}`);
      return json({ error: 'email_not_configured', emailed: false, report_id: r.id }, 503);
    }

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: SAFETY_FROM,
        to: [to],
        subject: emergency
          ? `🚨 EMERGENCY on an active gig: ${r.reason}`
          : `⚠️ Safety report: ${r.reason}`,
        html: `<div style="font-family:Inter,Arial,sans-serif;font-size:14px;color:#363636;">
          <p style="font-size:16px;"><strong>New safety report</strong></p>
          <p><strong>Reason:</strong> ${esc(r.reason)}</p>
          <p><strong>Reporter:</strong> ${esc(reporter)}</p>
          <p><strong>Reported:</strong> ${esc(reported)}</p>
          ${addressLine ? `<p style="font-size:16px;"><strong>Where:</strong> ${addressLine}</p>` : ''}
          ${startedAt ? `<p><strong>Work started:</strong> ${esc(String(startedAt))}${inProgress ? ' — <strong style="color:#EA4637;">the gig is in progress</strong>' : ''}</p>` : ''}
          ${r.details ? `<p style="white-space:pre-wrap;border-left:3px solid #EA4637;padding-left:12px;color:#6B6482;">${esc(r.details)}</p>` : ''}
          <p style="color:#6B6482;font-size:12px;">Report ${esc(r.id)}${r.job_id ? ` · job ${esc(r.job_id)}` : ''}${r.booking_id ? ` · booking ${esc(r.booking_id)}` : ''} · ${esc(String(r.created_at || ''))}</p>
          <!-- /moderation, not /reports: the console has no /reports route, so this
               link 404'd. It is the only link in the only email that pages a human for
               a harassment or assault report, so it failed exactly when someone was
               trying to act on one. -->
          <p><a href="${ADMIN_URL}/moderation" style="color:#5038FF;">Open the moderation queue →</a></p>
          ${r.booking_id ? `<p><a href="${ADMIN_URL}/bookings/${esc(String(r.booking_id))}" style="color:#5038FF;">Open the booking (address, check-in, conversation) →</a></p>` : ''}
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
