# Hustlr brand assets — single source of truth

This folder is the **one place** the Hustlr logo lives. Both the **web app** (`web/`) and the
**mobile app** (Expo, root) pull their logos/icons from here, so updating a logo is a one-folder,
one-command operation.

## Files

| File | What it is | Used for |
|---|---|---|
| `wordmark-blue.png` | **Horizontal lockup** — mark + "HUSTLR", blue, transparent | Logo on **light** surfaces. NOTE the filename says wordmark but the art is the LOCKUP; `src/components/Logo.js` depends on that and hardcodes its aspect ratio |
| `wordmark-cream.png` | Same lockup, cream | Logo on **dark/blue** surfaces |
| `wordmark-ink.png` | Same lockup, ink | Print / mono contexts. Not distributed by `brand:sync` — no consumer today |
| `monogram-blue.png` | H-mark alone, blue, transparent | Compact mark on light surfaces |
| `monogram-cream.png` | H-mark alone, cream, transparent | Compact mark on dark/blue surfaces |
| `app-icon.png` | 1024² Electric-Blue square + cream monogram, **opaque** | iOS/store icon, web favicon, apple-touch |
| `android-foreground.png` | Cream monogram, safe-zone padded, transparent | Android adaptive icon foreground |
| `android-background.png` | Solid Electric Blue #5038FF 1024² | Android adaptive icon background |
| `android-monochrome.png` | White monogram silhouette, transparent | Android 13 themed icon **and** the expo-notifications small icon (two consumers) |
| `og-image.png` | 1200×630 blue + cream lockup | Social / Open Graph **and** Twitter card. Must stay exactly 1200×630 |
| `lockup-on-blue.png` / `lockup-on-orange.png` | Legacy solid-bg lockups | No consumer. `-orange` predates the v3 retirement of Hustle Orange |
| `vector/` | SVG source of truth, all colorways | Where the art actually lives — see `vector/README.txt` |

## How to update a logo (both platforms at once)

1. Replace the file(s) in **this folder** (keep the same filename; keep PNGs transparent where they are now).
2. From the repo root, run:
   ```bash
   npm run brand:sync
   ```
   This copies every asset into the places each platform expects:
   - **Web** → `web/public/brand/`, plus `web/app/icon.png`, `web/app/apple-icon.png`, `web/app/opengraph-image.png` (Next.js App Router conventions).
   - **Mobile** → `assets/icon.png`, `assets/favicon.png`, `assets/android-icon-*.png` (the paths in `app.json`).
     It also writes `assets/brand/*`, but nothing reads those: `src/components/Logo.js`
     requires from `shared/assets/brand/` directly.
3. Commit. Web picks it up on the next deploy; mobile on the next EAS build.

**Never edit the copies** under `web/public/brand`, `web/app/*icon*`, or `assets/` directly — they are
overwritten by `brand:sync`. Edit here.

## Two things that are easy to get wrong

- **`assets/splash-icon.png` is NOT in the sync manifest.** It is written directly by
  `scripts/gen-brand-assets-v3.js`. Running only `brand:sync` after new art lands
  leaves the splash screen on the old logo.
- **Web renders none of these PNGs in its UI.** Every logo a web user sees is inline
  SVG from `web/components/brand/glyphs.tsx`, hand-copied from `vector/logo/`. These
  rasters reach web only as the favicon, apple-touch icon and OG card. Changing the
  art here without editing `glyphs.tsx` ships a new favicon beside the old in-app logo.

> Provenance: regenerate with `node scripts/gen-brand-assets-v3.js` (Brand v3.0 — recolors
> `vector/logo/` to Electric Blue #5038FF and re-renders every raster at its existing
> dimensions). `scripts/gen-brand-assets.py` is the older v1 generator, kept for reference.
