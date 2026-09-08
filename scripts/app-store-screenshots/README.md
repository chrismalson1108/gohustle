# App Store screenshot generator

Renders the App Store screenshot set from the app's own design tokens, at the exact pixel
sizes App Store Connect requires.

```bash
node scripts/app-store-screenshots/render.mjs            # all screens, all sizes
node scripts/app-store-screenshots/render.mjs 02-gig     # one screen (substring match)
```

Output lands in `docs/app-store/screenshots/`. See `docs/app-store/SUBMISSION.md` for which
set to upload and in what order.

## What this is, and what it is not

These are **rendered**, not captured from a running device. Every colour, radius, font size,
icon and string is taken from the real components — `shared/theme.js`, the Ionicons glyph
set `@expo/vector-icons` resolves, `shared/pricing.js` for the fee maths, `shared/ledger.js`
for the ledger labels — and `screens.mjs` mirrors the layout of the corresponding screen.
The content is fictional demo data.

That makes them accurate and instantly regenerable, but it also means **they can drift**:
nothing fails when a screen changes and this file does not. Before uploading, install the
build and compare. If a screen has moved on, fix `screens.mjs` and re-run — never hand-edit
a PNG, because the next run overwrites it.

## Layout

| File | |
|---|---|
| `bootstrap.mjs` | Fetches Inter + Ionicons from the npm registry into a gitignored `.cache/`. Fonts are not committed — they are not source, and the registry is reachable where a CDN may not be. |
| `base.mjs` | Design tokens mirrored from `shared/theme.js`, the shared chrome (status bar, nav bar, floating tab bar, avatars, rating stars) and the icon helper. |
| `screens.mjs` | One function per screen plus its demo data, and the `SCREENS` map that names the output files and their marketing captions. |
| `render.mjs` | Finds a Chromium, measures its window-chrome inset, and shoots every screen at every size in both the plain and captioned variants. |

## Adding a screen

Write a function in `screens.mjs` returning `doc(inner, css)`, then add it to `SCREENS`
with a caption. Reuse the helpers in `base.mjs` rather than re-deriving chrome — the tab
bar, nav bar and status bar are shared for the same reason the app shares its components.

## Requirements

Node 22+, `curl` and `tar` on PATH, and a Chromium. The script prefers Playwright's bundled
`headless_shell`, then a system Chrome/Chromium; set `CHROME_PATH` to override.

`--headless=new` reserves browser chrome inside `--window-size`, which silently shrinks the
viewport and crops the bottom of every screen. `render.mjs` measures that inset at startup
and adds it back, so both binaries produce identical output.
