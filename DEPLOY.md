# Deploying the GoHustlr website + connecting gohustlr.com

The website lives in `web/` (Next.js). It talks to the **same Supabase + Stripe
backend** as the mobile app, so there's no separate backend to deploy — just the
frontend. Recommended host: **Vercel** (built for Next.js, free tier, automatic SSL).

---

## 1. Deploy to Vercel

1. Go to **vercel.com** → sign up / log in **with GitHub**.
2. **Add New… → Project** → import the repo **`chrismalson1108/gohustle`**.
3. Configure the project:
   - **Root Directory:** `web`  ← important (the site is in the `web/` subfolder)
   - **Framework Preset:** Next.js (auto-detected)
   - Under **Build & Development Settings**, leave defaults. If a build error mentions
     `@gohustlr/shared` / `file:../shared`, enable **"Include files outside the root
     directory in the build step"** (Settings → General) so the sibling `shared/` folder
     is available at install time.
4. **Environment Variables** (Settings → Environment Variables) — add the values from
   `web/.env.example`:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
   - `NEXT_PUBLIC_SITE_URL` = `https://gohustlr.com`
   (These are publishable/anon keys — safe. The app also ships defaults, so a deploy
   works even before you set them, but set `NEXT_PUBLIC_SITE_URL` for correct links.)
5. **Branch:** deploy `master` (after the web branch is merged) or `feature/web-app` to
   preview the work-in-progress. **Deploy.**

You'll get a live URL like `gohustle.vercel.app`. Confirm it loads, then add the domain.

---

## 2. Connect gohustlr.com (registrar: Domain.com)

In Vercel: **Project → Settings → Domains → Add** → enter `gohustlr.com` (and
`www.gohustlr.com`). Vercel then shows you DNS records to create. Two options:

**Option A — keep DNS at Domain.com (add records).** In Domain.com's DNS manager:
| Type  | Host / Name | Value                    |
|-------|-------------|--------------------------|
| A     | `@`         | `76.76.21.21`            |
| CNAME | `www`       | `cname.vercel-dns.com`   |
(Use the exact values Vercel shows you — they can differ. Remove any conflicting
existing A/CNAME on `@`/`www`.)

**Option B — let Vercel run DNS (simplest).** In Domain.com, change the domain's
**nameservers** to the ones Vercel gives you (e.g. `ns1.vercel-dns.com`,
`ns2.vercel-dns.com`). Vercel then manages all records + `www` + SSL automatically.

DNS changes take ~10 min–48 hr to propagate. Vercel issues the SSL certificate
automatically once it sees the records.

---

## 3. Point the backend at the production domain (do once)

So email links and redirects land on gohustlr.com, not localhost:

- **Supabase** → Authentication → **URL Configuration**: set **Site URL** to
  `https://gohustlr.com` and add `https://gohustlr.com/**` (and your Vercel preview URL)
  to **Redirect URLs**. This makes email-confirmation and password-reset links work on web.
- **Stripe** (if/when using web payment flows): allowlist `https://gohustlr.com` as a
  return URL for the Connect onboarding / Identity edge functions.

---

## What I (Claude) can vs. can't do here

- ✅ I built the site, the Vercel config (`web/vercel.json`), env template, and this guide.
- ❌ I can't deploy or edit DNS for you without your accounts — both Vercel and Domain.com
  require **your** login, and Domain.com has no automation API I can use safely.
- ⚡ If you create a **Vercel access token** (vercel.com → Settings → Tokens) and share it,
  I can use the Vercel API/CLI to link the project, set env vars, deploy, and **add the
  domain** for you — after which Vercel hands back the exact DNS records, which you paste
  into Domain.com (or switch nameservers). The registrar step stays with you either way.
