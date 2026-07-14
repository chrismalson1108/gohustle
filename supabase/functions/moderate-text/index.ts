// Context-aware text moderation via Claude. Complements the keyword backstop
// (public.contains_prohibited DB trigger + shared/contentFilter.js) by catching
// things a word-list can't: harassment, threats, grooming, scams, and banned
// intent phrased in clean words. Called by the client BEFORE writing user text
// (gig posts, chat, etc.). On a block it also files an auto-report so the admin
// Moderation queue sees repeat offenders.
//
// Fails OPEN (allows) on any config/API error so a provider hiccup can't wedge
// posting or messaging; the keyword DB trigger still blocks the explicit terms.
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5'; // fast + cheap — keeps posting/messaging snappy

// Surfaces the client may ask us to check (for the report note only).
const SURFACES = new Set(['gig', 'message', 'review', 'bio', 'note']);

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const authToken = req.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
    const { data: { user }, error: authErr } = await supabase.auth.getUser(authToken);
    if (authErr || !user) return json({ error: 'Unauthorized' }, 401);

    const body = await req.json();
    const text = typeof body?.text === 'string' ? body.text.slice(0, 4000) : '';
    const surface = SURFACES.has(body?.surface) ? body.surface : 'text';
    if (!text.trim()) return json({ allowed: true }); // nothing to check

    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) {
      console.error('moderate-text: ANTHROPIC_API_KEY unset — allowing (fail-open)');
      return json({ allowed: true, skipped: 'no_key' });
    }

    let verdict = { allow: true, categories: [] as string[], reason: '' };
    try {
      const res = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 160,
          system:
            'You are a content-safety classifier for GoHustlr, a gig marketplace where college students hire and work for each other. ' +
            'You judge INTENT in context, not mere keywords. Respond with ONLY compact JSON, no prose.',
          messages: [{
            role: 'user',
            content:
              'Classify the following user-submitted text. Return JSON {"allow":boolean,"categories":string[],"reason":string}.\n\n' +
              'Set allow=false ONLY if the text genuinely does any of these:\n' +
              '- harassment, bullying, threats, or intimidation of a person\n' +
              '- hate speech or slurs targeting a protected group\n' +
              '- sexual solicitation, explicit sexual content, or sexual advances; anything sexual involving minors\n' +
              '- soliciting or offering illegal drugs, weapons, fake IDs, or stolen goods\n' +
              '- scams or fraud (advance-fee, gift-card, phishing, "pay a deposit first" off-platform)\n' +
              '- pushing payment OFF-platform to dodge escrow (Venmo/CashApp/Zelle/PayPal/"pay me directly in cash first")\n' +
              '- contract/academic cheating (do my homework, take my exam, write my essay for me)\n' +
              '- encouraging self-harm or suicide\n' +
              '- spam or mass advertising unrelated to a gig\n\n' +
              'Do NOT block ordinary marketplace text just because it mentions a sensitive word. Legitimate gigs are fine: ' +
              'moving/heavy lifting, bartending or serving at a 21+ event, tutoring, pet care, someone mentioning a medication ' +
              'they personally take, negotiating a fair on-platform price, etc. When unsure, allow. ' +
              'categories lists the violated buckets; reason is under 12 words.\n\n' +
              '=== TEXT START ===\n' + text + '\n=== TEXT END ===',
          }],
        }),
      });
      if (!res.ok) {
        console.error('moderate-text: anthropic error', res.status, await res.text().catch(() => ''));
        return json({ allowed: true, skipped: 'api_error' });
      }
      const data = await res.json();
      const out = Array.isArray(data?.content) ? data.content.map((c: any) => c?.text || '').join('') : '';
      const parsed = parseJson(out);
      if (parsed && typeof parsed.allow === 'boolean') {
        verdict = {
          allow: parsed.allow,
          categories: Array.isArray(parsed.categories) ? parsed.categories.slice(0, 8).map(String) : [],
          reason: String(parsed.reason || '').slice(0, 140),
        };
      }
    } catch (e) {
      console.error('moderate-text: classify failed', e);
      return json({ allowed: true, skipped: 'classify_error' });
    }

    if (verdict.allow) return json({ allowed: true });

    // Blocked (content is NOT written by the client). File an auto-report so the
    // admin queue can spot users probing the filter, with a short snippet.
    try {
      const cats = verdict.categories.length ? verdict.categories.join(', ') : 'policy violation';
      const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 160);
      await supabase.from('reports').insert({
        reporter_id: user.id,
        reported_user_id: user.id,
        reason: 'Auto-moderation: unsafe text blocked',
        details: `Blocked ${surface} text (${cats}). "${snippet}"` + (verdict.reason ? ` — ${verdict.reason}` : ''),
        source: 'auto',
      });
    } catch (e) {
      console.error('moderate-text: auto-report insert failed', e);
    }
    return json({ allowed: false, categories: verdict.categories, reason: verdict.reason });
  } catch (err) {
    console.error('moderate-text:', err);
    return json({ allowed: true, skipped: 'exception' }); // fail-open
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function parseJson(text: string): any {
  try { return JSON.parse(text); } catch { /* fall through */ }
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* give up */ } }
  return null;
}
