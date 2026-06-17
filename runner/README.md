# runner/ — headless scenario runner + validation gate

- `run.js` — runs the efficient frontier headless (100 LHS × 100 stochastic, seeded/reproducible)
  and writes `runner/results/frontier_<mode>.json`.
  - `node runner/run.js zero`    — all growth 0% (reproduces the legacy static frontier).
  - `node runner/run.js default` — default growth schedule (PN/HI grow, MS flat).
- `defaults.js` — Configuration-tab defaults mirroring the viewer (so headless == in-browser).
- `validate.js` — the MODEL_CANON §1 regression gate. `node runner/validate.js` exits non-zero
  if any §1 target fails to reproduce to full precision.

`runner/results/` is git-ignored (regenerable).
