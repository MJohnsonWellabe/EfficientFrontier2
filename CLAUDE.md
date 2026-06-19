# CLAUDE.md — Project memory for Claude Code

You are working on a **capital deployment / efficient frontier** model for Wellabe: it finds the mix of new-business sales across **Medicare Supplement (MS)**, **Preneed (PN)**, and **Hospital Indemnity (HI)** that maximizes portfolio IRR (value of new business) subject to capital/RBC constraints over **2026–2030**.

## Read these first, every session
1. **`MODEL_CANON.md`** — validated targets, directed mechanics, and intentional inconsistencies. This is ground truth. Do not change canonical values to make code "cleaner."
2. **`BUILD_STANDARDS.md`** — the definition of done. Every change passes it.

## Standing rules
- **The validation gate is absolute.** Any edit to an engine module must re-produce every target in `MODEL_CANON.md §1` to full precision before it's complete. The executable gate is `node runner/validate.js`. If you can't verify it, say so — do not claim success.
- **Sales growth stays out of the baseline.** The frontier is a **multi-year** optimization (`MODEL_CANON.md §8`): per product it samples a 2026 level (`S.bounds`) plus a growth rate per year 2027–2030 from `S.growthRange[c]=[lo,hi]`, builds per-year sales paths in `frontier.js → runSweep` (2031–2035 held flat at 2030), and maximizes the **2026–2030 program PVDE** (`buildScen` `recNB` with `iyMax:2030`; `portNPV`/`portIRR`). Growth is applied **only** to sampled scenario draws. The baseline path (`frontier.js → computeBaseline`, which anchors §1) must **never** read `S.growthRange`. If any §1 number moves when growth changes, growth has leaked into the baseline — that's a bug. Constraints C3–C8 are scoped to the program; **C1 (min RBC 2026–2030 ≥ 4.0) is the binding constraint** — sales only fall on the frontier when RBC requires it (emergent). `vnb.js` has an additive `iyMax` filter (opt-in; default callers byte-identical, so the §1 gate is untouched).
- **Replicate the intentional inconsistencies** in `MODEL_CANON.md §3`. They match the source workbook on purpose.
- **The HTML app is a thin viewer.** Heavy compute belongs in `runner/`, headless. The viewer computes in-browser using the **same** `src/frontier.js` module the runner uses — one source of compute truth. Don't fork the math.
- **Data lives in `data/`, not embedded in code.** No gzip+base64 blobs in the HTML.
- **Default config carries the surplus note ON ($100M).** It flows through TAC, so the viewer's displayed baseline RBC is note-adjusted; `MODEL_CANON §1` RBC stays the no-note engine anchor verified by `runner/validate.js`. Config defaults (bounds/constraints/note) live in three mirrored places — `viewer/index.html` inputs, `viewer/app.js` `S` init, and `runner/defaults.js` — keep them in sync. See `MODEL_CANON §5`.
- **Push everything to `main`, always.** Matt's standing instruction (2026-06-14): commit and push all work directly to `main` so his `git pull origin main` / GitHub-download workflow always has the latest. No feature-branch/PR dance unless he asks.

## Architecture (current state — decomposition complete)
- `src/` — the engine, decomposed into UMD modules (browser `window.EFENG` + Node `module.exports`):
  `vnb.js` (monthly income statements per cohort → IRR/NPV), `ev-recalc.js` (sales/claims/lapse
  scalars + two-regime in-force roll-forward), `rbc-surplus.js` (NAIC covariance charges, required
  capital, scenario TAC, surplus note). `engine.js` assembles the three for Node. `frontier.js` is
  the shared scenario/efficient-frontier compute (incl. the sales-growth `mkScalars`), used by both
  the viewer and the runner. The whole frontier sweep is the **one shared `frontier.js → runSweep`**
  (async; optional yield/progress callbacks) — called by the viewer worker, the viewer main-thread
  fallback, and the headless runner, so all three give identical results for a given seed.
- `runner/` — headless scenario runner: `run.js` (100 LHS × 100 stochastic via `runSweep` → `runner/results/*.json`),
  `defaults.js` (config defaults mirroring the viewer), `validate.js` (the §1 gate).
- `viewer/` — the six-tab HTML app: `index.html` loads the `src/` modules + Chart.js and fetches
  `data/`; `app.js` is the rendering/UI layer (DOM bindings inside `DOMContentLoaded` via `bindAll`).
  The heavy sweep runs in a **Web Worker** (`viewer/worker.js`, which `importScripts` the `src/`
  modules and calls `runSweep`) so it keeps computing in a backgrounded/unfocused tab and never
  freezes the UI; if `Worker` is unavailable it falls back to `runSweep` on the main thread.
- `data/` — workbook-derived inputs: `InputEV.csv`, `InputTS.csv`, `InputSurplus.csv`, `params.json`.
- `legacy/EfficientFrontier-29.html` — the proven single-file reference. **Do not edit or delete it.**

## Migration note (done)
The original single self-contained HTML (engines inlined, workbook data embedded) has been
decomposed into the structure above with **no computed result changed** — engine verified
bit-for-bit against the legacy engine (412 checks, 0 diffs) and the zero-growth frontier verified
identical to the legacy frontier (1700 checks, 0 diffs). Re-verify with `node runner/validate.js`
plus the zero-growth frontier diff after any engine/frontier edit.

## Local viewing (how Matt runs the viewer — no Node, no Python on his machine)
The viewer must be served over http (it `fetch`es `data/`; `file://` is blocked). Matt's Windows
box has neither Node nor Python, so the standing local-deploy method is the **built-in PowerShell
`HttpListener`** server, run from the **repo root**, then open `http://localhost:8000/viewer/index.html`:

```bat
powershell -NoProfile -Command "$root=(Get-Location).Path; $l=[System.Net.HttpListener]::new(); $l.Prefixes.Add('http://localhost:8000/'); $l.Start(); Write-Host ('Serving -> http://localhost:8000/viewer/index.html  (Ctrl+C / close window to stop)'); while($l.IsListening){ $c=$l.GetContext(); $p=$c.Request.Url.LocalPath.TrimStart('/'); if([string]::IsNullOrEmpty($p)){$p='index.html'}; $f=Join-Path $root $p; if(Test-Path $f -PathType Leaf){ $b=[System.IO.File]::ReadAllBytes($f); $ext=[System.IO.Path]::GetExtension($f).ToLower(); $m=@{'.html'='text/html';'.js'='text/javascript';'.json'='application/json';'.csv'='text/csv';'.css'='text/css'}; $ct=$m[$ext]; if(-not $ct){$ct='application/octet-stream'}; $c.Response.ContentType=$ct; $c.Response.OutputStream.Write($b,0,$b.Length) } else { $c.Response.StatusCode=404 }; $c.Response.Close() }"
```

Note: a web server started inside a cloud/remote session is **not reachable** from Matt's browser —
local viewing always runs on his own machine after `git pull origin main`.

**Cache-busting (GitHub Pages):** `viewer/index.html` loads the engine + `app.js` with a `?v=<token>`
query, and `app.js` spawns the worker as `worker.js?v=<token>` (the worker forwards that token to its
`importScripts`). **Bump the token (all of them, same value) whenever you change viewer/engine JS**, so
Pages clients don't keep running stale cached code. The viewer's run-status line shows whether a run used
the **Web Worker** or fell back to the **main thread** (with the failure reason) — use it to confirm the
off-thread path is active.

## Mobile resilience (Wake Lock + checkpoint/resume)
A phone freezes/discards a backgrounded tab (worker included), so a long run can't keep counting while
away. Instead runs are made **resilient**: (1) `viewer/app.js → runFrontier` requests a **Screen Wake
Lock** for the duration of a foreground run (re-acquired on `visibilitychange` since the OS drops it when
hidden), so the screen sleeping won't pause it; and (2) every completed scenario is **persisted to
IndexedDB** (DB `ef_checkpoints`) keyed by a `runSignature()` of the run config — on the next Run with the
**same inputs**, the saved scenarios seed `runSweep`'s `startResults` so it resumes instead of restarting,
and the checkpoint is cleared on completion. Any input change → new signature → fresh run. `runSweep`'s
`startResults`/`onPartial` opts are **optional and must not alter the default (gate-verified) path** — a
normal run is byte-identical (verified: NEW==OLD code on the zero-growth frontier; resume reproduces the
identical full set). Note: a randomized seed only resumes within the same session (the seed input reverts
to its default on a full reload, so a reloaded random-seed run starts fresh — by design).

## Access gate (client-side only)
The Pages site is password-gated: the **root `index.html`** is a landing page that checks a password
and, on success, sets `sessionStorage.ef_auth` and forwards to `viewer/index.html`; an early guard
script in `viewer/index.html`'s `<head>` bounces back to the landing page if that token is absent.
This is **obfuscation, not security** — it's a static site, so the page source and `data/*.csv` are
reachable by a determined visitor; it only deters casual access. The stored value is the **SHA-256
hash** of the password (plaintext is never committed). To change the password, recompute its SHA-256
and update the `EXPECTED`/guard hash in **both** `index.html` and `viewer/index.html`. Real protection
would require private Pages (Enterprise) or an authenticated host.

## Reinsurance (MS quota share — toggle, ON by default at 10%)
A Medicare-Supplement-only quota-share treaty, modeled like the surplus note: a toggle plus config
mirrored in three places (`viewer/index.html` **Config-tab Reinsurance section** — under the surplus
note — `viewer/app.js` `S.reinsurance` init, `runner/defaults.js`), passed to the worker in
`runFrontier`'s `cfg`, and re-read by `readReinsurance()`. Engine lives in **`src/reinsurance.js`**
(`buildRetainedEV`, `retainedRatios`, `scaleMSCharges`, `cedingCommissions`, `lookupCco`,
`reinsCedeRate`). Default is **ON at 10% cede every issue year** (1-yr lag, 10-5-5 upfront, sliding-scale
ongoing). When **off**, nothing runs and every result is byte-identical to the no-treaty model.
`runner/validate.js` (§1) is **treaty-independent** — it builds VNB/`surplusCalc` directly from `data/`,
not through `computeBaseline`, so the ON-by-default flip doesn't move the §1 anchors.
- **Validation:** there's no reinsurance Excel tie in this repo and no second workbook to merge — the
  reins-ON numbers are tied out **transitively to Excel via the sibling BlockbusterDeals model**
  (`reinsurance.js` was ported from `BlockbusterDeals/src/engine.py`, which ties to its own workbook).
  The gate is **`node runner/reins-tieout.js`** (see `MODEL_CANON §10`): predeal RBC ties exactly all
  years, net RBC @10% ties over the 2026–2030 planning horizon, commissions exact; the post-2030 run-off
  tail diverges for documented EV-book reasons. Re-run after any cession-logic edit.
- **Compute once, scale off the baseline.** Reinsurance is applied **only** in
  `frontier.js → computeBaseline`: a proportional "retained EV" (every MS row × `(1−cede)` with a
  1-year cession lag), MS RBC charges scaled by retained share (lives → premium-related TSCs, claims
  → TSC2; TSC4a/4b untouched), ceding commissions (upfront schedule + sliding-scale by loss ratio),
  and a per-year after-tax surplus flow (`applyReinsToSurplus`, sibling of `applyNoteToSurplus`). The
  frontier scenarios (`buildScen`) **inherit** the treaty by recalc-ing off the retained EV
  (`S.evRetained`) and scaling off the reinsured `S.baseline.surplusCalc` — the cession is **never**
  re-applied per scenario, and the baseline treaty cash flows are carried via `S.baselineReins`.
- **MS only.** PN and HI cohorts and all non-MS logic are never ceded. EV rows are keyed by product
  CODE (`'MS'`); `surplusCalc` charges by full NAME (`'Medicare Supplement'`) — `reinsurance.js`
  keeps both (`MS_CODE` / `MS_NAME`).
- The lag's step-changes fall in `recalcEV`'s build (proportional/additive) regime, so scaling MS
  lives in the retained EV does **not** distort the persistency roll-forward (verified).

## Open item
Per-product stochastic σ for claims and lapse are currently assumed. They are being re-derived from seriatim aggregate A/E ratios (process vs. systematic risk). See `MODEL_CANON.md §6`.
