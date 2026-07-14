// Image moderation via Claude vision. Called by the client right after an image
// is uploaded to Storage. Downloads the object with the service role, classifies
// it with a fast Claude model, and — if it violates policy — deletes the object
// and logs a moderation_flags row.
//
// Fails OPEN (allows) on any config/download/API error so a provider hiccup can't
// block every upload; failures are logged loudly for monitoring. Reuses the
// ANTHROPIC_API_KEY already configured for the assistant.
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5'; // fast + cheap + vision — ideal for moderation

// Only the app's image buckets are moderatable (defense-in-depth).
const ALLOWED_BUCKETS = new Set(['chat-photos', 'job-photos', 'completion-photos', 'avatars']);

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Require a signed-in caller.
    const authToken = req.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
    const { data: { user }, error: authErr } = await supabase.auth.getUser(authToken);
    if (authErr || !user) return json({ error: 'Unauthorized' }, 401);

    const { bucket, path } = await req.json();
    if (!bucket || !path || !ALLOWED_BUCKETS.has(bucket)) return json({ error: 'bad_request' }, 400);
    // Callers may only moderate their own uploads (objects live under "<uid>/...").
    if (!String(path).startsWith(user.id + '/')) return json({ error: 'forbidden' }, 403);

    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) {
      console.error('moderate-image: ANTHROPIC_API_KEY unset — allowing (fail-open)');
      return json({ allowed: true, skipped: 'no_key' });
    }

    // Download the uploaded object.
    const { data: blob, error: dlErr } = await supabase.storage.from(bucket).download(path);
    if (dlErr || !blob) {
      console.error('moderate-image: download failed', dlErr);
      return json({ allowed: true, skipped: 'download_failed' });
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    // The uploader already compresses/resizes; guard against anything huge.
    if (bytes.byteLength > 8_000_000) {
      console.error('moderate-image: object too large to scan, allowing', bytes.byteLength);
      return json({ allowed: true, skipped: 'too_large' });
    }
    const mediaType = blob.type && blob.type.startsWith('image/') ? blob.type : 'image/jpeg';
    const b64 = base64(bytes);

    // Classify with Claude vision.
    let verdict = { allow: true, categories: [] as string[], reason: '' };
    try {
      const res = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 150,
          system:
            'You are an image safety classifier for GoHustlr, a general-audience gig marketplace for college students. Respond with ONLY compact JSON, no prose.',
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
              {
                type: 'text',
                text:
                  'Classify this uploaded image. Return JSON {"allow":boolean,"categories":string[],"reason":string}. ' +
                  'Set allow=false if it contains ANY of: explicit or suggestive sexual content, nudity or lingerie/underwear intended to titillate, ' +
                  'sexual content involving minors, graphic violence or gore, self-harm, hate symbols, or drugs/weapons offered for sale. ' +
                  'Otherwise allow=true. categories lists the violated buckets (e.g. "sexual","nudity","violence","self_harm","hate","drugs","weapons","minors"). Keep reason under 12 words.',
              },
            ],
          }],
        }),
      });
      if (!res.ok) {
        console.error('moderate-image: anthropic error', res.status, await res.text().catch(() => ''));
        return json({ allowed: true, skipped: 'api_error' });
      }
      const data = await res.json();
      const text = Array.isArray(data?.content) ? data.content.map((c: any) => c?.text || '').join('') : '';
      const parsed = parseJson(text);
      if (parsed && typeof parsed.allow === 'boolean') {
        verdict = {
          allow: parsed.allow,
          categories: Array.isArray(parsed.categories) ? parsed.categories.slice(0, 8).map(String) : [],
          reason: String(parsed.reason || '').slice(0, 140),
        };
      }
    } catch (e) {
      console.error('moderate-image: classify failed', e);
      return json({ allowed: true, skipped: 'classify_error' });
    }

    if (verdict.allow) return json({ allowed: true });

    // Blocked: remove the object, record the attempt, and file it in the admin
    // Moderation queue so a human can review the account.
    await supabase.storage.from(bucket).remove([path]).catch((e) => console.error('moderate-image: remove failed', e));
    try {
      await supabase.from('moderation_flags').insert({
        user_id: user.id, bucket, path, categories: verdict.categories, reason: verdict.reason,
      });
    } catch (e) {
      console.error('moderate-image: flag insert failed', e);
    }
    // Auto-report to the admin console (reports table drives the Moderation page).
    // source='auto' flags it as system-generated; reporter/reported are the
    // uploader (reporter_id is NOT NULL). The image is already deleted.
    try {
      const cats = verdict.categories.length ? verdict.categories.join(', ') : 'policy-violating content';
      await supabase.from('reports').insert({
        reporter_id: user.id,
        reported_user_id: user.id,
        reason: 'Auto-moderation: unsafe image blocked',
        details: `System auto-detected & removed a ${cats} image from ${bucket}.` + (verdict.reason ? ` (${verdict.reason})` : ''),
        source: 'auto',
      });
    } catch (e) {
      console.error('moderate-image: auto-report insert failed', e);
    }
    return json({ allowed: false, categories: verdict.categories, reason: verdict.reason });
  } catch (err) {
    console.error('moderate-image:', err);
    return json({ allowed: true, skipped: 'exception' }); // fail-open
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// Base64-encode bytes in chunks (avoids call-stack limits on large arrays).
function base64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// Tolerant JSON extraction (handles a stray code fence or leading text).
function parseJson(text: string): any {
  try { return JSON.parse(text); } catch { /* fall through */ }
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* give up */ } }
  return null;
}
