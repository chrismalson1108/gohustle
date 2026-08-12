# Memory Index

- [Design direction 2026-07](design-direction-2026-07.md) — boss directive: de-AI the aesthetics, Uber/IG minimal style; Browse done, other screens pending; token/radius/color rules
- [Pre-open-beta audit remediation](prelaunch-audit-2026-07.md) — 54 findings + 7 regressions fixed & deployed live 2026-07-15 (commit 3ef23d1); remaining launch gates
- [Payments architecture](payments-architecture.md) — Stripe escrow model, TaskRabbit-style goal, Phase 2 embedded-onboarding dependency, infra/keys state
- [Worker classification & roadmap](worker-classification-and-roadmap.md) — earners are 1099 contractors (not employees), cash/tax strategy, Tax Center, path-to-trial blockers (see ROADMAP.md)
- [bad-trading repo](bad-trading-repo.md) — Robinhood agentic trading agent (rhagent), layout, sacred two-switch safety model, how to run, GitHub push via keychain
- [Trading model honest result](trading-model-honest-result.md) — the model does NOT beat indexing by design; degrades to a diversified regime-protected baseline; honest 8y backtest numbers
- [Simulator emoji tofu](simulator-emoji-tofu.md) — "?" boxes in the iOS 26.3 sim are a missing runtime font, not an app bug; never re-encode strings or strip user emoji to "fix" it
- [Ship when green](ship-when-green.md) — once Chris says push, run the gate and ship; don't bolt a review layer on after approval
- [Web design system](web-design-system.md) — post-parity tokens; retuned radius scale, width prop, container-query rule, weight cap
- [Categories taxonomy 2026-08](categories-taxonomy-2026-08.md) — DB-backed category/skill taxonomy, migration LIVE + builds shipped; no Docker on this machine
- [Brand v3 rebrand 2026-08](brand-v3-rebrand-2026-08.md) — v3.0 shipped TestFlight v1.4.2 b25→b26; token split, handoff traps, the sheet-collapse bug
- [Audit agents read-only](audit-agents-read-only.md) — adversarial subagents must not write to prod; round-1 writes disabled a security control for hours
- [Payments audit 2026-08](payments-audit-2026-08.md) — 72 findings / 6 root causes from the read-only adversarial money audit; plan written, NOTHING fixed yet
- [Verify the screen, not the bundle](verify-the-screen-not-the-bundle.md) — a green bundle + green jest can't catch an undefined JSX identifier; open the screen in the simulator before shipping UI
