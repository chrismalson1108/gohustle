// Sends a support reply email (Resend). Called by the admin console server with
// the signed-in admin's Supabase JWT (verify_jwt=false; we validate the token and
// admin_users membership in-function). The console records the reply row itself;
// this function just delivers the email.
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Read the AAL claim straight from the (already-authenticated) access-token JWT
// (local decode, no network round-trip). The console re-issues the token at aal2
// after mfa.verify, so this claim is authoritative for "did this session pass MFA".
// Mirrors admin/lib/guard.ts aalFromToken.
function aalFromToken(token: string): string | null {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
    return (JSON.parse(atob(b64 + pad)).aal as string) ?? null;
  } catch {
    return null;
  }
}

// True only for a valid Supabase user who is in admin_users AND whose session
// passed TOTP MFA (AAL2) — the same gate the admin console server enforces
// (admin/lib/guard.ts). Without the AAL2 check a phished password-only (AAL1)
// staff token could send branded email straight through this function.
async function isAdminCaller(req: Request): Promise<boolean> {
  const token = req.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
  if (!token) return false;
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data: { user } } = await admin.auth.getUser(token);
  if (!user) return false;
  // getUser above proved the token authentic, so trusting its aal claim is sound.
  if (aalFromToken(token) !== 'aal2') return false;
  const { data: row } = await admin.from('admin_users').select('user_id').eq('user_id', user.id).maybeSingle();
  return !!row;
}

const SUPPORT_FROM = 'GoHustlr Support <support@gohustlr.com>';
const REPLY_TO = 'mainmail@gohustlr.com'; // until a support@ inbox/alias exists

function esc(s: string): string {
  return (s || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!));
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    if (!(await isAdminCaller(req))) return json({ error: 'forbidden' }, 403);

    const { ticketId, toEmail, subject, body } = await req.json();
    if (!toEmail || !body) return json({ error: 'missing_fields' }, 400);

    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
    if (!RESEND_API_KEY) return json({ error: 'email_not_configured' }, 503);

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: SUPPORT_FROM,
        to: [String(toEmail).trim()],
        reply_to: REPLY_TO,
        subject: String(subject || `Re: your GoHustlr support request${ticketId ? ` (#${ticketId})` : ''}`).slice(0, 200),
        html: `<div style="font-family:Inter,Arial,sans-serif;font-size:15px;line-height:1.6;color:#181231;">
          <p style="white-space:pre-wrap;">${esc(String(body))}</p>
          <hr style="border:none;border-top:1px solid #E8E2D5;margin:20px 0;">
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
