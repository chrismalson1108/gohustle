// Public support intake — the website Contact form POSTs here (verify_jwt=false).
// Creates a ticket + first message and emails a notification to the support inbox.
// Light rate-limit by email. Resend is the transport (RESEND_API_KEY secret).
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SUPPORT_FROM = 'GoHustlr Support <support@gohustlr.com>';
const SUPPORT_NOTIFY = 'mainmail@gohustlr.com';
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

    const { email, name, subject, category, message } = await req.json();
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

    const { data: ticket, error: tErr } = await supabase
      .from('support_tickets')
      .insert({
        user_id: userId,
        email: email.trim().toLowerCase(),
        name: (name || '').toString().slice(0, 120) || null,
        subject: subj.slice(0, 200),
        category: (category || '').toString().slice(0, 60) || null,
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
            html: `<div style="font-family:Inter,Arial,sans-serif;font-size:14px;color:#181231;">
              <p><strong>From:</strong> ${esc(name || '')} &lt;${esc(email)}&gt;${category ? ` · ${esc(category)}` : ''}</p>
              <p><strong>Subject:</strong> ${esc(subj)}</p>
              <p style="white-space:pre-wrap;border-left:3px solid #3F25FE;padding-left:12px;color:#5B5570;">${esc(body)}</p>
              <p><a href="${ADMIN_URL}/support/${ticket.id}" style="color:#3F25FE;">Open ticket #${ticket.id} in the console →</a></p>
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
