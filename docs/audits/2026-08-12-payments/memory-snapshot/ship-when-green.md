---
name: ship-when-green
description: "Chris wants shipping when the checks pass — don't add review gates after he's said to push"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: efeef18b-aba0-451d-a5fd-91308a7ce196
  modified: 2026-07-30T18:39:37.695Z
---

When Chris says "if everything looks good, push it live / to TestFlight", that is the go-ahead. Run the gate (jest, web typecheck, web build, device check) and ship. Do not insert an extra review layer in front of it.

**Why:** in the 2026-07-30 session he'd already said to push, and I launched an adversarial pre-ship review workflow over the release commit anyway. He rejected the tool call and repeated the instruction verbatim. He is moving fast toward open beta and treats a green gate plus my own device testing as sufficient.

**How to apply:** verification belongs *before* asking, or as part of building — not as a gate bolted on after approval. If something genuinely warrants deeper review, say so in one sentence and let him decide, rather than spending a workflow on it unasked. Reserve heavy multi-agent review for when he asks for an audit, or for work not yet approved to ship.

Related: he does want honest reporting of what was and wasn't verified — flagging "I tested both steps but never executed the final destructive delete call" was welcome. Speed over ceremony, not speed over truth. See [[prelaunch-audit-2026-07]].
