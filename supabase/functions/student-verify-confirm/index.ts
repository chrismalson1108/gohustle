// Confirms a .edu student verification code. On success, flips the profile's
// student_verified flag (only the service role may — a DB trigger blocks clients
// from self-setting it) and records the verified school domain.
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Must match student-verify-start's normalization (lowercase + strip "+tag") so the
// stored, canonical email is found even if the user re-typed a plus-addressed form.
function normalizeEduEmail(email: string): string {
  const e = (email || '').trim().toLowerCase();
  const [local, domain] = e.split('@');
  if (!local || !domain) return e;
  return `${local.split('+')[0]}@${domain}`;
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

    const { email, code } = await req.json();
    const cleanEmail = normalizeEduEmail(email);
    if (!cleanEmail || !code) return json({ error: 'missing_fields' }, 400);

    // ONE call does the counting, the comparison, the one-inbox-one-account rule and
    // the consume.
    //
    // It used to be four statements here: read the row, test `row.attempts >= 5` against
    // the value just read, compare the hash, and only on a mismatch write
    // `attempts: row.attempts + 1` — an absolute value computed from a stale read, with
    // no predicate. Requests fired together all read attempts = 0, were all evaluated as
    // guesses, and all wrote 1, so a burst of twenty guesses cost one attempt against a
    // 900,000-space code. Nothing else limited this endpoint, and a hit grants the
    // Verified Student badge for the VICTIM's school while locking the real owner of that
    // inbox out of ever verifying it.
    //
    // claim_student_verification() makes the attempt the gate — one guarded UPDATE whose
    // predicate is re-evaluated under the row lock — and adds a ceiling per INBOX rather
    // than per user, because the row is bound to the caller's own uid and more accounts
    // would otherwise buy more guesses. Same rule as mfa_recovery_attempts: count first.
    const codeHash = await sha256(`${String(code).trim()}:${user.id}`);
    const { data: claim, error: claimErr } = await supabase.rpc('claim_student_verification', {
      p_user: user.id,
      p_email: cleanEmail,
      p_code_hash: codeHash,
    });
    // Fail CLOSED. The old code checked no error on any of its writes, so a failed
    // increment silently handed back a free guess.
    if (claimErr) {
      console.error('student-verify-confirm: claim failed', claimErr);
      return json({ error: 'Something went wrong. Please try again.' }, 500);
    }
    const result = Array.isArray(claim) ? claim[0] : claim;
    switch (result?.status) {
      case 'ok':
        break;
      case 'expired':
        return json({ error: 'expired', message: 'That code expired. Request a new one.' }, 400);
      case 'too_many_attempts':
        return json({ error: 'too_many_attempts', message: 'Too many tries. Request a new code.' }, 429);
      case 'invalid_code':
        return json({ error: 'invalid_code', message: "That code doesn't match." }, 400);
      case 'email_in_use':
        return json({ error: 'email_in_use', message: 'That school email has already verified another account.' }, 409);
      case 'no_pending':
        return json({ error: 'no_pending', message: 'Request a new code.' }, 400);
      default:
        console.error('student-verify-confirm: unknown claim status', result);
        return json({ error: 'Something went wrong. Please try again.' }, 500);
    }
    const verifiedDomain: string | null = result?.domain ?? null;

    const { data: profile } = await supabase
      .from('profiles')
      .select('school, student_status')
      .eq('id', user.id)
      .single();

    const patch: Record<string, unknown> = {
      student_verified: true,
      student_verified_at: new Date().toISOString(),
      student_verify_method: 'edu_email',
      school_domain: verifiedDomain,
    };
    // Keep an existing 'alumni' status; otherwise treat as a current student.
    if (profile?.student_status !== 'alumni') patch.student_status = 'student';
    // ALWAYS derive the school label from the domain that was actually verified —
    // never keep whatever the user typed first.
    //
    // This used to run only `if (!profile?.school)`, which left a self-typed value in
    // place and defeated the pin added in 20260726120000. That pin freezes school once
    // student_verified is true, but the ordering let you set it BEFORE verifying:
    //   1. set School = "Stanford University" while unverified (pin does not apply yet)
    //   2. verify with a real .edu address you actually control, at a different school
    //   3. this branch skips because school is non-empty, the badge is granted, and the
    //      pin now freezes the fabricated label permanently
    // The badge is a trust signal posters weigh when deciding who to let into their
    // home, so it must vouch for the institution that was proven, not one adjacent to
    // it. Deriving unconditionally also means the label and school_domain can never
    // disagree.
    if (verifiedDomain) {
      const core = String(verifiedDomain).replace(/\.(edu|ac\.uk|edu\.[a-z]{2})$/, '').split('.').pop() || verifiedDomain;
      patch.school = core.charAt(0).toUpperCase() + core.slice(1);
    }

    await supabase.from('profiles').update(patch).eq('id', user.id);

    return json({ verified: true, schoolDomain: verifiedDomain, school: patch.school ?? profile?.school ?? null });
  } catch (err) {
    console.error('student-verify-confirm:', err);
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
