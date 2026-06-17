# src/ — engine + shared compute

Decomposed from `legacy/EfficientFrontier-29.html` with no computed result changed.

- `vnb.js` — VNB engine: monthly income statements per cohort → IRR / NPV.
- `ev-recalc.js` — EV recalc under sales/claims/lapse scalars (two-regime in-force roll-forward).
- `rbc-surplus.js` — NAIC covariance charges, required capital, scenario TAC, surplus note.
- `engine.js` — Node assembler: combines the three into one `EFENG` namespace.
- `frontier.js` — shared scenario / efficient-frontier compute (incl. the scenario-draw sales
  growth in `mkScalars`). Used by both `viewer/` and `runner/` so the math has one source of truth.

Each engine module is UMD: in the browser it populates `window.EFENG`; in Node it exports via
`module.exports`. `frontier.js` exposes `EFFRONTIER.create(S, EFENG)`.
