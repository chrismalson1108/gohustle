---
name: simulator-emoji-tofu
description: "Emoji render as \"?\" boxes in the iOS 26.3 Simulator because the runtime is missing AppleColorEmoji.ttc — an environment gap, never an app bug"
metadata: 
  node_type: memory
  type: reference
  originSessionId: efeef18b-aba0-451d-a5fd-91308a7ce196
  modified: 2026-07-30T18:39:25.195Z
---

Emoji show as box-with-question-mark tofu in the **iOS 26.3 Simulator runtime on this Mac**. It is an environment gap, not an app bug, and not a data/encoding bug.

The font iOS registers as the "Apple Color Emoji" family — `Core/AppleColorEmoji.ttc` — is **absent** from the runtime. Only `CoreAddition/AppleColorEmoji-160px.ttc` ships there, and it is not what CoreText falls back to, so every codepoint with `Emoji_Presentation=Yes` (or any char followed by VS16) falls through to `LastResort.otf`.

Check it directly:

```
find /Library/Developer/CoreSimulator -path "*iOS 26.3*RuntimeRoot*" -iname "*Emoji*"
```

Confirmed by reproducing the same tofu **in Mobile Safari on the same runtime with zero app code involved**. It hits ancient codepoints (⚪ U+26AA) exactly as hard as new ones, which rules out "the emoji is too new". Text-presentation symbols (★ U+2605, ✓ U+2713, bare ⚠ U+26A0) render fine — only emoji-presentation ones fail.

**Consequences for diagnosis:** do NOT "fix" this by changing string encoding, and do not strip emoji from user-generated content (chat messages) to make it look right — it renders correctly on real devices and on web. Verify by opening the same data on gohustlr.com in desktop Chrome, which has the real font.

Changing app **chrome** away from emoji can still be right, but for consistency reasons rather than this one: see [[design-direction-2026-07]]. `shared/constants.js` already states the policy — `ion` (Ionicons) renders reliably everywhere, `icon` (emoji) is legacy. `WORK_STATUSES` was the last shared table with no `ion` field.
