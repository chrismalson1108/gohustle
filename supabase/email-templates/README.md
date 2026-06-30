# Hustlr auth emails — branded templates + Resend setup

This folder holds the **branded HTML for every Supabase auth email**, plus the one-time
setup to send them from `@gohustlr.com` via **Resend** instead of Supabase's stock
testing mailer.

Two layers, don't conflate them:

- **Resend** = the delivery pipe (SMTP). It carries the mail and authenticates your domain.
- **Supabase Auth** = what triggers each email, mints the secure token, and renders the
  template. You point Supabase's SMTP at Resend and paste these templates into the dashboard.

> ⚠️ **Why this matters for launch:** Supabase's built-in email service is rate-limited to
> a few messages/hour and is **not for production** — without custom SMTP, most signup and
> reset emails silently fail to deliver. So this is a launch blocker, not just a paint job.

---

## 1. What's in this folder

| File | Supabase template | Suggested subject line | Key variables |
|---|---|---|---|
| `confirm-signup.html` | **Confirm signup** | Confirm your email to start hustling | `{{ .ConfirmationURL }}` |
| `reset-password.html` | **Reset password** | Reset your GoHustlr password | `{{ .ConfirmationURL }}` |
| `magic-link.html` | **Magic Link** | Your GoHustlr sign-in link | `{{ .ConfirmationURL }}` |
| `change-email.html` | **Change Email Address** | Confirm your new email address | `{{ .ConfirmationURL }}`, `{{ .NewEmail }}` |
| `invite.html` | **Invite user** | You're invited to GoHustlr | `{{ .ConfirmationURL }}`, `{{ .Email }}` |
| `reauthentication.html` | **Reauthentication** | Your GoHustlr verification code | `{{ .Token }}` (6-digit code) |

All six share one brand system (Hustlr Brand Guidelines v2.0): Electric Blue `#3F25FE`
header, orange wordmark, the Action-Red `#F21A06` offset strip, Canvas Cream `#F7F3EC`
backdrop, Sora/Inter type. They're table-based, inline-styled, email-safe HTML.

**Brand naming:** the header shows the **Hustlr** wordmark (the logo), and body copy says
**GoHustlr** — mirroring the live website (logo = Hustlr, prose = GoHustlr). The inbox
"from" name should be **GoHustlr** so it matches what users signed up for. If you'd rather
unify these, do a find-and-replace across the six files.

**One support identity:** every footer links **Help** and "Questions? Email …" to
`mailto:mainmail@gohustlr.com` — the app's real, monitored `SUPPORT_EMAIL` (`src/lib/legal.js`).
The logo also degrades gracefully: if the wordmark image can't load yet (domain not connected),
its styled `alt` falls back to an on-brand orange "Hustlr" — never a broken-image box.

**Also part of the email surface:** the `.edu` student-verification OTP sent by
`supabase/functions/student-verify-start/index.ts` was rebranded to match these templates. It
sends via the **Resend API** and now **requires** the `STUDENT_VERIFY_FROM` secret (see §7) — it
no longer falls back to Resend's `onboarding@resend.dev` sandbox.

---

## 2. Logo image must be publicly reachable

The header pulls the wordmark from an absolute URL (email can't use local/relative paths):

```
https://gohustlr.com/brand/wordmark-orange.png
```

`gohustlr.com` is **connected in Vercel and live (HTTPS)** as of 2026-06-30, so this URL resolves
and the logo renders. (If you ever need the pre-domain preview host instead, it's
`https://gohustle-git-master-go-hustlr.vercel.app/brand/wordmark-orange.png` — note `gohustle-chi`
is a *different* project, don't use it.)

**Graceful fallback is also built in:** the `<img>` carries a styled `alt="Hustlr"`, so if a client
blocks images the header shows an on-brand orange "Hustlr" wordmark in text instead of a
broken-image icon — the email never looks broken.

---

## 3. Set up Resend (delivery)

1. **Create the account** → [resend.com](https://resend.com), sign up (GitHub works). Free
   tier is 3,000 emails/month / 100 per day — plenty for early signups; $20/mo for 50k after.
2. **Add your domain** → Resend → **Domains → Add Domain** → `gohustlr.com`.
3. **Authenticate the domain** — Resend shows DNS records. Add them at your registrar
   (**Domain.com**, or Vercel DNS if you moved nameservers per `DEPLOY.md`). You'll get
   roughly:

   | Type | Host / Name | Value | Purpose |
   |---|---|---|---|
   | TXT | `send` | `v=spf1 include:amazonses.com ~all` | **SPF** — authorizes Resend to send as you |
   | CNAME / TXT | `resend._domainkey` | (long key Resend gives you) | **DKIM** — cryptographically signs your mail |
   | MX | `send` | `feedback-smtp.us-east-1.amazonses.com` (priority 10) | bounce/complaint return path |
   | TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:dmarc@gohustlr.com` | **DMARC** — policy + reporting |

   Use the **exact** values Resend displays — the above is illustrative. Publish SPF only on the
   host Resend shows (usually `send`), **never** as a second record on the root `@` — multiple SPF
   records on one name is a permerror that breaks mail for the whole domain. Wait for Resend to
   show the domain as **Verified** (minutes to a couple hours).
4. **Get SMTP credentials** → Resend → **SMTP** (or **API Keys → Create**). You'll get:
   - Host: `smtp.resend.com`
   - Port: `465` (SSL) or `587` (STARTTLS)
   - Username: `resend`
   - Password: your API key (`re_...`)

> **DMARC tip:** make sure the `rua=` mailbox actually exists and is monitored before you publish
> — point it at a real inbox (e.g. `rua=mailto:mainmail@gohustlr.com`) or the aggregate reports
> just bounce and you'll have no alignment data. Start at `p=none` (monitor only); once Resend
> reports clean SPF+DKIM alignment for a week or two, tighten to `p=quarantine` then `p=reject`
> for best inbox placement.

---

## 4. Wire Resend into Supabase (trigger)

Supabase Dashboard → project `nfioebqsgmmzhbksxozc`:

1. **Authentication → Emails → SMTP Settings** → enable **Custom SMTP** and enter the Resend
   host/port/username/password from step 3.
2. Set the sender + reply-to:
   - **Sender email:** a verified `@gohustlr.com` address (e.g. `hello@gohustlr.com`, or just use
     `mainmail@gohustlr.com` to keep one identity everywhere). Avoid `no-reply@` — users reply to
     these.
   - **Sender name:** `GoHustlr`
   - **Reply-To:** `mainmail@gohustlr.com` — so replies always reach the monitored inbox no matter
     which sender address you pick (the footers already send Help there). Removes any dependency on
     a forwarder.
   > The sender domain must match the domain you verified in Resend, or mail fails DMARC.
3. **Authentication → Rate Limits** → raise the email rate limit (the low default only
   existed because of the testing mailer).
4. **Authentication → URL Configuration** → confirm **Site URL** = `https://gohustlr.com`
   and the redirect allow-list includes `https://gohustlr.com/**` (already on the launch
   runbook). This is what makes `{{ .ConfirmationURL }}` resolve correctly.

---

## 5. Paste in the templates

Supabase Dashboard → **Authentication → Emails → Templates**. For each row in the table in
§1: open that template, set the **Subject**, switch the body to **HTML / source** view, and
paste the entire contents of the matching `.html` file. Save. Repeat for all six.

There's no API to bulk-upload these — it's a one-time copy/paste per template.

---

## 6. Test before launch

- **Confirm signup:** sign up a throwaway address → check the email renders (logo loads,
  button works, link confirms). Try Gmail, Apple Mail, and Outlook if you can — desktop
  Outlook is the fussiest renderer.
- **Reset password:** trigger from the app's "Forgot password" → confirm the link lands on
  `gohustlr.com/reset-password`.
- **Deliverability:** send a test to [mail-tester.com](https://www.mail-tester.com) and aim
  for 9–10/10 (it grades SPF, DKIM, DMARC, and spam triggers).
- **Expiry:** Supabase uses **one** setting — **Auth → Email OTP Expiration** — for *both* the
  link tokens (confirm/reset/magic/change) **and** the 6-digit reauthentication code; they can't be
  split without the Send Email Hook. The templates all say **"expires in 1 hour,"** so set it to
  **3600s** to match (a tightening from Supabase's longer default, not a weakening). The reauth code
  also carries "GoHustlr will never ask you for it — don't share it" for anti-phishing. Want a
  shorter window just for the code? That needs the Send Email Hook (§7) — out of scope for launch.
- The separate **`.edu` student-verification** OTP (`student-verify-start`) uses its own 15-minute
  expiry set in code — unrelated to the Supabase setting above.

---

## 7. Beyond auth — transactional + marketing (future)

These templates only cover the six **auth** emails Supabase owns. App events (booking
accepted, gig completed, payout sent, new message) currently fire **push only** — there are
no transactional emails yet. When you want them, the clean path reuses this same Resend
account:

- Add a **`send-email` edge function** (mirror of the existing `send-push`) that the booking
  lifecycle triggers in `JobsContext` call, sending via the **Resend API** (not SMTP).
- Build those templates with **React Email** so transactional + marketing mail shares one
  design system with these auth emails.
- Optional upgrade: Supabase's **Send Email Hook** lets you render *even the auth emails*
  through your own React Email + Resend code, bypassing the dashboard templates entirely —
  one codebase for every email Hustlr sends. More setup; not needed for launch.

---

## Status (updated 2026-06-30)

**✅ Done:**
- The six branded templates + rebranded `.edu` verification email (this repo).
- **Resend domain `gohustlr.com` VERIFIED** — DKIM/SPF/DMARC all green (DNS records live at Domain.com).
- **`gohustlr.com` connected in Vercel + live over HTTPS** (apex → `216.150.1.1`).
- **Supabase Auth → URL Configuration**: Site URL = `https://gohustlr.com`; redirect URLs now
  `https://gohustlr.com/**`, the master-preview URL, and `gohustlr://**` (the stale
  `gohustle-chi.vercel.app` Site URL was removed).

**👤 Still yours (secrets/pastes can't be automated — all in Supabase → Auth → Emails):**
1. **Set up custom SMTP** (the "Set up SMTP" button): create a Resend **API key**, then enter host
   `smtp.resend.com`, port `465`, user `resend`, password = the API key; sender `mainmail@gohustlr.com`,
   name `GoHustlr`. (Entering the API key is the step Claude is not permitted to do.)
2. **Paste the six templates** + subjects (table in §1) into Auth → Emails → Templates, switch each
   Body to **Source/HTML** view, paste the matching `.html`, Save.
3. **Auth → Rate Limits**: raise the email send limit. **Auth → Email OTP Expiration**: 3600s.
4. **Edge function**: set the `STUDENT_VERIFY_FROM` secret (e.g. `GoHustlr <mainmail@gohustlr.com>`)
   and the `RESEND_API_KEY` secret, then redeploy: `supabase functions deploy student-verify-start
   --project-ref nfioebqsgmmzhbksxozc`.
