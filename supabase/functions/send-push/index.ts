// Sends an Expo push notification to a target user's registered devices.
// Called by the client at booking/message events. Auth: any signed-in user may
// notify another (notifications are non-sensitive event pings). Recipient tokens
// are read with the service role. Dead tokens (DeviceNotRegistered) are pruned.
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Require a valid signed-in caller.
    const authToken = req.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
    const { data: { user }, error: authErr } = await supabase.auth.getUser(authToken);
    if (authErr || !user) return json({ error: 'Unauthorized' }, 401);

    const { userId, title, body, data } = await req.json();
    if (!userId || !title) return json({ error: 'userId and title are required' }, 400);

    // Don't notify yourself.
    if (userId === user.id) return json({ sent: 0, skipped: 'self' });

    // Anti-spoof: only allow notifying someone you share a booking with, so this
    // endpoint can't be used to plant arbitrary alerts in a stranger's inbox. We
    // also collect the shared job_ids so a caller can only deep-link to a gig the
    // two users actually transacted on.
    const [asEarner, asPoster] = await Promise.all([
      supabase.from('bookings').select('id, job_id, jobs!bookings_job_id_fkey!inner(poster_id)')
        .eq('earner_id', user.id).eq('jobs.poster_id', userId),
      supabase.from('bookings').select('id, job_id, jobs!bookings_job_id_fkey!inner(poster_id)')
        .eq('earner_id', userId).eq('jobs.poster_id', user.id),
    ]);
    const sharedRows = [...(asEarner.data ?? []), ...(asPoster.data ?? [])];
    if (!sharedRows.length) return json({ error: 'Not allowed to notify this user' }, 403);
    const sharedJobIds = new Set(sharedRows.map((r: any) => r.job_id).filter(Boolean));

    // Anti-spam rate limit: cap sends per caller so a booking counterparty can't
    // loop this endpoint to flood the target's devices + persistent Alerts inbox.
    // Service-role table (push_send_rate) with no client policies; mirrors the
    // assistant_rate pattern. Best-effort — fail open if the table is missing, but
    // log loudly so a missing cap is surfaced in monitoring, not hidden.
    try {
      await supabase.from('push_send_rate').insert({ user_id: user.id });
      const sinceMin = new Date(Date.now() - 60_000).toISOString();
      const { count } = await supabase
        .from('push_send_rate')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .gte('created_at', sinceMin);
      if ((count ?? 0) > 30) return json({ error: 'rate_limited' }, 429);
      // Opportunistic cleanup so the table stays bounded per active user.
      supabase.from('push_send_rate').delete().eq('user_id', user.id)
        .lt('created_at', new Date(Date.now() - 3_600_000).toISOString()).then(() => {}, () => {});
    } catch (e) {
      console.error('send-push: rate-limit check unavailable (cap NOT enforced):', e);
    }

    // Harden caller-supplied content against notification spoofing / phishing and
    // deep-link manipulation: strip control chars, cap length, whitelist the type
    // and routing tab, and only honor a job deep-link that belongs to a shared job.
    const KNOWN_TYPES = new Set(['update', 'booking', 'message', 'review', 'payment', 'amendment', 'tip', 'system']);
    const KNOWN_TABS = new Set(['HomeTab', 'EarnTab', 'GigsTab', 'MessagesTab', 'ProfileTab']);
    const CTRL = new RegExp("[\u0000-\u001F\u007F]", "g");
    const clean = (s: unknown, max: number) =>
      String(s ?? "").replace(CTRL, "").trim().slice(0, max);
    const safeTitle = clean(title, 100);
    if (!safeTitle) return json({ error: 'title required' }, 400);
    const safeBody = clean(body, 280);
    const rawType = data && typeof data.type === 'string' ? data.type : 'update';
    const safeType = KNOWN_TYPES.has(rawType) ? rawType : 'update';
    const rawTab = data && typeof data.tab === 'string' ? data.tab : null;
    const safeTab = rawTab && KNOWN_TABS.has(rawTab) ? rawTab : null;
    const rawJobId = data && typeof data.jobId === 'string' ? data.jobId : null;
    const safeJobId = rawJobId && sharedJobIds.has(rawJobId) ? rawJobId : null;
    const safeData: Record<string, unknown> = { type: safeType };
    if (safeTab) safeData.tab = safeTab;
    if (safeJobId) safeData.jobId = safeJobId;

    // Resolve the recipient's notification preferences (service role bypasses
    // RLS). Map the event type to a user-facing category; 'system'/'update'
    // events aren't categorized — treated as always-on push, never email.
    // Keep DEFAULT_PREFS in sync with notification_preferences column defaults
    // and DEFAULT_NOTIF_PREFS in src/lib/notifications.js.
    // NOTE (marketing / "News & tips"): notification_preferences persists
    // marketing_push/marketing_email and both clients render a working toggle, but
    // no notification type currently resolves to the 'marketing' category, so the
    // preference is inert today. If a marketing/news blast is ever sent, its type
    // MUST be added to KNOWN_TYPES *and* mapped to 'marketing' here so this switch
    // enforces the user's opt-out by construction — never send marketing through a
    // path that skips this map (a CAN-SPAM trap). The 'marketing' entry below makes
    // that wiring correct the moment such a type is whitelisted.
    const CATEGORY: Record<string, string | null> = {
      booking: 'bookings', amendment: 'bookings', review: 'bookings',
      message: 'messages',
      payment: 'payments', tip: 'payments',
      marketing: 'marketing',
      update: null, system: null,
    };
    const DEFAULT_PREFS: Record<string, boolean> = {
      bookings_push: true, bookings_email: true,
      messages_push: true, messages_email: false,
      payments_push: true, payments_email: true,
      marketing_push: true, marketing_email: false,
    };
    // SERVER-DEFINED email templates keyed on the whitelisted notification type.
    // The branded email (platform domain) NEVER interpolates the caller-supplied
    // title/body — those flow only to push + the in-app inbox. This closes the
    // phishing vector where a booking counterparty could put an arbitrary subject
    // ("Your payout failed") + lookalike-URL body into mail from gohustlr.com.
    // Emails are deliberately generic ("there's an update, open the app"); the
    // real detail lives behind the login. A type with no template gets no email.
    const EMAIL_TEMPLATES: Record<string, { subject: string; heading: string; body: string }> = {
      booking: { subject: 'Update on your GoHustlr booking', heading: 'You have a booking update', body: 'There’s a new update on one of your bookings. Open the GoHustlr app to see the details and respond.' },
      amendment: { subject: 'A booking change needs your attention', heading: 'A booking amendment', body: 'Someone proposed or responded to a change on one of your bookings. Open the GoHustlr app to review it.' },
      review: { subject: 'You have a new review on GoHustlr', heading: 'New review', body: 'Someone left you a new review. Open the GoHustlr app to see it.' },
      message: { subject: 'You have a new message on GoHustlr', heading: 'New message', body: 'You have a new message waiting. Open the GoHustlr app to read and reply.' },
      payment: { subject: 'A payment update on GoHustlr', heading: 'Payment update', body: 'There’s an update related to a payment on your account. Open the GoHustlr app for details.' },
      tip: { subject: 'You received a tip on GoHustlr', heading: 'You got a tip', body: 'Someone sent you a tip on GoHustlr. Open the app to see the details.' },
    };
    const category = CATEGORY[safeType] ?? null;
    let prefs: Record<string, any> = DEFAULT_PREFS;
    try {
      const { data: prefRow } = await supabase
        .from('notification_preferences')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();
      if (prefRow) prefs = { ...DEFAULT_PREFS, ...prefRow };
    } catch (e) {
      console.error('send-push: prefs lookup failed, using defaults', e);
    }
    // Uncategorized events always push (critical/system); email only when the
    // recipient explicitly opted into this category's email channel.
    const pushAllowed = category ? prefs[`${category}_push`] !== false : true;
    const emailAllowed = category ? prefs[`${category}_email`] === true : false;

    // Persist an in-app alert (best-effort) so the recipient sees it in their
    // Alerts inbox even without a push-capable device. The inbox is the passive
    // notification center and is written regardless of push/email prefs. A
    // missing column (before the inbox migration) just logs and continues.
    try {
      await supabase.from('notifications').insert({
        user_id: userId,
        type: safeType,
        title: safeTitle,
        body: safeBody || null,
        job_id: safeJobId,
        data: safeData,
      });
    } catch (e) {
      console.error('send-push: notification insert failed', e);
    }

    // ── OS push (Expo) — gated on the recipient's per-category push pref ──
    let sent = 0;
    let pruned = 0;
    if (pushAllowed) {
      const { data: rows } = await supabase
        .from('push_tokens')
        .select('token')
        .eq('user_id', userId);

      const tokens = (rows ?? [])
        .map(r => r.token)
        .filter((t: string) => typeof t === 'string' && t.startsWith('ExponentPushToken'));

      if (tokens.length) {
        const messages = tokens.map((to: string) => ({
          to,
          title: safeTitle,
          body: safeBody,
          data: safeData,
          sound: 'default',
          priority: 'high',
        }));

        const res = await fetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(messages),
        });
        const result = await res.json();

        // Prune tokens Expo reports as no longer registered.
        const tickets = Array.isArray(result?.data) ? result.data : [];
        const dead: string[] = [];
        tickets.forEach((t: any, i: number) => {
          if (t?.status === 'error' && t?.details?.error === 'DeviceNotRegistered') {
            dead.push(tokens[i]);
          }
        });
        if (dead.length) {
          await supabase.from('push_tokens').delete().eq('user_id', userId).in('token', dead);
        }
        sent = tokens.length;
        pruned = dead.length;
      }
    }

    // ── Email (Resend) — only for high-value categories the recipient opted
    // into, and only when RESEND_API_KEY is configured. Subject + body come from
    // the SERVER-DEFINED EMAIL_TEMPLATES (never the caller's strings), so the
    // branded email can't be turned into a phishing message. Best-effort: an
    // email problem never fails the request (push/inbox already delivered). ──
    let emailed = false;
    const template = EMAIL_TEMPLATES[safeType];
    if (emailAllowed && template) {
      // Per-(caller→recipient) email throttle. The push cap above is per-caller and
      // push-only; without this a booking counterparty could loop this endpoint to
      // email-bomb the other party through the branded transactional path. Cap at
      // EMAIL_CAP_PER_HR branded emails/hour to a given recipient, keyed on a UUID
      // DERIVED from (caller, recipient) so the ledger row never collides with the
      // real per-caller push counts above (a derived key can at worst make throttling
      // slightly stricter — never weaker). Reuses the push_send_rate ledger (insert +
      // windowed count + opportunistic cleanup). Fail-OPEN if the ledger is missing
      // (house convention) but log loudly so a missing cap surfaces in monitoring.
      const EMAIL_CAP_PER_HR = 5;
      let emailThrottled = false;
      try {
        const emailKey = await deriveKey(user.id, userId, 'email');
        await supabase.from('push_send_rate').insert({ user_id: emailKey });
        const sinceHr = new Date(Date.now() - 3_600_000).toISOString();
        const { count } = await supabase
          .from('push_send_rate')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', emailKey)
          .gte('created_at', sinceHr);
        if ((count ?? 0) > EMAIL_CAP_PER_HR) {
          emailThrottled = true;
          console.error('send-push: email throttled (hourly cap reached) for recipient', userId);
        }
        // Opportunistic cleanup so the derived-key rows stay bounded.
        supabase.from('push_send_rate').delete().eq('user_id', emailKey)
          .lt('created_at', new Date(Date.now() - 3_600_000).toISOString()).then(() => {}, () => {});
      } catch (e) {
        console.error('send-push: email throttle check unavailable (cap NOT enforced):', e);
      }
      if (!emailThrottled) {
        try {
          const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
          if (!RESEND_API_KEY) {
            console.error('send-push: RESEND_API_KEY unset — email skipped for', userId);
          } else {
            const { data: recipient } = await supabase.auth.admin.getUserById(userId);
            const to = recipient?.user?.email;
            if (to) {
              const FROM = Deno.env.get('NOTIFY_FROM') || 'GoHustlr <notifications@gohustlr.com>';
              const res = await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ from: FROM, to: [to], subject: template.subject, html: emailHtml(template.heading, template.body) }),
              });
              emailed = res.ok;
              if (!res.ok) console.error('send-push: resend error', await res.text().catch(() => ''));
            }
          }
        } catch (e) {
          console.error('send-push: email send failed', e);
        }
      }
    }

    return json({ sent, pruned, emailed, pushAllowed, emailAllowed });
  } catch (err: any) {
    console.error('send-push:', err);
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// Deterministic UUID-format key derived from parts (SHA-256 → first 16 bytes).
// Used to namespace the per-(caller→recipient) email throttle inside the
// push_send_rate ledger so its rows never collide with real per-caller push counts.
async function deriveKey(...parts: string[]): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('|')));
  const b = [...new Uint8Array(digest).slice(0, 16)].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${b.slice(0, 8)}-${b.slice(8, 12)}-${b.slice(12, 16)}-${b.slice(16, 20)}-${b.slice(20, 32)}`;
}

// Minimal branded HTML for a notification email. Caller-supplied strings are
// already control-char-stripped and length-capped; escape for HTML safety here.
function emailHtml(title: string, body: string): string {
  const esc = (s: string) =>
    String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html><html><body style="margin:0;background:#F5F3FF;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #ECE9F5;">
    <div style="background:#6D28D9;padding:20px 24px;"><span style="color:#ffffff;font-size:20px;font-weight:800;">GoHustlr</span></div>
    <div style="padding:24px;">
      <h1 style="margin:0 0 8px;font-size:18px;color:#1A1523;">${esc(title)}</h1>
      ${body ? `<p style="margin:0;font-size:15px;line-height:1.5;color:#4A4458;">${esc(body)}</p>` : ''}
      <p style="margin:20px 0 0;font-size:13px;color:#9A93AD;">Open the GoHustlr app to respond.</p>
    </div>
    <div style="padding:16px 24px;border-top:1px solid #ECE9F5;">
      <p style="margin:0;font-size:12px;color:#9A93AD;">You're receiving this because of your notification settings. Change them anytime in the app under Profile → Settings → Notifications.</p>
    </div>
  </div>
</body></html>`;
}
