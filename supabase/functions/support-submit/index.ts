// Public support intake — the website Contact form POSTs here (verify_jwt=false).
// Creates a ticket + first message and emails a notification to the support inbox.
// Light rate-limit by email. Resend is the transport (RESEND_API_KEY secret).
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SUPPORT_FROM = 'GoHustlr Support <support@gohustlr.com>';
// Routable without a redeploy, matching SAFETY_ONCALL_EMAIL in safety-alert and
// stripe-webhook. This was the only alert destination still hardcoded, so pointing
// support at a shared inbox or an on-call rotation meant editing and redeploying
// the function. Falls back to the founder's address so it can never go nowhere.
const SUPPORT_NOTIFY = Deno.env.get('SUPPORT_ONCALL_EMAIL') || 'mainmail@gohustlr.com';
const ADMIN_URL = 'https://admin.gohustlr.com';

function isEmail(e: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test((e || '').trim());
}
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

    const { email, name, subject, category, message, bookingId, jobId } = await req.json();
    if (!isEmail(email)) return json({ error: 'invalid_email', message: 'Enter a valid email.' }, 400);
    const body = String(message || '').trim();
    const subj = String(subject || '').trim() || 'Support request';
    if (!body) return json({ error: 'empty', message: 'Please describe your issue.' }, 400);
    if (body.length > 5000) return json({ error: 'too_long', message: 'Message is too long.' }, 400);

    // If a JWT was passed, tie the ticket to that user (optional).
    let userId: string | null = null;
    const token = req.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
    if (token) {
      const { data } = await supabase.auth.getUser(token);
      userId = data.user?.id ?? null;
    }

    const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || null;
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    // Layered anti-abuse, all FAIL-CLOSED (a failed check rejects, never allows):
    //  • per-email 5/hr, per-IP 8/hr (email is spoofable, IP is the real key), and
    //  • a GLOBAL 60/hr cap so email+IP rotation still can't flood the DB / bomb the
    //    support inbox / burn the Resend quota. (Add a CAPTCHA/Turnstile for more.)
    async function overLimit(col: 'email' | 'ip' | null, val: string | null, max: number): Promise<boolean> {
      let q = supabase.from('support_tickets').select('id', { count: 'exact', head: true }).gte('created_at', since);
      if (col && val) q = q.eq(col, val);
      const { count, error } = await q;
      if (error) throw new Error('rate_check_failed');
      return (count ?? 0) >= max;
    }
    try {
      if (await overLimit('email', email.trim().toLowerCase(), 5)) return rateLimited();
      if (ip && (await overLimit('ip', ip, 8))) return rateLimited();
      if (await overLimit(null, null, 60)) return rateLimited();
    } catch {
      return json({ error: 'unavailable', message: 'Support is briefly unavailable. Please try again shortly.' }, 503);
    }

    // Optional gig context, VERIFIED rather than trusted. The client names a booking,
    // and a ticket that cites one is read by an agent as "this user is involved in that
    // gig" — so an unchecked id would let anyone attach their complaint to a stranger's
    // booking and invite staff to go looking at it. Only a booking this user is actually
    // a party to survives.
    let ctxBookingId: string | null = null;
    let ctxJobId: string | null = null;
    if (userId && typeof bookingId === 'string' && bookingId) {
      const { data: b } = await supabase
        .from('bookings')
        .select('id, job_id, earner_id, job:jobs!bookings_job_id_fkey(poster_id)')
        .eq('id', bookingId)
        .maybeSingle();
      if (b && (b.earner_id === userId || (b as any).job?.poster_id === userId)) {
        ctxBookingId = b.id;
        ctxJobId = b.job_id;
      }
    }
    if (!ctxJobId && userId && typeof jobId === 'string' && jobId) {
      const { data: j } = await supabase
        .from('jobs').select('id, poster_id').eq('id', jobId).maybeSingle();
      if (j && j.poster_id === userId) ctxJobId = j.id;
    }

    const { data: ticket, error: tErr } = await supabase
      .from('support_tickets')
      .insert({
        user_id: userId,
        email: email.trim().toLowerCase(),
        name: (name || '').toString().slice(0, 120) || null,
        subject: subj.slice(0, 200),
        category: (category || '').toString().slice(0, 60) || null,
        booking_id: ctxBookingId,
        job_id: ctxJobId,
        ip,
      })
      .select('id')
      .single();
    if (tErr) throw new Error(tErr.message);

    await supabase.from('support_ticket_messages').insert({
      ticket_id: ticket.id,
      author: 'user',
      body,
    });

    // Notify the support inbox (best-effort — the ticket is already saved).
    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
    if (RESEND_API_KEY) {
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: SUPPORT_FROM,
            to: [SUPPORT_NOTIFY],
            reply_to: email.trim(),
            subject: `New support ticket #${ticket.id}: ${subj}`,
            html: `<div style="font-family:Inter,Arial,sans-serif;font-size:14px;color:#363636;">
              <p><strong>From:</strong> ${esc(name || '')} &lt;${esc(email)}&gt;${category ? ` · ${esc(category)}` : ''}</p>
              <p><strong>Subject:</strong> ${esc(subj)}</p>
              <p style="white-space:pre-wrap;border-left:3px solid #5038FF;padding-left:12px;color:#6B6482;">${esc(body)}</p>
              <p><a href="${ADMIN_URL}/support/${ticket.id}" style="color:#5038FF;">Open ticket #${ticket.id} in the console →</a></p>
            </div>`,
          }),
        });
      } catch (e) {
        console.error('support-submit notify failed:', e);
      }
    }

    return json({ ok: true, ticketId: ticket.id });
  } catch (err) {
    console.error('support-submit:', err);
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
});

function rateLimited() {
  return json({ error: 'rate_limited', message: 'Too many requests. Please try again later.' }, 429);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
