---
name: design-direction-2026-07
description: "Boss directive (2026-07-21) — move away from AI-generated aesthetics toward Uber/Instagram-style minimal design; Browse screen done, rest of app pending"
metadata: 
  node_type: memory
  type: project
  originSessionId: 7c6a92ff-fc6c-4216-9986-622ce83c0f67
  modified: 2026-07-31T16:23:51.768Z
---

Chris's boss set a standing design directive on 2026-07-21: "Move away from AI-generated aesthetics. Implement sleek, modern design principles similar to Uber/Instagram (soft corners, minimal hard lines, clean spacing)."

**Why:** The app's original look had classic AI-template tells — diagonal gradient hero headers, brand-purple-tinted shadows, per-category rainbow accent bars, 5+ colored badges per card, mixed corner radii (6/8/12/14/16/20/22), heavy borders + shadows together, font-weight 900 with uppercase tracking.

**How to apply:** The design system established on the Browse screen (HomeScreen + JobCard, applied 2026-07-21) is the template for the rest of the app:
- Flat cream/ink headers, no LinearGradient heroes (GradientHeader still used by other tabs — migrate them the same way).
- Neutral black low-opacity shadows only (`shared/theme.js` shadows are already neutralized globally).
- Radius system: 14 for controls, 20 for cards, 999 only for true pills.
- One color accent per card max (red Urgent); category/recurrence/pay demoted to plain text; no chip borders.
- Max font-weight 700; no uppercase+letterSpacing labels.
- Brand purple #3F25FE reserved for: active filter state, saved bookmark, assistant FAB, links/CTAs — not backgrounds.
- Status bar: screens with light headers need `StatusBar style="dark"` gated on `useIsFocused` (see HomeScreen).
- Tab bar: floating white pill (`src/components/FloatingTabBar.js` + `src/lib/tabBarScroll.js`, added 2026-07-21 at Chris's request) — expands/collapses with scroll direction (hub screens attach `useTabBarScrollHandler()` to onScroll with `scrollEventThrottle`), slides off-screen on pushed detail screens. Hub scroll views need ~140 paddingBottom clearance since the bar overlays content; both its springs must stay `useNativeDriver: false` (it animates layout props — mixing drivers on one view crashes).

**Status: COMPLETE app-wide as of 2026-07-21** (commits 900ef4a, 94fb277) — all 24 screens + 28 components restyled, shipped as v1.1.0 build 10 to TestFlight. `GradientHeader.js` was DELETED; `ScreenHeader.js` replaces it. `radii` tokens added to shared/theme.js. Zero LinearGradient / fontWeight 800-900 / textTransform / borderWidth>1 remain in src/.

**Known follow-ups deliberately deferred:**
- `expo-linear-gradient` is now an unused dependency — removing it is a native change, so do it with a dev-client rebuild, not before a submission.
- Two content gutters coexist: 16 on Browse/My Jobs/Hire (baked into JobCard's marginHorizontal) vs 20 on Messages/Profile/Notifications/Expenses. Pick one.
- **Android has never been visually verified** — no Android SDK/emulator or `android/` dir on this machine. Only the JS bundle compiling + static review. Needs a real device pass.
- ~~The `web/` Next.js mirror still has the old card design and purple-tinted shadows.~~ **DONE 2026-07-31** (commit 86d0824) — the web app was migrated onto this same system and made fluid at any viewport width. See [[web-design-system]] for the web-specific rules.

Related: [[prelaunch-audit-2026-07]].
