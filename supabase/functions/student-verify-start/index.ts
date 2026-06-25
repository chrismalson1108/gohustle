// Starts .edu student verification: emails a 6-digit one-time code to the user's
// school email. Stores only a hash of the code. Best-effort rate limiting.
//
// Requires the RESEND_API_KEY function secret (and optionally STUDENT_VERIFY_FROM,
// e.g. "GoHustlr <verify@gohustlr.com>"). Until that's set the function returns a
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

    const cleanEmail = email.trim().toLowerCase();
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

    // If this inbox already verified ANOTHER account, refuse up front (mirrors the
    // confirm-side one-account-per-email rule) — no point emailing a dead-end code,
    // and it stops us from being used to repeatedly message an in-use address.
    const { data: priorUse } = await supabase
      .from('student_email_verifications')
      .select('user_id').eq('email', cleanEmail).eq('consumed', true).neq('user_id', user.id).limit(1);
    if (priorUse?.length) {
      return json({ error: 'email_in_use', message: 'That school email has already verified another account.' }, 409);
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
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
    const FROM = Deno.env.get('STUDENT_VERIFY_FROM') ?? 'GoHustlr <onboarding@resend.dev>';

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM,
        to: [cleanEmail],
        subject: 'Your GoHustlr student verification code',
        html: `
          <div style="font-family:system-ui,Arial,sans-serif;max-width:480px;margin:auto">
            <h2 style="color:#6D28D9">Verify your student status</h2>
            <p>Enter this code in GoHustlr to confirm your school email:</p>
            <p style="font-size:32px;font-weight:800;letter-spacing:6px;color:#1E1B4B">${code}</p>
            <p style="color:#6B7280;font-size:13px">This code expires in 15 minutes. If you didn't request it, you can ignore this email.</p>
          </div>`,
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
