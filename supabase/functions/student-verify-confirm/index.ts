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
    const cleanEmail = (email || '').trim().toLowerCase();
    if (!cleanEmail || !code) return json({ error: 'missing_fields' }, 400);

    // Most recent un-consumed code for this user + email.
    const { data: row } = await supabase
      .from('student_email_verifications')
      .select('*')
      .eq('user_id', user.id)
      .eq('email', cleanEmail)
      .eq('consumed', false)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!row) return json({ error: 'no_pending', message: 'Request a new code.' }, 400);
    if (new Date(row.expires_at).getTime() < Date.now()) return json({ error: 'expired', message: 'That code expired. Request a new one.' }, 400);
    if (row.attempts >= 5) return json({ error: 'too_many_attempts', message: 'Too many tries. Request a new code.' }, 429);

    const codeHash = await sha256(`${String(code).trim()}:${user.id}`);
    if (codeHash !== row.code_hash) {
      await supabase.from('student_email_verifications').update({ attempts: row.attempts + 1 }).eq('id', row.id);
      return json({ error: 'invalid_code', message: "That code doesn't match." }, 400);
    }

    // Success — consume the code and mark the profile a Verified Student.
    await supabase.from('student_email_verifications').update({ consumed: true }).eq('id', row.id);

    const { data: profile } = await supabase
      .from('profiles')
      .select('school, student_status')
      .eq('id', user.id)
      .single();

    const patch: Record<string, unknown> = {
      student_verified: true,
      student_verified_at: new Date().toISOString(),
      student_verify_method: 'edu_email',
      school_domain: row.domain,
    };
    // Keep an existing 'alumni' status; otherwise treat as a current student.
    if (profile?.student_status !== 'alumni') patch.student_status = 'student';
    // Derive a school name only if the user hasn't set one.
    if (!profile?.school && row.domain) {
      const core = String(row.domain).replace(/\.(edu|ac\.uk|edu\.[a-z]{2})$/, '').split('.').pop() || row.domain;
      patch.school = core.charAt(0).toUpperCase() + core.slice(1);
    }

    await supabase.from('profiles').update(patch).eq('id', user.id);

    return json({ verified: true, schoolDomain: row.domain, school: patch.school ?? profile?.school ?? null });
  } catch (err) {
    console.error('student-verify-confirm:', err);
    return json({ error: (err as Error).message }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
