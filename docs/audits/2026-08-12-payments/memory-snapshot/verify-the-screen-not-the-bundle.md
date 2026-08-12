---
name: verify-the-screen-not-the-bundle
description: A green bundle + green jest suite cannot catch an undefined JSX identifier in this RN app — open the screen in the simulator before shipping UI
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 21988eb9-afe9-4353-94d6-d78a7aa1b9f2
  modified: 2026-08-12T17:31:45.012Z
---

On 2026-08-12 I shipped a SupportScreen that crashed on open: I added two `<Modal>`
components and never imported `Modal`. It passed `npx expo export` (Metro does not
resolve free identifiers), passed 511 jest tests (the suite is pure logic and never
mounts screens), and passed admin `tsc` (different project). Chris found it by
tapping the screen, on a build I had already pushed over the air twice.

**Why:** I verified migrations against production, guards under a real `authenticated`
role, and money math in rolled-back transactions — everything except the screen I had
just rewritten. Depth of verification elsewhere created false confidence.

**How to apply:** after editing any screen in `src/screens/`, open it in the iOS
simulator (`mcp__Claude_Code_iOS_Simulator__control`, attach → tap through) before
declaring done. `__tests__/importIntegrity.test.js` now catches the specific
undefined-JSX-identifier class, but it does not catch layout, navigation, or runtime
state bugs — the same session also shipped a menu rendered under the Dynamic Island
and a thread switcher placed inside a view that force-scrolls past it. Both were only
visible on screen.

Related: [[audit-agents-read-only]], [[ship-when-green]].
