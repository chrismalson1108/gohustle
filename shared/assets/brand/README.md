# Hustlr brand assets — single source of truth

This folder is the **one place** the Hustlr logo lives. Both the **web app** (`web/`) and the
**mobile app** (Expo, root) pull their logos/icons from here, so updating a logo is a one-folder,
one-command operation.

## Files

| File | What it is | Used for |
|---|---|---|
| `wordmark-blue.png` | "Hustlr" wordmark, blue + red offset, **transparent** | Logo on **light** surfaces (cream/white headers, login, sidebar) |
| `wordmark-orange.png` | "Hustlr" wordmark, orange + red offset, **transparent** | Logo on **dark/blue** surfaces |
| `monogram-orange.png` | H‑monogram, orange + red offset, transparent | Compact mark / app‑icon source |
| `monogram-blue.png` | H‑monogram, blue + red offset, transparent | Compact mark on light surfaces |
| `app-icon.png` | 1024² Electric‑Blue square + orange monogram, **opaque** | iOS/store icon, web favicon, apple‑touch |
| `android-foreground.png` | Orange monogram, safe‑zone padded, transparent | Android adaptive icon foreground |
| `android-background.png` | Solid Electric‑Blue 1024² | Android adaptive icon background |
| `android-monochrome.png` | White monogram silhouette, transparent | Android 13 themed icon |
| `og-image.png` | 1200×630 blue + orange wordmark | Social / Open Graph preview |
| `lockup-on-blue.png` / `lockup-on-orange.png` | Official solid‑bg wordmark lockups | Social tiles, print |

## How to update a logo (both platforms at once)

1. Replace the file(s) in **this folder** (keep the same filename; keep PNGs transparent where they are now).
2. From the repo root, run:
   ```bash
   npm run brand:sync
   ```
   This copies every asset into the places each platform expects:
   - **Web** → `web/public/brand/`, plus `web/app/icon.png`, `web/app/apple-icon.png`, `web/app/opengraph-image.png` (Next.js App Router conventions).
   - **Mobile** → `assets/icon.png`, `assets/favicon.png`, `assets/android-icon-*.png` (the paths in `app.json`), plus `assets/brand/` for in‑app `<Image>` use.
3. Commit. Web picks it up on the next deploy; mobile on the next EAS build.

**Never edit the copies** under `web/public/brand`, `web/app/*icon*`, or `assets/` directly — they are
overwritten by `brand:sync`. Edit here.

> Provenance: `wordmark-*.png` were keyed from the designer's solid‑background exports
> (Hustlr Branding "Group 2"/"Group 3"); the icon variants were composed from `monogram-orange.png`.
> The original generation script is `scripts/gen-brand-assets.py` if a regenerate from raw exports is ever needed.
