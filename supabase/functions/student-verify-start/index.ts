// Starts .edu student verification: emails a 6-digit one-time code to the user's
// school email. Stores only a hash of the code. Best-effort rate limiting.
//
// Requires the RESEND_API_KEY and STUDENT_VERIFY_FROM function secrets. The FROM
// must be a sender on a domain verified in Resend, e.g. "GoHustlr <mainmail@gohustlr.com>"
// (never the onboarding@resend.dev sandbox). Until both are set the function returns a
// clear `email_not_configured` error so the UI can explain what to do.
//
// Upgrade path: an authoritative provider (SheerID/VerifyPass) can later mark a
// profile verified via webhook with student_verify_method='sheerid'.
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function isEduEmail(email: string): boolean {
  const e = (email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return false;
  const domain = e.split('@')[1];
  return domain.endsWith('.edu') || domain.endsWith('.ac.uk') || /\.edu\.[a-z]{2}$/.test(domain);
}

// Canonical form for the uniqueness/dedup key: lowercase + strip any "+tag" from the
// local part so john+a@x.edu and john+b@x.edu can't spin up multiple "verified"
// accounts from one inbox. NOTE: we still SEND to the address the user entered (some
// schools don't collapse plus-addresses), but store/compare the normalized form.
function normalizeEduEmail(email: string): string {
  const e = (email || '').trim().toLowerCase();
  const [local, domain] = e.split('@');
  if (!local || !domain) return e;
  return `${local.split('+')[0]}@${domain}`;
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const token = req.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return json({ error: 'Unauthorized' }, 401);

    const { email } = await req.json();
    if (!isEduEmail(email)) return json({ error: 'invalid_email', message: 'Enter a valid school (.edu) email.' }, 400);

    const enteredEmail = email.trim().toLowerCase(); // address we actually email
    const cleanEmail = normalizeEduEmail(email);     // canonical key for dedup/storage
    const domain = cleanEmail.split('@')[1];

    // Rate limit: max 5 codes in the last 15 minutes for this user.
    const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const { count } = await supabase
      .from('student_email_verifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .gte('created_at', since);
    if ((count ?? 0) >= 5) return json({ error: 'rate_limited', message: 'Too many attempts. Try again later.' }, 429);

    // Per-TARGET-email throttle: cap how often any single inbox can be emailed (even
    // from rotating accounts), so this branded-OTP endpoint can't be used to bomb /
    // phish an arbitrary .edu address. Max 3 sends to a given address per 15 min.
    const { count: emailCount } = await supabase
      .from('student_email_verifications')
      .select('id', { count: 'exact', head: true })
      .eq('email', cleanEmail)
      .gte('created_at', since);
    if ((emailCount ?? 0) >= 3) {
      return json({ error: 'rate_limited', message: 'Too many attempts for that email. Try again later.' }, 429);
    }

    // If this inbox already verified ANOTHER account, silently stop — don't send a
    // dead-end code, but return the SAME neutral response as success so this endpoint
    // can't be used as an oracle to check whether a given .edu is already registered
    // (the confirm side still enforces the one-account-per-email rule).
    const { data: priorUse } = await supabase
      .from('student_email_verifications')
      .select('user_id').eq('email', cleanEmail).eq('consumed', true).neq('user_id', user.id).limit(1);
    if (priorUse?.length) {
      return json({ ok: true });
    }

    // CSPRNG 6-digit code (not Math.random — codes gate a trust badge).
    const code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
    const codeHash = await sha256(`${code}:${user.id}`);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    await supabase.from('student_email_verifications').insert({
      user_id: user.id,
      email: cleanEmail,
      domain,
      code_hash: codeHash,
      expires_at: expiresAt,
    });

    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
    if (!RESEND_API_KEY) {
      return json(
        { error: 'email_not_configured', message: 'Student verification email is not set up yet (missing RESEND_API_KEY).' },
        503,
      );
    }
    const FROM = Deno.env.get('STUDENT_VERIFY_FROM');
    if (!FROM) {
      return json(
        { error: 'email_not_configured', message: 'Student verification email sender is not set up yet (missing STUDENT_VERIFY_FROM).' },
        503,
      );
    }

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM,
        to: [enteredEmail],
        subject: `${code} is your GoHustlr verification code`,
        html: `
          <!DOCTYPE html>
          <html lang="en">
          <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light only"></head>
          <body style="margin:0; padding:0; background:#F7F3EC;">
            <div style="display:none; max-height:0; overflow:hidden; opacity:0;">Your GoHustlr student verification code — expires in 15 minutes.</div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F7F3EC;">
              <tr><td align="center" style="padding:32px 16px;">
                <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px; max-width:600px; background:#FFFFFF; border-radius:16px; overflow:hidden; border:1px solid #E8E2D5;">
                  <tr><td align="center" style="background:#3F25FE; padding:30px 32px 26px;">
                    <img src="https://gohustlr.com/brand/wordmark-orange.png" width="150" height="71" alt="Hustlr" style="display:block; width:150px; height:auto; margin:0 auto; color:#FFBC45; font-family:'Sora',Arial,sans-serif; font-size:30px; font-weight:700;">
                  </td></tr>
                  <tr><td style="height:4px; line-height:4px; font-size:0; background:#F21A06;">&nbsp;</td></tr>
                  <tr><td style="padding:38px 44px 8px;">
                    <h1 style="margin:0 0 16px; font-family:'Sora','Inter',Arial,sans-serif; font-size:27px; line-height:1.25; font-weight:700; color:#181231; letter-spacing:-0.02em;">Verify your student status</h1>
                    <p style="margin:0; font-family:'Inter',Arial,sans-serif; font-size:16px; line-height:1.6; color:#5B5570;">Enter this code in GoHustlr to confirm your school email:</p>
                  </td></tr>
                  <tr><td align="center" style="padding:18px 44px 8px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F7F3EC; border:1px solid #E8E2D5; border-radius:14px;">
                      <tr><td align="center" style="padding:22px 16px; font-family:'Sora','Inter',Arial,sans-serif; font-size:40px; line-height:1.1; font-weight:700; letter-spacing:12px; text-indent:12px; color:#3F25FE;">${code}</td></tr>
                    </table>
                  </td></tr>
                  <tr><td style="padding:18px 44px 6px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FFF1D6; border-radius:12px;">
                      <tr><td style="padding:14px 16px; font-family:'Inter',Arial,sans-serif; font-size:13px; line-height:1.6; color:#9A5B00;">This code expires in 15 minutes. GoHustlr will never ask you for it &mdash; don&rsquo;t share it with anyone. Didn&rsquo;t request it? You can safely ignore this email.</td></tr>
                    </table>
                  </td></tr>
                  <tr><td style="padding:26px 44px 34px; border-top:1px solid #E8E2D5;">
                    <p style="margin:0 0 8px; font-family:'Inter',Arial,sans-serif; font-size:13px; line-height:1.5;">
                      <a href="mailto:mainmail@gohustlr.com" style="color:#3F25FE; text-decoration:none;">Help</a> &middot;
                      <a href="https://gohustlr.com/legal/privacy" style="color:#3F25FE; text-decoration:none;">Privacy</a> &middot;
                      <a href="https://gohustlr.com/legal/terms" style="color:#3F25FE; text-decoration:none;">Terms</a>
                    </p>
                    <p style="margin:0; font-family:'Inter',Arial,sans-serif; font-size:12px; line-height:1.6; color:#9A93AD;">GoHustlr &middot; The student gig marketplace<br>Questions? Email <a href="mailto:mainmail@gohustlr.com" style="color:#9A93AD; text-decoration:underline;">mainmail@gohustlr.com</a> &middot; &copy; 2026 GoHustlr</p>
                  </td></tr>
                </table>
              </td></tr>
            </table>
          </body>
          </html>`,
      }),
    });
    if (!emailRes.ok) {
      const detail = await emailRes.text();
      console.error('resend error:', detail);
      return json({ error: 'send_failed', message: 'Could not send the verification email.' }, 502);
    }

    return json({ ok: true });
  } catch (err) {
    console.error('student-verify-start:', err);
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
