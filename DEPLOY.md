# Deploying the GoHustlr website + connecting gohustlr.com

The website lives in `web/` (Next.js). It talks to the **same Supabase + Stripe
backend** as the mobile app, so there's no separate backend to deploy — just the
frontend. Recommended host: **Vercel** (built for Next.js, free tier, automatic SSL).

---

## 1. Deploy to Vercel

> **Status (2026-06-30): already done.** The project is created and linked
> (`go-hustlr/gohustle`, linked at the **repo root** `.vercel/`, Root Directory = `web`),
> GitHub is connected so **every push to `master` auto-deploys to production**, and the
> deployment-protection login wall is **off**. The current production URL is
> **`https://gohustle-git-master-go-hustlr.vercel.app`** (until `gohustlr.com` is connected — §2).
> CLI deploys must run **from the repo root** (`npx vercel --prod`), NOT from `web/`, or the
> `../shared` package is excluded and the build fails. The steps below are the original setup
> reference.

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
5. **Branch:** `master` is the **production branch** (auto-deploys to production); other
   branches deploy as previews.

The live URL is **`https://gohustle-git-master-go-hustlr.vercel.app`** (NOT `gohustle.vercel.app`
— that's an unrelated project). Confirm it loads, then add the domain below.

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
- **Stripe** return URLs: ✅ already handled in code — the Connect/Identity edge functions
  allowlist `gohustlr.com` (and `*.vercel.app`) and default to `https://gohustlr.com`, so once
  DNS is live the mobile payout/ID return pages + 302 backstops resolve with no code change.

---

## What I (Claude) can vs. can't do here

- ✅ I built the site and can **deploy it** — the Vercel CLI is authed (`mainmail-1145`) and
  the project is linked, so I run `npx vercel --prod` **from the repo root** when changes are
  ready (and pushes to `master` auto-deploy anyway).
- ⚡ I can **add the domain** in Vercel via CLI (`vercel domains add gohustlr.com`), which hands
  back the exact DNS records to paste into Domain.com.
- ❌ I **can't edit DNS at Domain.com** (no safe automation API — that step is yours), and by
  policy I won't change account/security settings or enter credentials. I give exact steps and
  verify the result after.
