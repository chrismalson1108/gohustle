---
name: trading-model-honest-result
description: Honest finding — the bad-trading model does not beat indexing; on purpose it degrades to a diversified regime-protected baseline
metadata: 
  node_type: memory
  type: project
  originSessionId: 425122ce-8d2a-47e5-a66b-ca8955a59949
---

The anti-overfitting rebuild of the [[bad-trading-repo]] model (cross-sectional rank target, purged/embargoed walk-forward, Ridge default, shrink-to-baseline, regime exposure overlay, significance-gated promotion) produces an **honest, deliberately un-impressive** result, and that is the point.

**Universe changed 2026-06-29 to ~19 individual large-cap COMPANIES** (was a 10-ETF basket; see [[bad-trading-repo]]). 8-year net-of-cost backtest on the company universe (~2018–2026, equity bull): Strategy **16.4% CAGR / 13.8% vol / Sharpe 1.17 / −25.4% maxDD**; its own λ=0 baseline 15.0%; equal-weight B&H of the same names **29.6%** / −29.9%; SPY 17.7% / −33.7%; 60/40 11.2% / −21.2%. Excess vs SPY 95% CI **[−7.0%, +4.0%] (includes 0)**; vs 60/40 **[+1.0%, +9.6%] (>0)**. Automated verdict flipped to "statistically positive vs 60/40," BUT this is **driven by hindsight SELECTION BIAS** (universe = today's known mega-cap winners) + equities-beat-bonds — NOT proven skill. Still **no edge vs SPY**, and the machinery left ~13% CAGR on the table vs naive equal-weight B&H (16.4% vs 29.6%) while barely improving maxDD. (Old ETF universe for reference: ~6.2% CAGR / −13.5% maxDD, "NO DEFENSIBLE EDGE.")

**Why:** the company-universe verdict looks better than the ETF one but for the wrong reasons — the universe was hand-picked from known winners (selection bias), so "beats 60/40" mostly means "winning equities beat bonds in a bull." The honest benchmark is SPY, and there the CI includes 0 (no edge). The tilt over baseline (~1.4%) is within noise; verify with `rhagent retrain` IC t-stat (must be ≥~2). The system still largely runs as the diversified, regime-protected baseline and refuses to bet on noise.

**How to apply:** When the user asks about returns, be honest — this maximizes long-term gains *with best odds / least overfitting*, not by beating the index, and do NOT oversell the company-universe "positive vs 60/40" verdict (selection bias). The evidence-based maximiser is broad index accumulation (hold SPY/total-market), accepting bigger drawdowns; switching to single stocks raises idiosyncratic/concentration risk. Risk/return is tunable via `model.baseline` (equal_weight=growth default vs inverse_vol=preservation), the 15% vol target in `risk/regime.py`, and the risk limits. Don't tune these against the backtest (overfitting).
