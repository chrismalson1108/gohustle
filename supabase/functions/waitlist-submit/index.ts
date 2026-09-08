// Public waitlist intake for gohustlr.com — join, confirm, unsubscribe.
//
// verify_jwt = false (see supabase/config.toml): the marketing page is signed out by
// definition, and the confirm/unsubscribe links are clicked from an inbox. Auth here
// is the caps below plus the fact that the only thing a caller can do is add their own
// address, or act on a row whose 256-bit token they hold.
//
// THREE THINGS THIS FUNCTION IS CAREFUL ABOUT, each for a reason:
//
// 1. It never says whether an address is already on the list. `join` returns the same
//    {ok:true} body for a fresh insert, a duplicate, and an address that unsubscribed
//    last week. A different answer per case turns a public endpoint into an existence
//    oracle — the same reason redeem_promo_code returns only true/false.
//
// 2. `unsubscribe` is NOT gated on waitlist_enabled, and never fails closed. Blocking
//    an opt-out because a feature flag is off, or because a rate limit tripped, is the
//    one failure in this file with a legal shape. It also SCRUBS the row inline rather
//    than leaving it for the purge: honouring an opt-out must not depend on pg_cron.
//
// 3. The confirmation email is capped for the LIFE of the row (email_sent_count), not
//    on a cooldown. A ten-minute floor still lets an attacker who types a victim's
//    address into the form mail them 144 times a day.
//
// Secrets: RESEND_API_KEY, WAITLIST_FROM, WAITLIST_POSTAL_ADDRESS.
//
// An unset sender does NOT refuse the join — by then the row is already committed, so
// this degrades exactly like the global-flood branch: the address is kept, the send is
// skipped, and a FATAL row goes to client_errors, where ctl_edge_errors_burst pages at
// three. There is deliberately no fallback sender: mailing from the wrong address is
// worse than not mailing.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.112.3';
import { logServerError } from '../_shared/logError.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const FN = 'waitlist-submit';
const SITE_URL = 'https://gohustlr.com';
// CAN-SPAM §316.5 requires a valid physical postal address in every commercial
// message. Routable without a redeploy for the same reason SUPPORT_ONCALL_EMAIL is:
// this WILL change when the entity is registered, and it must not need a code change.
const POSTAL_ADDRESS = Deno.env.get('WAITLIST_POSTAL_ADDRESS') || 'Monroe, Louisiana, USA';
const ROLE_INTENTS = new Set(['earn', 'post', 'both']);

function isEmail(e: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test((e || '').trim());
}
function esc(s: string): string {
  return (s || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!));
}

/** 32 bytes of CSPRNG as URL-safe base64. This is the confirm AND unsubscribe token. */
function mintToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The caller's IP, hashed with the service-role key as the salt. Never stored raw —
 * this bounds a caller, it does not identify a person, and the salt means the ledger
 * cannot be rainbow-tabled back to an address range if it leaks.
 */
async function ipHash(req: Request): Promise<string> {
  // Falls back to a shared 'unknown' bucket rather than to null. Returning null made
  // the caller skip the cap entirely, so a request that simply arrived without the
  // header was UNLIMITED — a rate limit that can be switched off by omitting a header
  // is not a rate limit. A shared bucket is the fail-closed direction: worst case
  // several callers share one budget.
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';
  return (await sha256Hex(`${ip}:${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''}`)).slice(0, 32);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    // GET is the inbox path: confirm and unsubscribe links are clicked, not POSTed.
    // The web pages at /waitlist/confirm and /waitlist/unsubscribe POST here instead,
    // so both shapes are supported and neither is special.
    const url = new URL(req.url);
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    const op = String(body.op ?? url.searchParams.get('op') ?? 'join');
    const token = String(body.token ?? url.searchParams.get('token') ?? '');

    if (op === 'confirm' || op === 'unsubscribe') {
      // Unsubscribing MUTATES, so it must not be reachable by a GET. Corporate mail
      // filters and link scanners fetch every URL in a message before the human sees
      // it; a GET that opts people out would silently empty the list, one security
      // appliance at a time. RFC 8058 one-click is unaffected — Gmail and Yahoo POST,
      // with the op in the query string, which is exactly this path.
      //
      // Confirm is deliberately allowed on GET: a scanner that pre-confirms an address
      // the human was about to confirm anyway costs nothing, and refusing would break
      // the plain link in the email for no gain.
      if (op === 'unsubscribe' && req.method !== 'POST') {
        return json(
          { error: 'method_not_allowed', message: 'Open the unsubscribe link in a browser to confirm.' },
          405,
        );
      }
      return await handleToken(supabase, op, token);
    }
    if (op !== 'join') return json({ error: 'bad_op', message: 'Unknown operation.' }, 400);

    // ── join ────────────────────────────────────────────────────────────────
    const { data: flag } = await supabase.rpc('app_flag', { p_key: 'waitlist_enabled' });
    if (flag === false) {
      return json(
        { error: 'waitlist_closed', message: 'The waitlist is closed right now. Check back soon.' },
        503,
      );
    }

    const email = String(body.email ?? '').trim();
    if (!isEmail(email)) return json({ error: 'invalid_email', message: 'Enter a valid email address.' }, 400);
    if (email.length > 254) return json({ error: 'invalid_email', message: 'That email is too long.' }, 400);

    const roleIntent = ROLE_INTENTS.has(String(body.roleIntent)) ? String(body.roleIntent) : 'both';
    const source = body.source == null ? null : String(body.source).slice(0, 40);
    // A boolean the browser derived from a ZIP it never sent us. Anything that is not
    // an explicit true/false is stored as unknown rather than guessed.
    const inLaunchArea = typeof body.inLaunchArea === 'boolean' ? body.inLaunchArea : null;
    // Resolved HERE, not taken from the request. The consent record has to say which
    // policy was live when the person agreed, and the client asserting that is both
    // spoofable and wrong the moment a new version is published between page load and
    // submit. The form links at /legal/privacy, which always renders the current row —
    // so "current at submit time" is exactly what they were shown.
    let consentDocVersion: string | null = null;
    {
      const { data: doc } = await supabase
        .from('legal_documents')
        .select('version')
        .eq('slug', 'privacy')
        .order('published_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      consentDocVersion = doc?.version ?? null;
    }

    const normalized = normalizeEmail(email);
    const hash = await ipHash(req);
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    // Record the ATTEMPT before deciding, and regardless of outcome — the
    // promo_redeem_attempts rule. A sweep that only ever conflicts on the unique email
    // index would otherwise never register, and ctl_waitlist_signup_flood reads this
    // table. Best effort: a failed ledger write must not refuse a genuine signup.
    await supabase.from('waitlist_attempts').insert({ email: normalized, ip_hash: hash });

    // Layered caps, matching support-submit's shape and its split of who refuses:
    //   • per-IP REFUSES, because it describes the caller's own conduct.
    //   • the global cap DEGRADES — the row is saved, only the email is skipped —
    //     because it describes everyone else's, and refusing would let one flood take
    //     the waitlist away from every real visitor for an hour.
    // There is deliberately no per-email cap: the unique index makes a repeat
    // submission a no-op, so an address cannot accumulate rows at all.
    {
      const { count, error } = await supabase
        .from('waitlist_attempts')
        .select('id', { count: 'exact', head: true })
        .eq('ip_hash', hash)
        .gte('created_at', since);
      // Fail CLOSED: a rate check that cannot run is not permission to proceed.
      if (error) return rateLimited();
      if ((count ?? 0) > 10) return rateLimited();
    }

    const { count: globalCount, error: globalErr } = await supabase
      .from('waitlist')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', since);
    const globalFlood = globalErr ? true : (globalCount ?? 0) >= 200;

    const rawToken = mintToken();
    const tokenHash = await sha256Hex(rawToken);

    // ON CONFLICT DO NOTHING, then read back. A repeat submission is a no-op that
    // still answers {ok:true} — see note 1 at the top of this file.
    const { error: insErr } = await supabase.from('waitlist').insert({
      email: normalized,
      role_intent: roleIntent,
      source,
      in_launch_area: inLaunchArea,
      token_hash: tokenHash,
      consent_doc_version: consentDocVersion,
    });
    // 23505 is the unique violation — the address (or, vanishingly, the token) is
    // already here. Anything else is a real failure and must be reported.
    if (insErr && insErr.code !== '23505') {
      await logServerError(FN, `waitlist insert failed: ${insErr.message}`, { code: insErr.code }, { fatal: true });
      return json({ error: 'server_error', message: 'Something went wrong. Please try again.' }, 500);
    }

    const { data: row } = await supabase
      .from('waitlist')
      .select('id, email, confirmed_at, unsubscribed_at, email_sent_count')
      .eq('email', normalized)
      .maybeSingle();
    if (!row) {
      await logServerError(FN, 'row missing after insert/conflict', { }, { fatal: true });
      return json({ error: 'server_error', message: 'Something went wrong. Please try again.' }, 500);
    }

    // AN OPT-OUT IS NOT REVERSIBLE FROM HERE, and that is the whole point.
    //
    // The first cut of this let a `join` on an unsubscribed row clear unsubscribed_at
    // — "they filled the form in again, they want back". It made the opt-out cancellable
    // by ANYONE who knows the address, with one unauthenticated POST and no proof of
    // mailbox ownership. Worse, `unsubscribed_at is null` is the ONLY suppression
    // predicate anywhere downstream (inviteCohort, both export scopes, every console
    // tab, the partial index), and ctl_waitlist_emailed_after_optout anchors on
    // `unsubscribed_at is not null` — so the same write that un-suppressed the row also
    // blinded the critical control registered to watch exactly this.
    //
    // So a suppressed row is untouched by a join, and never mailed. Somebody who
    // unsubscribed by mistake asks us (the console has a Delete for it); the
    // unsubscribe page says that rather than promising a self-serve route that would
    // have to be reachable by a stranger to work.
    const LIFETIME_EMAIL_CAP = 3;

    // Send when the address is live, unproven, and under the cap — REGARDLESS of
    // whether this request created the row. Gating on `isNew` meant one dropped send
    // (a rotated key, a bounce, a flood window) stranded that address permanently:
    // every later attempt conflicted, took the not-new branch, and skipped the email
    // forever, with the visitor seeing the same cheerful success each time. The
    // lifetime cap is what bounds an address-typer, not the newness of the row.
    const shouldSend =
      !globalFlood &&
      !row.unsubscribed_at &&
      !row.confirmed_at &&
      (row.email_sent_count ?? 0) < LIFETIME_EMAIL_CAP;

    if (shouldSend) {
      await sendConfirmEmail(supabase, row.id, normalized, rawToken, row.email_sent_count ?? 0, tokenHash);
    }

    // The same body in every case. A caller cannot tell a new row from a duplicate,
    // an unsubscribed address, or a suppressed send.
    return json({ ok: true });
  } catch (err) {
    await logServerError(FN, `unhandled: ${err instanceof Error ? err.message : String(err)}`, {}, { fatal: true });
    return json({ error: 'server_error', message: 'Something went wrong. Please try again.' }, 500);
  }
});

/**
 * Mirrors normalize_waitlist_row() in the database, so the client and the row agree.
 *
 * LOWER + TRIM ONLY — no +tag strip, no gmail dot folding, deliberately. The waitlist's
 * address has to be the address GoTrue will see at signup, because inviteCohort writes
 * it into beta_allowlist and handle_new_user compares `lower(email)` against that. Fold
 * jane+hustlr@ulm.edu to jane@ulm.edu here and the invite allowlists an address the
 * person never types, so their signup is refused server-side minutes after we told them
 * they were in. GoTrue treats the two as different accounts; so must we.
 *
 * The cost is that one mailbox can occupy two rows and draw two confirmation emails.
 * That is bounded by the per-IP cap, which is the real bound on an address-typer.
 */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Confirm or unsubscribe. Both are token-only: no session, no email in the request, so
 * knowing somebody's address is not enough to act on their row.
 */
async function handleToken(
  supabase: SupabaseClient,
  op: 'confirm' | 'unsubscribe',
  token: string,
): Promise<Response> {
  if (!token || token.length < 20) return json({ error: 'bad_token', message: 'That link is not valid.' }, 400);
  const tokenHash = await sha256Hex(token);

  const { data: row, error } = await supabase
    .from('waitlist')
    .select('id, email, confirmed_at, unsubscribed_at')
    .eq('token_hash', tokenHash)
    .maybeSingle();
  if (error) {
    await logServerError(FN, `token lookup failed: ${error.message}`, { op }, { fatal: true });
    return json({ error: 'server_error', message: 'Something went wrong. Please try again.' }, 500);
  }
  // A token that matches nothing and a token whose row was purged are the same answer.
  if (!row) return json({ error: 'not_found', message: 'That link has expired or already been used.' }, 404);

  if (op === 'confirm') {
    // Idempotent: clicking twice is a success, not an error. There is no attempt
    // counter to trip and no expiry to explain.
    if (!row.confirmed_at && !row.unsubscribed_at) {
      const { error: upErr } = await supabase
        .from('waitlist')
        .update({ confirmed_at: new Date().toISOString() })
        .eq('id', row.id);
      if (upErr) {
        await logServerError(FN, `confirm failed: ${upErr.message}`, { id: row.id }, { fatal: true });
        return json({ error: 'server_error', message: 'Something went wrong. Please try again.' }, 500);
      }
    }
    return json({ ok: true, email: row.email });
  }

  // Unsubscribe SCRUBS rather than deletes. The address has to survive to suppress
  // future sends — that is what an opt-out list is — but everything else about the
  // person goes, and the token is retired so the link cannot be replayed.
  //
  // Done inline, in the request, never deferred to the purge: honouring an opt-out
  // must not depend on pg_cron running.
  const { error: unErr } = await supabase
    .from('waitlist')
    .update({
      unsubscribed_at: row.unsubscribed_at ?? new Date().toISOString(),
      role_intent: 'both',
      source: null,
      in_launch_area: null,
      invite_wave: null,
      consent_doc_version: null,
      token_hash: `retired:${row.id}`,
    })
    .eq('id', row.id);
  if (unErr) {
    await logServerError(FN, `unsubscribe failed: ${unErr.message}`, { id: row.id }, { fatal: true });
    return json({ error: 'server_error', message: 'Something went wrong. Please try again.' }, 500);
  }
  return json({ ok: true, email: row.email });
}

async function sendConfirmEmail(
  supabase: SupabaseClient,
  id: string,
  email: string,
  rawToken: string,
  sentSoFar: number,
  tokenHash: string,
): Promise<void> {
  const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
  const FROM = Deno.env.get('WAITLIST_FROM');
  if (!RESEND_API_KEY || !FROM) {
    // Not a silent skip. The person is waiting on this email and the operator needs
    // to know the list is filling with addresses nobody can reach.
    await logServerError(FN, 'confirmation email not configured (RESEND_API_KEY or WAITLIST_FROM unset)', {}, { fatal: true });
    return;
  }

  const confirmUrl = `${SITE_URL}/waitlist/confirm?token=${encodeURIComponent(rawToken)}`;
  const unsubUrl = `${SITE_URL}/waitlist/unsubscribe?token=${encodeURIComponent(rawToken)}`;
  // The HEADER target is the function itself: RFC 8058 clients POST to it, which is the
  // one path allowed to mutate. The footer link above goes to a page with a button, so a
  // human is never opted out by a scanner following a link on their behalf.
  const unsubPostUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/waitlist-submit?op=unsubscribe&token=${encodeURIComponent(rawToken)}`;

  // Count the send BEFORE it goes out. If Resend succeeds and the stamp fails, the
  // lifetime cap is gone and the address can be mailed again — the wrong direction to
  // fail in for the one counter that stops inbox-bombing.
  //
  // The `.eq('email_sent_count', sentSoFar)` is a compare-and-set, not decoration: two
  // concurrent submissions of the same address both read the same count, and without it
  // both would stamp the same number and both would send.
  const { data: stamped, error: stampErr } = await supabase
    .from('waitlist')
    .update({
      email_sent_count: sentSoFar + 1,
      last_email_sent_at: new Date().toISOString(),
      // The token in the email being sent RIGHT NOW. Without this a re-send mails a
      // link whose hash was never stored, and the confirm answers 404 — the row would
      // be reachable only by the token from the first attempt, which is the one that
      // did not arrive.
      token_hash: tokenHash,
    })
    .eq('id', id)
    .eq('email_sent_count', sentSoFar)
    .select('id');
  if (!stampErr && (stamped ?? []).length === 0) {
    // Somebody else won the race and is sending. Not an error — just not our send.
    return;
  }
  if (stampErr) {
    await logServerError(FN, `send stamp failed, email suppressed: ${stampErr.message}`, { id }, { fatal: true });
    return;
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM,
        to: [email],
        subject: "You're on the Hustlr list",
        // RFC 8058. Gmail and Yahoo require a one-click unsubscribe on bulk mail, and
        // a header-level opt-out is honoured by clients that never render the footer.
        headers: {
          'List-Unsubscribe': `<${unsubPostUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
        html: `
          <!DOCTYPE html>
          <html lang="en">
          <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light only"></head>
          <body style="margin:0; padding:0; background:#F7F4EC;">
            <div style="display:none; max-height:0; overflow:hidden; opacity:0;">Confirm your email and we&rsquo;ll tell you the day Hustlr opens in Monroe.</div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F7F4EC;">
              <tr><td align="center" style="padding:32px 16px;">
                <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px; max-width:600px; background:#FFFFFF; border-radius:16px; overflow:hidden; border:1px solid #E4DFD3;">
                  <tr><td align="center" style="background:#5038FF; padding:30px 32px 26px;">
                    <img src="https://gohustlr.com/brand/wordmark-cream.png" width="150" height="30" alt="Hustlr" style="display:block; width:150px; height:auto; margin:0 auto; color:#E0A44A; font-family:'Sora',Arial,sans-serif; font-size:30px; font-weight:700;">
                  </td></tr>
                  <tr><td style="height:4px; line-height:4px; font-size:0; background:#EA4637;">&nbsp;</td></tr>
                  <tr><td style="padding:38px 44px 8px;">
                    <h1 style="margin:0 0 16px; font-family:'Sora','Inter',Arial,sans-serif; font-size:27px; line-height:1.25; font-weight:700; color:#363636; letter-spacing:-0.02em;">One tap and you&rsquo;re on the list</h1>
                    <p style="margin:0 0 8px; font-family:'Inter',Arial,sans-serif; font-size:16px; line-height:1.6; color:#6B6482;">Hustlr is a local gig marketplace opening first in Monroe and West Monroe. Confirm this address and we&rsquo;ll email you once &mdash; the day you can get in.</p>
                  </td></tr>
                  <tr><td align="center" style="padding:22px 44px 10px;">
                    <a href="${esc(confirmUrl)}" style="display:inline-block; background:#5038FF; color:#FEF4E5; font-family:'Inter',Arial,sans-serif; font-size:16px; font-weight:600; text-decoration:none; padding:15px 34px; border-radius:14px;">Confirm my email</a>
                  </td></tr>
                  <tr><td style="padding:6px 44px 4px;">
                    <p style="margin:0; font-family:'Inter',Arial,sans-serif; font-size:13px; line-height:1.6; color:#9A93AD;">Didn&rsquo;t sign up? Ignore this email and nothing happens &mdash; we won&rsquo;t write again.</p>
                  </td></tr>
                  <tr><td style="padding:26px 44px 34px; border-top:1px solid #E4DFD3;">
                    <p style="margin:0 0 8px; font-family:'Inter',Arial,sans-serif; font-size:13px; line-height:1.5;">
                      <a href="${esc(unsubUrl)}" style="color:#5038FF; text-decoration:none;">Unsubscribe</a> &middot;
                      <a href="${SITE_URL}/legal/privacy" style="color:#5038FF; text-decoration:none;">Privacy</a> &middot;
                      <a href="mailto:mainmail@gohustlr.com" style="color:#5038FF; text-decoration:none;">Contact</a>
                    </p>
                    <p style="margin:0; font-family:'Inter',Arial,sans-serif; font-size:12px; line-height:1.6; color:#9A93AD;">GoHustlr &middot; ${esc(POSTAL_ADDRESS)}<br>You are receiving this because this address was entered on gohustlr.com. &copy; 2026 GoHustlr</p>
                  </td></tr>
                </table>
              </td></tr>
            </table>
          </body>
          </html>`,
      }),
    });
    if (!res.ok) {
      const detail = await res.text();
      await logServerError(FN, `resend rejected the confirmation: ${res.status}`, { detail: detail.slice(0, 500) }, { fatal: true });
    }
  } catch (e) {
    await logServerError(FN, `resend threw: ${e instanceof Error ? e.message : String(e)}`, { id }, { fatal: true });
  }
}

function rateLimited() {
  return json({ error: 'rate_limited', message: 'Too many requests. Please try again in a little while.' }, 429);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
