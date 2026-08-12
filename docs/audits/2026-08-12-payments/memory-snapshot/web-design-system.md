---
name: web-design-system
description: "The web app's design system after the 2026-07-31 mobile-parity migration — tokens, the closed radius set, the width system, and the container-query rule"
metadata: 
  node_type: memory
  type: project
  originSessionId: 6700873a-1c87-4f2e-a96f-f7f07248ef9b
  modified: 2026-07-31T16:23:36.324Z
---

The `web/` Next.js app was migrated onto the mobile design system on 2026-07-31
(branch `design/web-parity-2026-07-31`, commit 86d0824), closing the gap noted in
[[design-direction-2026-07]]. `web/app/globals.css` is now the web mirror of
`shared/theme.js` — edit tokens there, not per-component.

**Rules that are easy to violate by accident:**
- **Max font weight is 700.** `font-black`/`font-extrabold` are gone from source
  *and* capped to 700 by `--font-weight-*` tokens, so writing one silently does
  nothing. Don't "fix" it by hardcoding a weight.
- **Radius is a closed set** and Tailwind's steps were RETUNED to land on it:
  `rounded-lg`=10 (chips) · `rounded-xl`=14 (controls/inputs/buttons) ·
  `rounded-2xl`=20 (cards) · `rounded-3xl`=28 (sheets) · `rounded-full` (pills).
  So `rounded-xl` is 14px here, not Tailwind's stock 12px.
- **`<main>` is a `@container`.** Content grids must use container queries
  (`@2xl:`, `@5xl:`) — a viewport `lg:grid-cols-3` is wrong by one sidebar width
  (at a 1024px viewport the content box is only 784px).
- **Width comes from a prop, never a `max-w-*` on a page.** `PageHeader` and
  `PageContainer` both take `width={"feed"|"content"|"form"}` (1760/1120/760) and
  **must be given the same value on a page**, or the title misaligns with content.
- **Active-state colors differ by control:** a segmented control's active pill is
  `bg-primary` (mobile `segBtnActive`); a Browse *category chip*'s active state is
  `bg-ink`. They are not interchangeable.
- There is deliberately **no `overflow-x: hidden` on the root** — it clips instead
  of scrolling and hides real bugs. Overflow is prevented at the source with
  `min-w-0` + `truncate` on every flex/grid text column.

**Why:** the old look was the pre-2026-07-21 AI-template design (gradient heroes,
category color bars, purple-tinted shadows), and the shell capped at `max-w-7xl`
so the app was a narrow island on a large monitor.

**How to apply:** `components/JobCard.tsx`, `components/PageHeader.tsx` and
`components/AppShell.tsx` are the reference implementations — match them.
The marketing page (`app/page.tsx`) is intentionally OUTSIDE this system: it keeps
Brand Guidelines v1.0 (its own cream/ink/red palette, Akshar display face) and
PhoneMock's device-bezel radii depict hardware, not UI. The Sora-vs-Akshar split
between app and logged-out surfaces is an open brand decision.

Related: [[design-direction-2026-07]], [[ship-when-green]].
