// Sends a support reply email (Resend). Called by the admin console server with
// the signed-in admin's Supabase JWT (verify_jwt stays true; we ALSO validate the
// token, admin_users ROLE and MFA in-function via _shared/adminAuth). The console
// records the reply row itself; this function just delivers the email.
//
// THE RECIPIENT IS RESOLVED SERVER-SIDE, NEVER TAKEN FROM THE REQUEST. It used to
// read `toEmail` straight from the body and hand it to Resend, so anyone who could
// reach this function could send mail from `GoHustlr Support <support@gohustlr.com>`
// to any address on earth — a phishing relay wearing our own brand. Now the caller
// names a SUBJECT (a ticket, or a user) and the address is looked up here:
//
//   • { ticketId } → support_tickets.email   — role: support (ordinary queue work)
//   • { userId }   → that auth user's email  — role: admin  (unsolicited contact)
//
// The second form is deliberately admin-only: mailing someone who never opened a
// ticket is the capability the console gates at requireAdmin('admin') for "Notify
// user", so it is gated identically at the function.
//
// RESIDUAL, stated plainly so nobody mistakes this for an absolute guarantee: the
// ticket branch is only as trustworthy as support_tickets.email, and those rows are
// written by support-submit, which is `verify_jwt = false` (the public website
// contact form) and validates the address with a regex and nothing else. So a
// support-tier insider can still reach an arbitrary recipient in two steps — file a
// ticket naming the victim, then reply to it. What the change buys is that the
// recipient is now always tied to a persisted, timestamped, IP-stamped ticket row
// and to a `support.reply` audit entry, instead of being an unlogged parameter. It
// is bounded by traceability, not by construction. Closing it properly means giving
// support-submit an ownership proof (or an admin-visible "unverified sender" flag),
// which is tracked in ADMIN_AUDIT_2026-08-04.md.
import { requireAdminCaller } from '../_shared/adminAuth.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SUPPORT_FROM = 'GoHustlr Support <support@gohustlr.com>';
const REPLY_TO = 'mainmail@gohustlr.com'; // until a support@ inbox/alias exists

function esc(s: string): string {
  return (s || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!));
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const { ticketId, userId, subject, body } = await req.json();
    if (!body) return json({ error: 'missing_fields' }, 400);
    if (!ticketId && !userId) return json({ error: 'ticket_or_user_required' }, 400);

    // Pick the tier from what is being asked for, then authorise.
    const auth = await requireAdminCaller(req, ticketId ? 'support' : 'admin');
    if (!auth.ok) return json({ error: auth.denial.error }, auth.denial.status);
    const { service } = auth.caller;

    // Resolve the recipient from the subject the caller named. The caller never
    // supplies an address.
    let toEmail: string;
    if (ticketId) {
      const { data: ticket, error } = await service
        .from('support_tickets')
        .select('email')
        .eq('id', ticketId)
        .maybeSingle();
      if (error) {
        console.error('support-reply: ticket lookup failed:', error);
        return json({ error: 'lookup_failed' }, 503);
      }
      if (!ticket?.email) return json({ error: 'ticket_not_found' }, 404);
      toEmail = ticket.email;
    } else {
      const { data, error } = await service.auth.admin.getUserById(String(userId));
      if (error) {
        console.error('support-reply: user lookup failed:', error);
        return json({ error: 'lookup_failed' }, 503);
      }
      if (!data?.user?.email) return json({ error: 'user_has_no_email' }, 404);
      toEmail = data.user.email;
    }

    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
    if (!RESEND_API_KEY) return json({ error: 'email_not_configured' }, 503);

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: SUPPORT_FROM,
        to: [toEmail],
        reply_to: REPLY_TO,
        subject: String(subject || `Re: your GoHustlr support request${ticketId ? ` (#${ticketId})` : ''}`).slice(0, 200),
        html: `<div style="font-family:Inter,Arial,sans-serif;font-size:15px;line-height:1.6;color:#363636;">
          <p style="white-space:pre-wrap;">${esc(String(body))}</p>
          <hr style="border:none;border-top:1px solid #E4DFD3;margin:20px 0;">
          <p style="font-size:12px;color:#9A93AD;">GoHustlr Support · reply to this email and we'll get back to you.</p>
        </div>`,
      }),
    });
    if (!res.ok) {
      const detail = await res.text();
      console.error('support-reply resend error:', detail);
      return json({ error: 'send_failed', detail }, 502);
    }
    return json({ ok: true });
  } catch (err) {
    console.error('support-reply:', err);
    return json({ error: 'server_error' }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
