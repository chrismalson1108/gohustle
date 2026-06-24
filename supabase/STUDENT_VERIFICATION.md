# Verified Student — setup & operations

Adds college identity (school/major/degree/grad year) to profiles and a **Verified
Student** trust badge, earned by confirming a `.edu` email. Works on web + mobile.

## One-time setup

1. **Run the migration** in the Supabase SQL editor (idempotent — safe to re-run):
   `supabase/migration_student_verification.sql`
   It adds the college columns, the `student_email_verifications` table, and a
   trigger that stops clients from self-setting the verified flag.

2. **Deploy the two edge functions:**
   ```bash
   supabase functions deploy student-verify-start
   supabase functions deploy student-verify-confirm
   ```

3. **Set the email-provider secret** (the code is emailed via [Resend](https://resend.com),
   free tier is plenty). Create an API key, then:
   ```bash
   supabase secrets set RESEND_API_KEY=re_xxx
   # optional — defaults to Resend's shared test sender if unset:
   supabase secrets set STUDENT_VERIFY_FROM="GoHustlr <verify@gohustlr.com>"
   ```
   Until `RESEND_API_KEY` is set, the verify flow returns a clear
   `email_not_configured` message instead of silently failing.
   For a custom From address (`verify@gohustlr.com`) you must verify the domain in
   Resend; otherwise use the default test sender.

## How it works

- User enters their `.edu` email → `student-verify-start` stores a **hashed** 6-digit
  code (15-min expiry, rate-limited) and emails it.
- User enters the code → `student-verify-confirm` checks the hash and, via the service
  role, sets `student_verified = true`, `student_verify_method = 'edu_email'`, and the
  verified `school_domain`.
- The badge then appears anywhere a profile is shown (Profile, Public Profile, Poster
  Trust Card, Job cards) and powers the **"Verified students only"** Browse filter.

## Upgrade path — authoritative verification (later)

`.edu` email is a strong, free signal but not proof of *current* enrollment. To add an
authoritative tier (and a stronger "Currently Enrolled" badge):

- **SheerID** (industry standard; current-enrollment checks, webhooks, embeddable widget —
  quote-based B2B pricing) or **VerifyPass** (lighter weight).
- Integration shape: add a `student-verify-sheerid` edge function that creates a SheerID
  verification and a webhook handler that, on success, sets
  `student_verify_method = 'sheerid'` (and optionally a separate `enrollment_verified`
  flag). The profile columns and UI already accommodate this — only the verification
  source changes.
