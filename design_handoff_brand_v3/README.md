# Handoff: Hustlr Brand v3.0 — App-Wide Rebrand

## Overview

This package migrates the GoHustlr Expo/React Native app (and the Next.js marketing
site) from Brand Guidelines v2.0 to **v3.0**: a new logo, a new primary blue, the
retirement of Hustle Orange, and a slightly cooler canvas cream.

**This is a rebrand, not a redesign.** The design mockups in this bundle were
rebuilt *from* the app's own screen files, so screen structure, type scale,
spacing, card anatomy and iconography already match what ships today. The change
surface is deliberately tiny:

| Area | Change |
|---|---|
| Color tokens | Yes — 4 values + orange retirement |
| Logo / app icon / splash | Yes — new artwork |
| Iconography | **No change.** App already uses Ionicons via `@expo/vector-icons`; the mockups were switched to match it, not the reverse |
| Type scale | **No change.** Mockups match `ProfileScreen.js` / `JobDetailScreen.js` values |
| Radii, shadows, spacing | **No change** |
| Screen layout | **No change.** Nothing moves on any screen |

## About the Design Files

`Hustlr App Mockups v2.dc.html` in this bundle is a **design reference created in
HTML** — a prototype showing intended look, not production code to copy. It renders
six phone-sized frames side by side. Use it as the visual acceptance criteria for
the React Native work; do not port its markup.

Every value in it was derived from the repo. Where the mockup and this README
disagree, **this README wins**.

## Fidelity

**High-fidelity.** Final colors, typography, spacing and states. The mockups are
faithful recreations of the live screens with v3 branding applied, so any visual
delta you see between the mockup and the running app is either (a) a token change
listed below, or (b) a bug worth flagging — not a redesign decision.

---

## Stage 1 — Design tokens (do this first, alone)

Replace `shared/theme.js` with the `theme.js` in this bundle.

Every screen reads from `colors.*`, so this one file rebrands the whole app with
**zero logic touched**. No component file changes in this stage.

### Token changes

| Key | v2.0 | v3.0 | Note |
|---|---|---|---|
| `primary` | `#3F25FE` | `#5038FF` | Electric Blue |
| `primaryDark` | `#2B17C2` | `#2E1BC7` | gradient end |
| `primaryLight` | `#E9E6FF` | `#EAE6FF` | blue wash |
| `secondary` | `#5538FF` | `#6B54FF` | gradient start |
| `urgent` | `#F21A06` | `#EA4637` | Action Red |
| `urgentLight` | `#FFE7E3` | `#FFE7E3` | unchanged |
| `background` | `#F7F3EC` | `#F7F4EC` | Canvas Cream |
| `textPrimary` | `#181231` | `#363636` | brand Ink — 10.5:1 on canvas |
| `textSecondary` | `#5B5570` | `#6B6482` | |
| `border` | `#E8E2D5` | `#E4DFD3` | |
| `divider` | `#F0EBDF` | `#EFEBE1` | |
| `accent` / `gold` | `#FFBC45` | `#E0A44A` | **deprecated alias** — see below |
| `accentLight` / `goldLight` | `#FFF1D6` | `#FDF0DA` | **deprecated alias** |
| `accentDeep` | `#9A5B00` | `#8A5A12` | **deprecated alias** |
| `success` / `successLight` | — | unchanged | |
| `radii`, `shadows` | — | **unchanged** | mockups built to these |

### About the orange retirement — read before deleting anything

Hustle Orange `#FFBC45` is retired as a *brand* color. But `accent`, `accentLight`,
`accentDeep`, `gold` and `goldLight` are imported in at least six places:

- `src/screens/JobDetailScreen.js` — `payPill` / `payText`, `STATUS_CONTENT.pending`, `statChip`
- `src/components/MoneyGoalCard.js` — `PACE` map
- `src/components/BadgeGrid.js` — badge icon color, `emptyIcon`
- `src/screens/EarnScreen.js` — `nudgeRate`
- `src/screens/GigsScreen.js` — stat chips
- `src/screens/ProfileScreen.js` — `noReviewsIcon`

**Deleting those keys breaks the build.** The new `theme.js` keeps all five as
deprecated aliases pointing at a muted semantic amber, so Stage 1 compiles and
looks correct immediately. Two new token groups are added for Stage 3 to migrate to:

- `warning` / `warningLight` / `warningDeep` — lifecycle "pending" only
- `wash` / `washDeep` — the blue tint that replaces orange on money surfaces

### Web parity

`shared/theme.js` documents itself as being kept in lockstep with
`web/app/globals.css`. Apply the same hex mapping there in the **same commit** —
see `globals-css-map.md` in this bundle. Do not rewrite that file wholesale; do a
value-level find/replace so the Tailwind `@theme` variable names stay intact.

---

## Stage 2 — Brand assets

Source artwork is in `brand/` in this bundle (SVG, all colorways).

| Asset | File | Where it goes |
|---|---|---|
| Mark (3-bar) | `mark-{blue,cream,ink,paper,white}.svg` | `shared/assets/brand/` |
| Wordmark | `wordmark-{blue,cream,ink,paper,white}.svg` | `shared/assets/brand/` |
| Lockup (mark + wordmark on blue pill) | `lockup-blue.svg` | `shared/assets/brand/` |
| App icon | `appicon.svg` | export to 1024² PNG → `assets/icon.png` |
| Pattern tile | `pattern-{ink,cream,blue,white,paper}.svg` | marketing only — **not** app screens |

**Keep the existing filenames** where `shared/assets/brand/README.md` defines them,
so no import paths change.

Notes:
- The mark and wordmark have a fixed relationship: **mark height = 1.068 × wordmark
  height**, gap = 0.472 × wordmark height. Measured from the official lockup; don't
  eyeball it.
- `android-background.png` should become solid `#5038FF`.
- The pattern is a seamless tile at aspect **2329 × 1690** (1.378:1). It is
  explicitly **not** used as an app screen background in v3 — cream carries the app.

---

## Stage 3 — Semantic cleanup (one screen per commit)

Migrate the deprecated `accent*` call sites off amber, then delete the aliases.

| Call site | Change to |
|---|---|
| `JobDetailScreen` `payPill` bg / `payText` | `colors.wash` / `colors.washDeep` |
| `JobDetailScreen` `STATUS_CONTENT.pending` | `colors.warningLight` / `colors.warningDeep` |
| `JobDetailScreen` `statChip` | `colors.wash` / `colors.washDeep` |
| `MoneyGoalCard` `PACE` | `behind` keeps urgent; others → `warning*` |
| `BadgeGrid` icon color | `colors.primary` |
| `EarnScreen` `nudgeRate` | `colors.warningLight` |
| `GigsScreen` stat chips | `colors.wash` / `colors.washDeep` |

Then remove `accent`, `accentLight`, `accentDeep`, `gold`, `goldLight` from `theme.js`
and let the compiler find any stragglers.

---

## Stage 4 — none

There is no layout work. Every screen keeps its current structure, spacing and
type scale. Stages 1–3 are the entire migration.

The logo does **not** appear in the `HomeScreen` header — the app is identified by
its app icon and splash, not by an in-app lockup. Brand artwork appears only on the
icon, the splash screen, and marketing surfaces.

---

## Design Tokens (full reference)

**Color**
```
Electric Blue    #5038FF   primary, buttons, links, active states
Blue Dark        #2E1BC7   gradient end
Blue Wash        #EAE6FF   tinted surfaces, pay pill, badge tiles
Canvas Cream     #F7F4EC   app background
Surface          #FFFFFF   cards, sheets, chat canvas
Ink              #363636   primary text, dark surfaces
Ink Secondary    #6B6482   body copy, meta
Ink Muted        #9A93AD   labels, placeholders, disabled
Border           #E4DFD3
Divider          #EFEBE1
Action Red       #EA4637   urgent, destructive
Red Light        #FFE7E3
Success          #15803D
Success Light    #E7F8EE
Warning          #E0A44A   lifecycle "pending" only
Warning Light    #FDF0DA
Warning Deep     #8A5A12
```

**Radii** — `sm 10` chips/badges · `md 14` inputs/buttons · `lg 20` cards/panels ·
`xl 28` sheets/modals · `pill 999`. Three sizes plus pill; do not introduce others.

**Type** (unchanged from the shipped app — listed so you can verify nothing drifts)
```
Screen title        20px / 800 / -0.3    ("You")
Large screen title  24px / 700 / -0.4    ("My Jobs", "Messages")
Post-a-gig title    26px / 700 / -0.4 / lh 33
Job detail title    24px / 700 / -0.4 / lh 31
Stat value          20px / 700
Card title          16px / 700 / -0.2
Row title           15px / 600
Body                15px / 400 / lh 23
Section label       13px / 600  sentence case, textMuted  (NOT uppercase)
Meta / sub          12px / 500  textMuted
Timestamp           11px / 400  textMuted
```

**Shadows** — neutral black only, never brand-tinted.
`card: 0 2px 10px rgba(0,0,0,.05)` · `sm: 0 1px 4px rgba(0,0,0,.04)` ·
`md: 0 4px 12px rgba(0,0,0,.08)`

**Contrast to re-verify after the swap**
```
Ink #363636 on Cream #F7F4EC      10.5:1   AAA
Cream on Electric Blue #5038FF     6.9:1   AA all sizes
Ink Secondary on Cream             6.1:1   AA
White on Action Red #EA4637        3.9:1   large text / icons only
washDeep on wash                   ~7:1    AA
```

---

## Iconography — no migration required

The app already uses **Ionicons** through `@expo/vector-icons`. The mockups were
switched to the same set (ionicons 7.4.0), so icon names in the design match your
imports exactly. Confirmed names by surface:

- Tab bar — `search` · `briefcase` · `megaphone` · `chatbubble` · `person-circle`
  (filled = active, `-outline` = inactive)
- Browse — `flash` urgent · `flame` streak · `options` filter · `sparkles` For You /
  FAB · `grid` All · `book` Tutoring · `bicycle` Delivery · `bar-chart` Insights ·
  `map` Map · `bookmark` / `bookmark-outline`
- Job detail — `cash` · `location` · `repeat` · `lock-closed-outline` ·
  `lock-closed` (taken slot) · `checkmark-circle` (verified) · `flag-outline` ·
  `warning` · `alert-circle`
- Chat — `chevron-back` · `chevron-forward` · `ellipsis-horizontal` ·
  `image-outline` · `arrow-up`
- Post a gig — `camera-outline` · `create` · category icons from `CATEGORIES`
- Profile — `notifications-outline` · `settings-outline` · `flag` · `pencil` ·
  `card-outline` · `receipt-outline` · `bookmark-outline` · `heart-outline` ·
  `eye-outline` · `shield-checkmark` · `school` · `trophy-outline`

The custom SVG icon set from the brand board is **not** used in the product. Only
the mark, wordmark, lockup, app icon and pattern are brand assets.

---

## Screens — expected result after Stages 1–3

All six are unchanged in structure; only the palette moves. Use these to diff.

1. **Browse** (`HomeScreen.js`) — cream canvas, "Hey Chris" greeting, streak pill,
   search + dark `options` button, chip row, "N gigs available" with Insights/Map,
   job cards, blue FAB, floating tab bar. No logo in the header.
2. **Job detail** (`JobDetailScreen.js`) — urgent banner (`urgentLight`), category +
   save row, pay pill (blue wash in Stage 3) + location pill, About this gig + tags,
   PosterTrustCard, horizontal SlotPicker, counter-offer, fee breakdown, pinned
   white footer with full-width blue "Book this gig".
3. **My Jobs** (`EarnScreen.js`) — Active / Awaiting / Completed segments with
   counts, nudge band, booking cards. No earnings hero — money lives on Profile.
4. **Post a gig** (`PostJobScreen.js`) — single scrolling form, real field order,
   category chips, pay + Flat//hr control, $15 floor.
5. **Messages** (`ChatScreen.js` + `MessageSheet.js`) — **white** canvas
   (`colors.surface`), cream incoming bubbles, blue outgoing, person row above a
   tappable job card, `image-outline` attach, blue `arrow-up` send.
6. **Profile** (`ProfileScreen.js`) — compact "You" bar, Progress/Profile segments,
   stats row, MoneyGoalCard, EarningsTiles, BadgeGrid, grouped rows.

---

## Verification checklist

- [ ] Stage 1 committed alone; app builds; no import errors
- [ ] Screenshot all six screens **before** Stage 1 — that's your diff baseline
- [ ] No `#3F25FE`, `#F21A06`, `#FFBC45`, `#F7F3EC`, `#181231` left anywhere
      (`rg -n "3F25FE|F21A06|FFBC45|F7F3EC|181231"`)
- [ ] `shared/theme.js` and `web/app/globals.css` changed in the same commit
- [ ] Chat still renders on white, not cream
- [ ] Pending / Confirmed / Completed / Declined lifecycle pills still legible
- [ ] Contrast spot-check: cream on blue, white on red, muted on cream
- [ ] Tab bar active/inactive still distinguishable at a glance
- [ ] TestFlight build after Stage 2, before starting Stage 3

## Files in this bundle

- `theme.js` — drop-in replacement for `shared/theme.js`
- `globals-css-map.md` — hex find/replace table for `web/app/globals.css`
- `Hustlr App Mockups v2.dc.html` + `support.js` — visual reference (open in a browser)
- `brand/` — logo, wordmark, lockup, app icon, pattern (SVG, all colorways)
