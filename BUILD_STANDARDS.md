# BUILD STANDARDS — Definition of Done

Every change to this project passes this checklist before it's considered finished. Most of these exist because the bug bit you at least once already. The point is to never re-diagnose the same class of failure.

## Validation gate (non-negotiable)
- [ ] Any change touching an engine (VNB, EV recalc, RBC/surplus) re-produces **every** target in `MODEL_CANON.md §1` to full precision. If it doesn't, the change is wrong — stop and reconcile before proceeding.

## JavaScript / browser viewer
- [ ] All DOM event bindings happen **inside** `DOMContentLoaded`. Define handler functions (drawer open/close, panel switches, button handlers) **before** `bindAll()`, and put every `addEventListener` **inside** `bindAll()`. *(This is the parse-time binding bug that broke the mobile menu in both the multi-agent workspace and Blockbuster Deals.)*
- [ ] No unescaped apostrophes in inlined JS strings. Prefer template literals or move logic to external `.js` files in `src/`.
- [ ] Mobile nav manually tested: hamburger opens, drawer closes, panel switching works.
- [ ] Every chart's axis orientation is verified against intent. *(Blockbuster lesson: reward on X, cost on Y. For the frontier, confirm which axis is return vs. risk/capital every time — don't assume.)*

## Data / file size
- [ ] Data is **separated from code** above ~200KB. Do **not** embed gzip+base64 inputs if it pushes the file past a few hundred KB. Workbook-derived inputs live in `data/`, loaded at runtime. *(Blockbuster hit ~2MB and had to be stripped to 280KB after the fact — don't repeat that.)*

## Compute
- [ ] Heavy runs (LHS × stochastic grids) run **headless** in `runner/`, not in the browser. The browser app consumes results; it does not generate them at scale.
- [ ] If browser-side Pyodide is genuinely needed, use the **CDN-hosted `coi-serviceworker`**, never an inline blob-URL service worker. (Better: avoid in-browser WASM entirely for this project.)

## Outputs / handoff
- [ ] Files intended for delivery are actually written to their destination and the path is verified (`ls`), not assumed. *(The doc-build failure where markdown was created in the workspace but never copied out.)*
- [ ] `MODEL_CANON.md` updated if any validated value, mechanic, or intentional inconsistency changed — with a one-line note on *why*.
