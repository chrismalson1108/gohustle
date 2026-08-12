---
name: bad-trading-repo
description: "The chrismalson1108/bad-trading repo — Robinhood agentic trading agent, its layout, safety model, and how to run it"
metadata: 
  node_type: memory
  type: project
  originSessionId: 425122ce-8d2a-47e5-a66b-ca8955a59949
---

`chrismalson1108/bad-trading` (local: `/Users/chrismalson/bad-trading`, additional working dir) holds a **Robinhood Agentic Trading** agent. The Python project lives in the `robinhood-agent/` subdirectory (package `rhagent`). Pushes to GitHub work via the macOS keychain credential helper (`git-credential-osxkeychain`); no `gh` CLI is installed.

Setup: `cd robinhood-agent && /opt/homebrew/bin/python3.14 -m venv .venv && .venv/bin/pip install -e ".[dev]"` (Python 3.14 works; numpy 2.4 / pandas 3.0 / sklearn 1.9). Run `.venv/bin/python -m pytest -q` (37 tests) and `.venv/bin/rhagent backtest|retrain|rebalance`. The full 8-year backtest takes ~22 min (refits Ridge + walk-forward CV each weekly rebalance). `config/config.yaml` is gitignored and can go stale — re-copy from `config/config.example.yaml` after changing defaults.

**Safety is sacred and must never be weakened without explicit user request:** a two-switch gate (`Safety.can_trade` ⇔ `not DRY_RUN and LIVE_TRADING`, both off by default) plus a fail-safe MCP tool allowlist (dry-run = read-only tools only; empty `trade_tools` = can never trade). Robinhood Agentic Trading is real and live (launched 2026-05-27; MCP endpoint `https://agent.robinhood.com/mcp/trading`, equities-only beta, separate funded sub-account). I must never place trades or move money myself.

Design philosophy (see `docs/MODEL.md`): "indexing is the prior; the ML is a small, significance-gated tilt that must earn any deviation from a diversified, regime-aware baseline." See [[trading-model-honest-result]].

**Universe = individual companies (changed 2026-06-29, was a 10-ETF basket).** `config.universe` is now ~19 diversified large-cap STOCKS (AAPL/MSFT/GOOGL/NVDA/META/AMZN/HD/MCD/KO/PG/WMT/COST/JPM/V/UNH/JNJ/XOM/CVX/CAT — no bonds, no ETFs). SPY+IEF moved to a new `config.benchmarks` list = evaluation-only (SPY/60-40 yardsticks + regime vol-target proxy), NEVER traded. New invariant: the model only trades symbols in `universe` — feature rows are subset to it in both `backtest/engine.py` and `agent/runner.py:compute_plan`; `cfg.eval_symbols` (universe+benchmarks) is what gets price-fetched. Also fixed a stale-cache bug in `data/market_data.py` (it now refetches when the cache doesn't reach back to the requested start, instead of silently clipping a long backtest to the cached window).

**Two-brain architecture (don't conflate):** the trade-picker is a scikit-learn Ridge model (NO LLM — deterministic, runs offline). The agent layer (execution sanity-check + reflection playbook only) uses Claude `claude-opus-4-8`, set via `RHAGENT_MODEL` / config `model:`. **Pending preference:** the user wants to switch the AGENT LLM to `claude-fable-5` when Fable 5 is publicly available again (they'll signal it) — a one-line config change + add Fable's refusal/`fallbacks` handling to `agent/runner.py`. It improves the agent's reasoning/reflection, NOT trading returns (the sklearn model picks trades). **Why:** keeps alpha in a gated, validated quant model — letting an LLM pick trades is the overfitting trap the project avoids.

**Paper forward test:** persistent ledger at `paper_state/ledger.json` (account "agentic-paper-500", $500). **RESET 2026-06-29** to start a fresh forward test on the new company universe (the prior ETF track record was invalidated by the strategy change), so the go-live week-count restarts from 0 then. Ramps in via band+turnover-cap like live. Weekly scheduled task "weekly-paper-trade-report" (Fri 5pm local, runs on this Mac) marks it + runs `rhagent scorecard` + reports. Go-live criteria pre-registered in `docs/GO_LIVE.md` (≥26 weeks; match 60/40 with smaller drawdowns; manual sign-off).
