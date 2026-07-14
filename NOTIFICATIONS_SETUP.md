# Notifications setup (push + email)

This documents what's **already built/deployed** and the **few provider steps that need you** (accounts/secrets I can't enter). After the "Needs you" steps, notifications work end-to-end.

---

## What's already done ✅

| Piece | Status | Where |
|---|---|---|
| In-app **Alerts inbox** (`notifications` table) | Live | `NotificationsScreen`, `src/lib/notifications.js` |
| **Push** client (register token, `notify()`, tap-routing, gig reminders) | Live | `src/lib/push.js` |
| **Push** server + per-category gating + email path | **Deployed** | `supabase/functions/send-push` |
| `notification_preferences` table + RLS | **Applied to prod** | `supabase/migrations/20260713000000_notification_preferences.sql` |
| Per-category × per-channel **Settings UI** | Code-complete (ships in next build) | `SettingsScreen` → "Notifications" |
| Event `type` on all `notify()` calls (categorization) | Code-complete | `JobsContext`, `MessageSheet` |

**Categories → email defaults** ("high-value only"): Bookings ✉️on · Payments ✉️on · Messages ✉️off · News/marketing ✉️off. All categories push by default. The in-app Alerts inbox always records, regardless of prefs.

---

## Needs you (provider config)

### 1. Email — Resend (`RESEND_API_KEY`)
Notification emails reuse the **same Resend transport** as support/safety/student-verify. They send from `notifications@gohustlr.com` (override with `NOTIFY_FROM`).

1. **Verify the sending domain** (if not already): Resend → Domains → add `gohustlr.com` → add the DNS records (SPF/DKIM) at your registrar. *(Support email already sends from `support@gohustlr.com`, so this is likely done — any address on the verified domain works.)*
2. **Create an API key**: Resend → API Keys → Create (Sending access).
3. **Set the secret** (replace the placeholder — I can't enter it for you):
   ```bash
   supabase secrets set RESEND_API_KEY=re_xxxxxxxx --project-ref nfioebqsgmmzhbksxozc
   # optional, defaults to "GoHustlr <notifications@gohustlr.com>":
   supabase secrets set NOTIFY_FROM="GoHustlr <notifications@gohustlr.com>" --project-ref nfioebqsgmmzhbksxozc
   ```
   Until `RESEND_API_KEY` is set, `send-push` skips email and logs it (push still works). No redeploy needed after setting the secret.

### 2. Push — Apple Push key (APNs)
For a real build (TestFlight/App Store) to **deliver** push, EAS needs an Apple Push Notification key registered. EAS can auto-manage this.

```bash
eas credentials -p ios          # → Push Notifications: set up a Push Key (needs your Apple login)
```
Choose "Let EAS handle it" / generate a new Push Key. This only needs doing once for the bundle id `com.gohustlr.app`. The next build after this will deliver push to devices. (Simulators never receive remote push — test on a physical device via TestFlight.)

### 3. (Recommended) Auth emails — custom SMTP
Signup-confirmation and password-reset emails currently use Supabase's built-in mailer, which is **rate-limited (~3–4/hr)** — fine for dev, too low for a public beta. Point Auth at Resend's SMTP so those emails scale:

- Supabase Dashboard → Authentication → Emails → **SMTP Settings** → enable custom SMTP:
  - Host `smtp.resend.com`, Port `465`, Username `resend`, Password = your `RESEND_API_KEY`, Sender `no-reply@gohustlr.com`.

---

## How it's controlled (mental model)
- **Provider/infra config** (this file): APNs key, `RESEND_API_KEY`, Auth SMTP — one-time, dashboard/CLI.
- **Per-user preferences**: in the app under **Profile → Settings → Notifications** (per-category push/email), stored in `notification_preferences` and honored by `send-push`.

## Verify after setup
- Push: on a TestFlight build on a real phone, trigger a booking event from a second account → the recipient gets a push + an Alerts-inbox entry.
- Email: with `RESEND_API_KEY` set, the same booking/payment event emails the recipient (unless they turned that category's email off). Check the Resend dashboard "Emails" log and the `send-push` function logs.
