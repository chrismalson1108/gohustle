---
name: brand-v3-rebrand-2026-08
description: "Brand v3.0 shipped to TestFlight as v1.4.2 b25, then b26 — token split, what the handoff got wrong about this repo, and the audit findings"
metadata: 
  node_type: memory
  type: project
  originSessionId: 21988eb9-afe9-4353-94d6-d78a7aa1b9f2
  modified: 2026-08-06T19:31:30.368Z
---

Brand v3.0 shipped to TestFlight on 2026-08-05 as **v1.4.2 build 25**, alongside the
categories taxonomy (see [[categories-taxonomy-2026-08]]); **build 26** followed on
2026-08-06 with the category-sheet fix. Architecture is in CLAUDE.md; this records the
decisions and traps.

**The bug a 56-agent audit missed and a human found in one gesture.** The CategoryPicker
sheet used `maxHeight` and bottom anchoring with no keyboard avoidance, so typing a
category that did not exist collapsed the sheet to nothing — the empty state was short,
so the sheet shrank behind the keyboard. Chris reported it as "the entire page
disappears." Fixed with a fixed `height: '85%'`, `KeyboardAvoidingView`, and
`flexGrow: 1` on the list body. The lesson generalizes: a bottom sheet sized by its
content will collapse on its emptiest state, which is exactly the state a search field
produces. Audits that read code do not feel this; typing in the simulator does.

**Chris's commit plan** (his, not the handoff's): 1 tokens · 2 marketing page ·
3 brand assets · 4a money→wash / 4b lifecycle→warning* / 4c gamification→primary /
4d rating stars→new `rating` token then delete the aliases · 5 email+edge.

**Hustle Orange retired.** One amber did four jobs, which is what made it hard to
unpick. Now: `warning*` lifecycle "awaiting action" · `wash/washDeep` money + badge
surfaces · `rating` stars (amber, but a score is not a warning) · `primary`
gamification. All five accent/gold aliases are deleted on both platforms.

**THE HANDOFF WAS WRONG ABOUT THIS REPO — do not follow its Stage 2 literally.**
`shared/assets/brand/wordmark-*.png` is the horizontal LOCKUP (mark + HUSTLR), not a
wordmark. `src/components/Logo.js` hardcodes its aspect (11818/2401) and AuthScreen is
the ONLY place a logo renders in the whole mobile app. Dropping the handoff's
text-only wordmark under that filename would delete the H-mark from the app. Also the
v3 GEOMETRY was already in the repo from 4c1aaec — only the blue was stale, so
commit 3 was a recolor, not new artwork.

**Web renders zero brand PNGs in its UI.** Every logo is inline SVG in
`web/components/brand/glyphs.tsx` using currentColor, so the token swap alone
recoloured them. The PNGs reach web only as favicon / apple-touch / OG card.

**Audit findings worth remembering** (8 dimensions, adversarial verify, 48 claims):
- `sharp(file).trim().metadata()` returns the INPUT dims. Using it to measure art
  scaled 3 icons to full-bleed; Android masks adaptive icons to the central ~66%, so
  they would have been clipped on every device. Compare ART boxes, never canvas.
- `jobs.category_slug` was writable: a trigger bound `UPDATE OF category` does not
  fire for a slug-only update, and guard_jobs_write never pinned it. Fixed in
  20260805030000 by binding both columns so the slug is always derived.
- A test that compares two string literals cannot fail. Read names off disk instead.
- Tailwind v4 emits NO utility for an undefined token — deleting a CSS var silently
  breaks every class using it (globals.css documents this for --color-divider).

**Still open:** the PostJob header. `headerLargeTitle` pins instead of collapsing and
clips the form, because the ScrollView sits inside a KeyboardAvoidingView — fixing it
needs a screen restructure. Options are compact-bar title (26px→17px on ~20 screens)
or just tightening ScreenHeader padding. Chris has not chosen.

**Never re-add a floating back button.** App.js:86-97 documents that it loses taps to
the iOS screen-edge pop gesture, and it reproduces with a finger but NOT with scripted
taps — a simulator pass cannot catch it.

Related: [[categories-taxonomy-2026-08]], [[design-direction-2026-07]], [[web-design-system]], [[ship-when-green]].
