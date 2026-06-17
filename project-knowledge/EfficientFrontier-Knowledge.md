# Efficient Frontier — Capital Deployment Model · Project Knowledge Pack

> **What this file is.** A single, self-contained reference for the Wellabe Efficient Frontier /
> Capital Deployment model — design, mechanics, validated numbers, configuration, and the full engine
> source — assembled so you can ask research questions in a Claude Project **without running any code**.
> It mirrors the repo's ground-truth docs (`MODEL_CANON.md`, `CLAUDE.md`, `BUILD_STANDARDS.md`) and the
> in-app Methodology tab. If a number here ever disagrees with `MODEL_CANON.md` in the repo, the repo
> wins. Generated 2026-06-13.
>
> *To use: drag this `.md` into your Claude Project's knowledge, or point the Project's GitHub connector
> at the repo. The engine source is embedded verbatim at the end for code-level questions.*

---

## 1. What this is

A decision tool that finds the **capital-efficient mix of new business** across three product lines —
**Medicare Supplement (MS)**, **Preneed (PN)**, and **Hospital Indemnity (HI)** — that maximizes the
portfolio's value of new business (VNB / IRR) subject to capital and RBC constraints.

- It re-runs a full **embedded-value (EV) projection** under many candidate 2026 sales plans and locates
  the **non-dominated (efficient) set** in risk/return space.
- Projection horizon: monthly out to **2055** (360 months, Dec 2025 → Nov 2055), annualized; the
  **capital/RBC window** that drives constraints is **2026–2030**; sales are projected **2026–2035**.
- "Return" = 2026-issue PVDE (present value of distributable earnings). "Risk" = a downside measure
  (CTE-90 shortfall vs. the deterministic plan), not standard deviation.

## 2. Architecture map

- **`src/`** — the engine, decomposed into UMD modules (browser `window.EFENG` + Node `module.exports`):
  - `vnb.js` — VNB engine: monthly income statements per issue-year cohort → IRR / NPV.
  - `ev-recalc.js` — EV recalc under sales/claims/lapse scalars (two-regime in-force roll-forward).
  - `rbc-surplus.js` — NAIC covariance charges, required capital, scenario TAC, surplus note.
  - `engine.js` — Node assembler combining the three into one `EFENG` namespace.
  - `frontier.js` — shared scenario / efficient-frontier compute (incl. the sales-growth `mkScalars`),
    used by **both** the viewer and the headless runner (one source of compute truth).
- **`runner/`** — headless: `run.js` (100 LHS × 100 stochastic → results JSON), `defaults.js`
  (config defaults mirroring the viewer), `validate.js` (the MODEL_CANON §1 regression gate).
- **`viewer/`** — six-tab HTML app: `index.html` loads the `src/` modules + Chart.js and fetches
  `data/`; `app.js` is the rendering/UI layer. Tabs: Configuration · Efficient Frontier · Compare ·
  VNB by Product · RBC & Surplus · Constraint Evidence · Debug · Methodology.
- **`data/`** — workbook-derived inputs: `InputEV.csv`, `InputTS.csv`, `InputSurplus.csv`, `params.json`.
- **`legacy/EfficientFrontier-29.html`** — the proven single-file reference (frozen; never edited).

The HTML app is a **viewer**: it computes in-browser using the same `frontier.js` module the runner
uses. Heavy/batch runs go through the headless `runner/`.

## 3. Configuration defaults (current)

- **Sales bounds (LHS sampling range, $M):** MS **250–350**, PN **200–240**, HI **18–25**.
- **Hurdle rates:** MS **12%**, PN **10%**, HI **10%**.
- **Stochastic grid:** **100** LHS sales scenarios × **100** stochastic runs each (min 50).
- **Constraints:** C1 Min RBC ≥ **4.0×** · C2 ΔTAC/BOP ≥ **−12%** · C3 2026-issue IRR ≥ weighted
  hurdle (**on**) · C4 P(2026-issue IRR < **8%**) ≤ **10%** · C5 2026-issue DE > 0 by **yr 4 (2029)** ·
  C6 2026-issue cumulative DE > 0 by **yr 10 (2035)** · CumDE floor ≥ **−$180M** · Year-1 DE floor ≥
  **−$120M**.
- **Surplus note:** default **ON**, **$100M**, 10-year tenor, 9% interest, 3% upfront fee, 2026-06-30
  start.

These defaults live in three mirrored places kept in sync: `viewer/index.html` inputs, `viewer/app.js`
`S` init, and `runner/defaults.js`.

## 4. Validated targets — the regression gate (MODEL_CANON §1)

Standalone VNB basis (`buildVNB` with the default, full-data month width; PN acq/maint +1 shift active):

| Product | VNB IRR | VNB NPV |
|---|---|---|
| Medicare Supplement (MS) | `0.21938929` | `$633.23M` |
| Preneed (PN) | `0.10667571` | `$33.553M` |
| Hospital Indemnity (HI) | `0.17163078` | `$29.458M` |

- **MS recalc IRR under workbook scalars:** `0.17763524`.
- **Baseline RBC ratios, 2026–2030:** `5.36 / 4.67 / 3.80 / 3.76 / 4.33` (minimum `3.76` in **2029**).
- These reproduce to full precision via `node runner/validate.js`. Any engine edit must re-produce all of
  them before it's "done."
- **Note on RBC display:** §1 RBC is the **no-note engine anchor** (validate.js computes `surplusCalc`
  without the surplus note). Because the default config now has the surplus note **ON ($100M)** and the
  note flows through TAC, the *viewer's displayed* baseline RBC sits **above** these §1 figures. That's
  intended; §1 remains the canonical no-note anchor.
- *(Refresh note: PN VNB and MS recalc IRR were re-derived from the current workbook on 2026-06-13,
  replacing earlier stale transcriptions `0.14688215 / $6.574M` and `0.17833333`. MS/HI VNB and all RBC
  ratios were already exact.)*

## 5. Directed mechanics, intentional inconsistencies, corrections

**Directed mechanics (deliberate design):**
- **Persistency as a lapse-rate shock:** shocked retention = `1 − (1 − base retention) × lapse_scalar`,
  bounded `[0,1]`, applied from a policy's second year onward.
- **Preneed mortality = one coupled stochastic shock (2026-06-14):** PN is pre-funded, so a death is at
  once a claim, a reserve release, and a decrement. `shockFromBank` sets `cm.PN === lm.PN` from a single
  mortality draw (PN's claims σ *is* the mortality σ) → claims↑, lives↓, reserve release↑, netting to the
  net amount at risk. PN has no separate lapse σ / no claims↔lapse ρ (ρ=1 by construction). Plus a
  **PN-only NIER (investment-yield) shock** — an additive bps level shift on the earned rate, applied in
  `buildVNB` via `opts.nierShift` — the dominant PN risk (default 35 bps sys / 15 bps proc). Both are
  stochastic-path only; deterministic projection, frontier scatter, and §1 are unchanged.
- **NIER cohort scoping → RBC only (2026-06-14):** the stochastic risk axis stays 2026-issue; the
  back-book NIER difference flows into RBC/TAC via `buildScen(sales,claims,lapse,nier)` for a selected
  sensitivity run — process NIER on every issue year (incl pre-2026), systematic on 2026+ new business
  (two `buildVNB` calls merged). `buildScen` with no `nier` arg is byte-identical → frontier/feasibility/§1
  unchanged. IRR_TAIL failures are MS/HI-driven, not PN.
- **Per-product IRR is scale-invariant** — differences vs the workbook are the scenario sales *trajectory*
  (growth vs the workbook's per-year shape), not the recalc; the portfolio IRR moves with the sales *mix*.
- **Preneed loading scales per life only** and does not respond to the claims shock.
- **Surplus TAC under a scenario uses full-book income deltas** (not new-business only):
  MS after-tax income + PN after-tax income + HI distributable earnings, with a one-year-ahead offset.
- **Required capital = PostCov × 1.03**, no additional conservatism factor.
- **All-Other TS charges and the G2 / I2 manual add-ins are frozen** across scenarios.

**Intentional inconsistencies replicated from the source workbook (do not "fix"):**
- PN acq/maint +1 month shift is **disabled** in the stacked VNB layout (active only in standalone display).
- Charge-scaling month index advances **one month per year**, not 12.
- HI uses **distributable earnings** (not after-tax income) for the TAC income delta.

**Corrections made to the workbook (canonical — do not re-introduce the originals):**
- Inverted TS scaling in 2026+ cohort recalc rows → corrected to direct `recalc / original` scaling.
- PN in-force bypassing the persistency regime → corrected to the same year-based build/persistency switch
  as MS and HI.
- Phantom terminal surplus release from the 360-vs-374-month grid difference → handled via tail
  pass-through.
- **Surplus-note maturity-year interest (2026-06-13):** the schedule was charging interest on every
  anniversary *including maturity* (a 10-yr note paid 11 interest charges; the final year paid interest
  **and** principal). Corrected so the **maturity year pays principal only** — interest accrues on each
  anniversary from the start through the year before maturity. (The frozen legacy HTML keeps the old
  behavior; this is a decomposed-engine correction and does not affect §1.)

## 6. Engine methodology

**VNB engine — income-statement construction.** The engine builds a monthly distributable-earnings
statement per issue-year cohort, then aggregates to calendar years. Original and scenario projections run
on the 360-month horizon (months 0 = Dec 2025 … 359 = Nov 2055). Monthly lines: Premium, net investment
income (on average of current/prior reserves at the per-product NIER), claims, other benefits
(tabular-reserve change + change in loading), commissions, premium tax, acquisition and maintenance
expense (with inflation factor and the PN +1-month shift where active), pre-tax income, tax, after-tax
income, change in target surplus, and distributable earnings (DE). IRR is taken on the annual DE stream;
NPV/PVDE discounts DE at the configured rate.

**EV recalc under a scenario.** A scenario is defined per product by a **2026 new-business sales level**,
a **claims scalar**, and a **lapse scalar**. From these the engine derives a **per-issue-year sales
scalar** (`updatedSales(Y) / originalSales(Y)`) and rebuilds lives and dollars cohort by cohort under a
**two-regime in-force roll-forward**: a *build* regime (early cohort years) and a *persistency* regime
(year ≥ issue+2), the latter applying the lapse shock as a year-over-year retention haircut. Dollar and
reserve variables rescale per life; incurred claims additionally carry the claims scalar.

**RBC & surplus.** Target-surplus (TS) charges load seriatim by product, line, and year-end. NAIC
after-covariance capital:

```
PostCov = TSC0 + TSC4a + √((TSC1+TSLR016+TSC3)² + TSC1CS² + TSC2² + TSC4b²)
Required capital = PostCov × 1.03
TAC = Total Surplus − non-insurance portion + AVR + scenario income delta (+ surplus-note cumulative net)
RBC ratio = TAC / Required capital
```

Under a scenario, each modeled-product charge rescales by the recalc/original ratio of its **economic
driver** at year-end: **TSC2** (C-2 insurance risk) by the **incurred-claims ratio**; **all other
charges** by the **lives-in-force ratio**; **All-Other (non-modeled) charges are frozen**. The **TAC
income delta** for year Y is ΔMS_ATI + ΔPN_ATI + ΔHI distributable earnings (recalc − original,
full-book), applied with a one-year-ahead offset.

**Surplus note (default ON, $100M).** An optional note raises capital: the company receives the amount at
the start date (less an upfront fee), pays annual interest on each anniversary **through the year before
maturity**, and repays **principal at maturity (principal only — no interest that year)**. Its net cash
flow accumulates into TAC (it touches the model only through TAC), so the RBC ratio is re-derived from the
note-adjusted TAC. Example ($100M / 9% / 3% fee / 10y / 2026-06-30): 2026 net +$88M (receive 100, −3 fee,
−9 interest), 2027–2035 −$9M interest each, **2036 −$100M principal only**.

## 7. Forward sales growth (scenario draws only)

The forward sales projection compounds each sampled scenario's **2026 anchor** by a per-product, per-year
growth schedule for **2027–2035** (`sales[y] = sales[y−1] × (1 + rate[y])`). Key rules:

- It is a **deterministic config assumption**, not a sampled/stochastic dimension — the efficient-frontier
  sampler still samples only the **2026 anchors**.
- It lives **only** in `frontier.js → mkScalars` (the sampled scenario draws). The **baseline path never
  reads it**, so no growth setting can move a MODEL_CANON §1 number. With an all-zero schedule it reduces
  to the original flat projection byte-for-byte.
- **2026 is never grown** (it's the sampled anchor); only 2027–2035 compound.

**Default schedule:** MS **0%** every year; PN **10%** (2027–2029) then **6%** (2030–2035); HI **5%**
every year.

**Invariants (verified):** (1) with the default schedule loaded, every §1 target still reproduces — the
baseline is untouched; (2) with all growth at 0%, the decomposed efficient frontier matches the legacy
single-file frontier exactly (1700 field checks, 0 diffs). Note: under the default (non-zero) schedule the
2026-issue **scatter coordinates** (PVDE/risk) don't move (they're 2026-issue-only by design), but the
**feasible/frontier set shifts** because 2027+ growth flows through the full-book capital/RBC path.

## 8. Constraints

A scenario is **feasible** when it satisfies every constraint. C3–C6 and the CumDE floor are evaluated on
**2026 issues only** (pre-2026 in-force excluded); C1 and C2 use the full projected capital position.

- **C1 — Min RBC ratio (default 4.0×):** min projected RBC over 2026–2030 ≥ floor (full book).
- **C2 — ΔTAC / BOP TAC (default −12%):** `(TAC[y] − TAC[y−1]) / TAC[y−1]` ≥ floor every year.
- **C3 — 2026-issue IRR vs target (on):** 2026-issue DE-stream IRR ≥ sales-weighted average of product
  hurdles (weighted by the scenario's 2026 mix).
- **C4 — 2026-issue IRR tail (a = 8%, b = 10%):** across stochastic draws, P(IRR < a) < b.
- **C5 — 2026-issue DE positive by year (default yr 4 = 2029).**
- **C6 — 2026-issue cumulative DE positive by year (default yr 10 = 2035).**
- **CumDE floor (default −$180M):** deepest 2026-issue cumulative DE must not fall below the floor.
- **Year-1 DE floor (default −$120M):** 2026 first-year DE not more negative than the floor (baseline
  year-1 DE ≈ −$109M).

## 9. Frontier & stochastic method

- **Sampling.** Sales levels drawn by **Latin Hypercube Sampling** across the configured per-product
  bounds (even coverage with few scenarios).
- **Stochastic risk.** For each scenario, claims and termination rates are perturbed by **lognormal**
  shocks (mean 1) and 2026-issue PVDE is recomputed per draw. Each shock has a **systematic** component
  (one persistent draw across all years — drives the tail) and a **process** component (independent each
  year — largely diversifies away), combined as `exp(z_sys·σ_sys + z_proc(y)·σ_proc − ½(σ_sys²+σ_proc²))`.
  Process shocks are correlated within product/year (claims↔termination, ρ); systematic shocks are
  independent. **Preneed is the exception:** its claims and termination are one coupled mortality shock
  (`cm.PN === lm.PN`), and it carries an extra PN-only **NIER** shock — an *additive bps* level shift on
  the earned rate (35 bps sys / 15 bps proc by default; calibrated from ~15 bps/yr industry book-yield
  moves and 20–50 bps preneed interest margins) — which is its dominant risk. All scenarios share **one
  bank of draws (common random numbers)**, each paired with its **antithetic** mirror, so differences
  reflect the sales mix, not Monte-Carlo noise. Seeded (`STOCH_SEED = 20260612`) → reproducible.
- **Risk axis = CTE-90 downside shortfall:** (deterministic plan PVDE) − (average PVDE in the worst 10%
  of draws). Lower/further-left is safer. Also reported: worst-decile **max drawdown** (deepest cumulative
  2026-issue DE) and **P10 IRR**.
- **Efficient frontier:** feasible scenarios that are non-dominated in (risk, PVDE) space. Robustness
  re-ranks the frontier under harsher downside views (CTE-95, amplified dispersion, worst case).

## 10. Access gate

The Pages site is password-gated (landing page checks a password, sets a per-session token, forwards to
the viewer; an early guard bounces direct viewer access). This is **client-side obfuscation, not real
security** — a static site's source and `data/*.csv` remain reachable by a determined visitor. Only the
SHA-256 hash of the password is stored.

---

## 11. Appendix — engine source (verbatim)

The four modules below are embedded verbatim from `src/` for precise code-level questions. `engine.js`
(the trivial Node assembler) is omitted.

### `src/vnb.js`

```js
// vnb.js — VNB engine: monthly income statements per cohort -> IRR / NPV.
// Extracted verbatim from the legacy single-file engine (no computed result changed).
(function(root, factory){
  if (typeof module !== "undefined" && module.exports) { module.exports = factory(); }
  else { root.EFENG = root.EFENG || {}; var m = factory(); for (var k in m) root.EFENG[k] = m[k]; }
})(typeof self !== "undefined" ? self : this, function(){
'use strict';
function parseCSV(text) {
  const rows = [];
  text = text.replace(/\r/g, '');
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const cells = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') q = !q;
      else if (ch === ',' && !q) { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    rows.push(cells);
  }
  return rows;
}
const num = v => { const x = parseFloat(v); return isFinite(x) ? x : 0; };

/* ---------------- EV ---------------- */
// returns evRows: [{iy, nb, prod, varName, vals:Float64Array(361)}], and index
function loadEV(text) {
  const rows = parseCSV(text);
  const hdr = rows[0];
  const valCols = [];
  for (let c = 0; c < hdr.length; c++) { const m = /^Value(\d+)$/.exec(hdr[c]); if (m) valCols.push([c, +m[1]]); }
  const maxP = Math.max(...valCols.map(v => v[1]));
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row[3]) continue;
    const vals = new Float64Array(maxP + 1);
    for (const [c, p] of valCols) vals[p] = num(row[c]);
    out.push({ iy: String(row[0]), nb: row[1], prod: row[2], varName: row[3], vals });
  }
  return { rows: out, maxP };
}
// sum monthly vector for product+newbus filter (nb optional) and variable
function evMonthly(ev, prod, varName, nb, iyFilter) {
  // iyFilter (optional): restrict to a single issue-year cohort, e.g. '2026'.
  // When omitted, behavior is identical to before (all cohorts) and uses the
  // compiled index fast path — the full calc engine is unchanged for default calls.
  if (ev._idx && iyFilter === undefined) {
    const vl = varName.toLowerCase();
    const k = prod + '|' + vl + '|' + (nb !== undefined ? nb : '');
    const hit = ev._idx[k] || (nb !== undefined ? ev._idx[prod + '|' + vl + '|'] : null);
    if (hit) return hit;
    return new Float64Array(ev.maxP + 1);
  }
  const out = new Float64Array(ev.maxP + 1);
  const vlow = varName.toLowerCase();
  for (const rec of ev.rows) {
    if (rec.prod !== prod) continue;
    if (nb !== undefined && rec.nb !== nb) continue;
    if (iyFilter !== undefined && String(rec.iy) !== String(iyFilter)) continue;
    if (rec.varName.toLowerCase() !== vlow) continue;
    for (let p = 0; p <= ev.maxP; p++) out[p] += rec.vals[p];
  }
  return out;
}
function compileEV(ev) {
  const maxP = ev.maxP, idx = {};
  for (const r of ev.rows) {
    const vl = r.varName.toLowerCase(), nb = r.nb || '';
    const k1 = r.prod + '|' + vl + '|' + nb;
    const k2 = r.prod + '|' + vl + '|';
    if (!idx[k1]) idx[k1] = new Float64Array(maxP + 1);
    const a1 = idx[k1];
    for (let p = 0; p <= maxP; p++) a1[p] += r.vals[p];
    if (nb) {
      if (!idx[k2]) idx[k2] = new Float64Array(maxP + 1);
      const a2 = idx[k2];
      for (let p = 0; p <= maxP; p++) a2[p] += r.vals[p];
    }
  }
  return { rows: ev.rows, maxP: ev.maxP, _idx: idx };
}

/* ------------- assumptions helpers ------------- */
// per-product yearly assumption with MATCH(MIN(year,2030)) and flat-extend
function assumLookup(perProd, prodName, kind, year) {
  const yrs = [2025, 2026, 2027, 2028, 2029, 2030];
  const arr = perProd[prodName][kind];
  const y = Math.min(year, 2030);
  let idx = yrs.indexOf(y); if (idx < 0) idx = 0;
  return arr[idx];
}

/* ------------- VNB engine ------------- */
function monthYear(p, baseYear) { // p=0 -> Dec baseYear; p=1 -> Jan baseYear+1 ...
  // Excel: AI3=Dec 2025 (p0), AJ=Jan2026 (p1) ... EOMONTH walk
  const d = new Date(Date.UTC(baseYear, 11, 31)); // Dec 31 baseYear
  d.setUTCMonth(d.getUTCMonth() + p);
  return d;
}
function buildVNB(ev, prod, params, opts) {
  opts = opts || {};
  const nMonths = opts.nMonths || 1000; // use all available data by default; recalc paths pass nMonths:360 explicitly            // VNB grid width (Value000..Value{nMonths-1})
  const lastP = Math.min(ev.maxP, nMonths - 1);
  const nb = opts.allBook ? undefined : 'N';
  const iyf = opts.iy;   // optional single issue-year filter (e.g. '2026'); undefined = all cohorts
  const P = params.assum, maxP = ev.maxP, baseYear = 2025;
  const tax = P.tax, infl = P.inflation, inflStart = P.inflStart;
  const EarnedPrem = evMonthly(ev, prod, 'EarnedPrem', nb, iyf);
  const IncClaims = evMonthly(ev, prod, 'IncClaims', nb, iyf);
  const Comm = evMonthly(ev, prod, 'Comm', nb, iyf);
  const PremTax = evMonthly(ev, prod, 'PremTax', nb, iyf);
  const CLRes = evMonthly(ev, prod, 'CLRes', nb, iyf);
  const TabRes = evMonthly(ev, prod, 'TabRes', nb, iyf);
  const TS = evMonthly(ev, prod, 'TS', nb, iyf);
  const LIF = evMonthly(ev, prod, 'LivesInForce1', nb, iyf);
  const Issued = evMonthly(ev, prod, 'LivesIssued', nb, iyf);
  const ChgLoad = evMonthly(ev, prod, 'Change In Loading', nb, iyf);
  const prodName = { MS: 'Medicare Supplement', PN: 'Preneed', HI: 'Hospital Indemnity' }[prod];
  const isPN = (prod === 'PN') && (opts.pnShift !== false);   // stacked VNB layout references $C$1 (MS), disabling the PN acq/maint shift

  const m = {}; const mk = () => new Float64Array(maxP + 1);
  for (const k of ['Premium', 'NII', 'TotRev', 'Claims', 'OthBen', 'TotBen', 'Comm', 'PremTax', 'Acq', 'Maint', 'TotExp', 'PTI', 'Tax', 'ATI', 'ChgTS', 'DE', 'CLRes', 'TabRes', 'TS', 'PolCnt', 'IssCnt']) m[k] = mk();
  // pre-fill reserves/counts (needed for mid-period NII average and PN +1 shift)
  for (let p = 0; p <= lastP; p++) {
    m.CLRes[p] = CLRes[p] / 1e6; m.TabRes[p] = TabRes[p] / 1e6; m.TS[p] = TS[p] / 1e6;
    m.PolCnt[p] = LIF[p]; m.IssCnt[p] = Issued[p];
  }
  for (let p = 0; p <= lastP; p++) {
    const dt = monthYear(p, baseYear), yr = dt.getUTCFullYear();
    m.Premium[p] = EarnedPrem[p] / 1e6;
    const nier = assumLookup(P.perProduct, prodName, 'NIER', yr);
    const rate = Math.pow(1 + nier, 1 / 12) - 1;
    const assetsP = m.CLRes[p] + m.TabRes[p] + m.TS[p];
    const assetsPrev = p > 0 ? (m.CLRes[p - 1] + m.TabRes[p - 1] + m.TS[p - 1]) : 0;
    m.NII[p] = (assetsP + assetsPrev) / 2 * rate;          // AVERAGE(curr,prev)*((1+nier)^(1/12)-1); p0 -> curr/2
    m.TotRev[p] = m.Premium[p] + m.NII[p];
    m.Claims[p] = -IncClaims[p] / 1e6;
    m.OthBen = m.OthBen || new Float64Array(lastP + 1);
    m.OthBen[p] = p === 0 ? 0 : -(m.TabRes[p] - m.TabRes[p - 1]) - ChgLoad[p] / 1e6;
    m.TotBen[p] = m.Claims[p] + m.OthBen[p];
    m.Comm[p] = -Comm[p] / 1e6; m.PremTax[p] = -PremTax[p] / 1e6;
    const inflFac = yr > inflStart ? Math.pow(1 + infl, yr - inflStart) : 1;
    const acq = assumLookup(P.perProduct, prodName, 'Acquisition Expense', yr);
    const maint = assumLookup(P.perProduct, prodName, 'Maintenance Expense', yr);
    const issForAcq = isPN ? (p + 1 <= ev.maxP ? Issued[p + 1] : 0) : Issued[p];   // PN: next month's issued
    const polForMnt = isPN ? (p + 1 <= ev.maxP ? LIF[p + 1] : 0) : LIF[p];          // PN: next month's in-force
    m.Acq[p] = -issForAcq * acq / 1e6 * inflFac;
    m.Maint[p] = -polForMnt * maint / 1e6 / 12 * inflFac;
    m.TotExp[p] = m.Comm[p] + m.PremTax[p] + m.Acq[p] + m.Maint[p];
    m.PTI[p] = m.TotRev[p] + m.TotBen[p] + m.TotExp[p];
    m.Tax[p] = -m.PTI[p] * tax;
    m.ATI[p] = m.PTI[p] + m.Tax[p];
    m.ChgTS[p] = p === 0 ? 0 : -(m.TS[p] - m.TS[p - 1]);
    m.DE[p] = m.ATI[p] + m.ChgTS[p];
  }
  // annualize 2025..2055
  const years = []; for (let y = 2025; y <= 2055; y++) years.push(y);
  const flowRows = ['Premium', 'NII', 'TotRev', 'Claims', 'OthBen', 'TotBen', 'Comm', 'PremTax', 'Acq', 'Maint', 'TotExp', 'PTI', 'Tax', 'ATI', 'ChgTS', 'DE', 'IssCnt'];
  const stockRows = ['CLRes', 'TabRes', 'TS', 'PolCnt'];
  const A = {};
  for (const k of [...flowRows, ...stockRows]) A[k] = {};
  for (const y of years) { for (const k of [...flowRows, ...stockRows]) A[k][y] = 0; }
  for (let p = 0; p <= lastP; p++) {
    const yr = monthYear(p, baseYear).getUTCFullYear();
    if (yr < 2025 || yr > 2055) continue;
    for (const k of flowRows) A[k][yr] += m[k][p];
  }
  for (const y of years) {
    // stock = value at Dec of year => month p where monthYear==Dec y
    const p = (y - baseYear) * 12; // p0=Dec2025, p12=Dec2026...
    if (p >= 0 && p <= lastP) for (const k of stockRows) A[k][y] = m[k][p];
  }
  return { monthly: m, annual: A, years };
}
function npv(rate, arr) { let s = 0; for (let i = 0; i < arr.length; i++) s += arr[i] / Math.pow(1 + rate, i + 1); return s; }
function irr(arr) {
  // NPV as a function of rate; robust scan + bisection, guards against overflow.
  const f = r => { let s = 0; for (let i = 0; i < arr.length; i++) { const d = Math.pow(1 + r, i); s += d === 0 ? 0 : arr[i] / d; } return s; };
  const tryBracket = (a, fa, b, fb) => {
    let lo = a, hi = b, flo = fa, fhi = fb;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2, fm = f(mid);
      if (!isFinite(fm)) { hi = mid; continue; }
      if (Math.abs(fm) < 1e-9) return mid;
      if (flo * fm < 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
    }
    return (lo + hi) / 2;
  };
  // Collect ALL sign-change brackets across a fine grid. A cash-flow stream
  // that turns negative again in its tail years (e.g. terminal reserve run-off)
  // can have multiple sign changes in NPV(r); the deeply-negative early
  // discounting produces a spurious low/negative root. Excel's IRR resolves to
  // the root nearest its guess (default 10%), which is the economically
  // meaningful one. We replicate that: gather every root, then pick the one
  // closest to a 10% guess (preferring non-negative roots).
  const roots = [];
  let prevR = -0.95, prevF = f(prevR);
  for (let r = -0.90; r <= 2.0001; r += 0.025) {
    const fr = f(r);
    if (isFinite(prevF) && isFinite(fr) && prevF * fr <= 0 && prevF !== fr) {
      roots.push(tryBracket(prevR, prevF, r, fr));
    }
    prevR = r; prevF = fr;
  }
  if (roots.length === 0) return null;       // no sign change -> IRR undefined
  if (roots.length === 1) return roots[0];
  const GUESS = 0.10;
  // Prefer the closest non-negative root to the guess; fall back to closest overall.
  const nonNeg = roots.filter(r => r >= 0);
  const pool = nonNeg.length ? nonNeg : roots;
  return pool.reduce((best, r) =>
    Math.abs(r - GUESS) < Math.abs(best - GUESS) ? r : best, pool[0]);
}
function vnbResults(vnb, disc) {
  const yrsDisc = []; for (let y = 2026; y <= 2055; y++) yrsDisc.push(y);
  const deStream = yrsDisc.map(y => vnb.annual.DE[y]);
  return {
    npvDE: npv(disc, deStream),
    irr: irr(deStream),
    npvPremium: npv(disc, yrsDisc.map(y => vnb.annual.Premium[y]))
  };
}

return { loadEV: loadEV, evMonthly: evMonthly, buildVNB: buildVNB, vnbResults: vnbResults, npv: npv, irr: irr, assumLookup: assumLookup };
});
```

### `src/ev-recalc.js`

```js
// ev-recalc.js — EV recalc under sales/claims/lapse scalars (two-regime in-force roll-forward).
// Extracted verbatim from the legacy single-file engine (no computed result changed).
(function(root, factory){
  if (typeof module !== "undefined" && module.exports) { module.exports = factory(); }
  else { root.EFENG = root.EFENG || {}; var m = factory(); for (var k in m) root.EFENG[k] = m[k]; }
})(typeof self !== "undefined" ? self : this, function(){
'use strict';
// recalc.js — EV recalc under scalars (updated lives engine)
// New lives formula: new-business cohorts anchor to their base month; no compounding ss.
// PN first month of each cohort keeps original to avoid div/0 where LIF starts at 0.

const PRODNAME = { MS: 'Medicare Supplement', PN: 'Preneed', HI: 'Hospital Indemnity' };
const DOLLAR_VARS = new Set(['CededALRstat', 'change in loading', 'CLRes', 'Comm', 'EarnedPrem',
  'IncClaims', 'PremTax', 'ReinsClaims', 'ReinsEA', 'ReinsPrem', 'TabRes', 'TS']);
const CLAIM_VARS = new Set(['IncClaims', 'ReinsClaims']);
function isDollar(vn) { return DOLLAR_VARS.has(vn) || vn.toLowerCase() === 'change in loading'; }

// monthYearR: calendar year for month p (p=0 → Dec2025 → 2025)
function monthYearR(p) {
  const d = new Date(Date.UTC(2025, 11, 31));
  d.setUTCMonth(d.getUTCMonth() + p);
  return d.getUTCFullYear();
}

function salesScalar(scalars, prodCode, iy) {
  if (iy === '<2026') return 1;
  const name = PRODNAME[prodCode];
  const yi = (scalars.years || []).indexOf(parseInt(iy, 10));
  if (yi < 0 || !scalars.origSales[name] || !scalars.updSales[name]) return 1;
  const o = scalars.origSales[name][yi], u = scalars.updSales[name][yi];
  return (o && isFinite(o)) ? u / o : 1;
}

// Recalc EV under scalars with new lives engine.
// Key formula:
//   <2026 (old in-force block):
//     Build (year < 2027): newLIF = origLIF - origIssued + newIssued
//     Persistency: newLIF[p] = newLIF[baseP] * (1-(1-origLIF[p]/origLIF[baseP])*ls) * ss
//   New-business cohorts (2026+):
//     Build (year < issueYear+2): newLIF = origLIF * ss
//                                  EXCEPT PN at baseP: newLIF = origLIF (no scalar, avoids div/0)
//     Persistency: newLIF[p] = newLIF[baseP] * (1-(1-origLIF[p]/origLIF[baseP])*ls)  [NO ss]
//   baseP = first month of the cohort (Value001 for <2026/2026, Value013 for 2027, etc.)
function recalcEV(ev, scalars) {
  const maxP = ev.maxP;
  const cohorts = {};
  for (const rec of ev.rows) {
    const k = rec.iy + '|' + rec.nb + '|' + rec.prod;
    (cohorts[k] || (cohorts[k] = {}))[rec.varName] = rec;
  }
  const outRows = [];

  for (const k in cohorts) {
    const c = cohorts[k];
    const [iy, nb, prod] = k.split('|');
    const ss = salesScalar(scalars, prod, iy);
    // cs/ls may be a scalar (deterministic / single-shock) OR a per-year map {2026:m, 2027:m, ...}
    // (process+systematic shock vector). shockAt() resolves either form; a number returns itself,
    // so every existing scalar caller — and the entire deterministic path — is byte-for-byte unchanged.
    const cs = (scalars.claims && scalars.claims[PRODNAME[prod]] != null) ? scalars.claims[PRODNAME[prod]] : 1;
    const ls = (scalars.lapse  && scalars.lapse [PRODNAME[prod]] != null) ? scalars.lapse [PRODNAME[prod]] : 1;
    const shockAt = (v, yr) => (v == null) ? 1 : (typeof v === 'number' ? v : (v[yr] != null ? v[yr] : 1));

    const isOldBlock = (iy === '<2026');
    const isPN = (prod === 'PN');
    const effIY = isOldBlock ? 2025 : parseInt(iy, 10);
    const buildEndYear = effIY + 2;     // year >= this → persistency

    // Base month: first month with data for this cohort.
    // <2026→1, 2026→1, 2027→13, 2028→25, ...
    const baseP = Math.max(1, (effIY - 2025) * 12 - 11);

    const origLIF = c['LivesInForce1'] ? c['LivesInForce1'].vals : new Float64Array(maxP + 1);
    const origIss = c['LivesIssued']   ? c['LivesIssued'].vals   : new Float64Array(maxP + 1);
    const newLIF  = new Float64Array(maxP + 1);
    const newIss  = new Float64Array(maxP + 1);

    for (let p = 0; p <= maxP; p++) {
      const yr = monthYearR(p);

      // ── LivesIssued ──────────────────────────────────────────────────────
      // PN first month of each new cohort: keep original (no scalar) to avoid
      // a zero base that would propagate div/0 through the dollar-variable scaling.
      if (!isOldBlock && isPN && p === baseP) {
        newIss[p] = origIss[p];
      } else {
        newIss[p] = origIss[p] * ss;
      }

      // ── LivesInForce1 ────────────────────────────────────────────────────
      if (isPN) {
        // ── Preneed rules ──────────
        // <2026 block:  build month  = origLIF * ss
        //               persistency  = rolling year-over-year, NO ss
        // 2026+ cohort: first month  = origLIF (raw, no scalar)
        //               build months = origLIF * ss
        //               persistency  = rolling year-over-year, NO ss
        if (!isOldBlock && p < baseP) {
          newLIF[p] = 0;                                        // before cohort starts
        } else if (!isOldBlock && p === baseP) {
          newLIF[p] = origLIF[p];                               // PN new cohort first month: raw
        } else if (yr < buildEndYear) {
          newLIF[p] = origLIF[p] * ss;                          // build: proportional, both blocks
        } else {
          const priorOrig   = origLIF[p - 12];
          const priorRecalc = newLIF[p - 12];
          if (Math.abs(priorOrig) < 1e-9) {
            newLIF[p] = 0;
          } else {
            const stepRet    = origLIF[p] / priorOrig;
            const shockedRet = Math.max(0, 1 - (1 - stepRet) * shockAt(ls, yr));
            newLIF[p] = priorRecalc * shockedRet;              // PN: no ss in persistency (either block)
          }
        }
      } else if (!isOldBlock && p < baseP) {
        newLIF[p] = 0;                                          // before cohort starts
      } else if (yr < buildEndYear) {
        // Build regime (MS / HI)
        if (isOldBlock) {
          newLIF[p] = origLIF[p] - origIss[p] + newIss[p];    // additive for old in-force
        } else {
          newLIF[p] = origLIF[p] * ss;                         // proportional for new cohorts
        }
      } else {
        // Persistency regime (MS / HI) — rolling year-over-year (matches workbook).
        // Each month references the PRIOR RECALC year (p-12), not a fixed base.
        // Old in-force block multiplies by ss each step; new cohorts do not.
        const priorOrig   = origLIF[p - 12];
        const priorRecalc = newLIF[p - 12];
        if (Math.abs(priorOrig) < 1e-9) {
          newLIF[p] = 0;
        } else {
          const stepRet    = origLIF[p] / priorOrig;
          const shockedRet = Math.max(0, 1 - (1 - stepRet) * shockAt(ls, yr));
          newLIF[p] = isOldBlock ? priorRecalc * shockedRet * ss : priorRecalc * shockedRet;
        }
      }
    }

    // Dollar and reserve variables: per-life rescaling
    const mkrow = (varName, vals) => ({ iy, nb, prod, varName, vals });
    for (const vn in c) {
      if (vn === 'LivesInForce1') { outRows.push(mkrow(vn, newLIF)); continue; }
      if (vn === 'LivesIssued')   { outRows.push(mkrow(vn, newIss)); continue; }
      const ov = c[vn].vals;
      if (isDollar(vn)) {
        const isClaim = CLAIM_VARS.has(vn);
        const nv = new Float64Array(maxP + 1);
        for (let p = 0; p <= maxP; p++) {
          const claimMul = isClaim ? shockAt(cs, monthYearR(p)) : 1;   // per-year claims shock
          if (Math.abs(origLIF[p]) > 1e-9) {
            // Per-life rescale. PN v3 applies the claims scalar on every month that has a
            // live base (this includes the <2026 p0+ months and all new-cohort months
            // after the first); the first build month is handled by the div/0 branch below.
            nv[p] = ov[p] / origLIF[p] * newLIF[p] * claimMul;
          } else if (isPN && p === baseP && !isOldBlock) {
            // PN new-cohort first month: workbook IFERROR fallback = origVal * salesScalar
            // (NO claims scalar — col F has no C$18 factor).
            nv[p] = ov[p] * ss;
          } else {
            // Tail months / other zero-base cases: pass through with claims mult.
            nv[p] = ov[p] * claimMul;
          }
        }
        outRows.push(mkrow(vn, nv));
      } else {
        outRows.push(mkrow(vn, ov.slice()));
      }
    }
  }
  return { rows: outRows, maxP };
}

return { recalcEV: recalcEV, salesScalar: salesScalar };
});
```

### `src/rbc-surplus.js`

```js
// rbc-surplus.js — NAIC covariance charges, required capital, scenario TAC, surplus note.
// Extracted verbatim from the legacy single-file engine (no computed result changed).
(function(root, factory){
  if (typeof module !== "undefined" && module.exports) { module.exports = factory(); }
  else { root.EFENG = root.EFENG || {}; var m = factory(); for (var k in m) root.EFENG[k] = m[k]; }
})(typeof self !== "undefined" ? self : this, function(){
'use strict';
function parseCSV(text) {
  const rows = [];
  text = text.replace(/\r/g, '');
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const cells = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') q = !q;
      else if (ch === ',' && !q) { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    rows.push(cells);
  }
  return rows;
}
const num = v => { const x = parseFloat(v); return isFinite(x) ? x : 0; };
/* ------------- Surplus / TS engine ------------- */
const TSC_KEYS = ['TSC0', 'TSC1', 'TSLR016', 'TSC1CS', 'TSC2', 'TSC3', 'TSC4a', 'TSC4b'];
function loadTS(text) {
  const rows = parseCSV(text);
  // header: Proj.Date, Product, Line, NewBuss, Amount
  const data = []; // {date(YYYY), prod, line, amt}
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]; if (!row[2]) continue;
    const d = row[0]; const yr = d ? parseInt(String(d).slice(0, 4), 10) : null;
    // Normalize date to YYYY-MM-DD — newer exports include a time component
    // (e.g. "2025-12-31 00:00:00") which must be stripped so year-end matching works.
    const dateStr = String(d).trim().slice(0, 10);
    data.push({ date: dateStr, yr, prod: row[1], line: row[2], amt: num(row[4]) });
  }
  return data;
}
// charge for product (exact name), line, calendar year-end; TSC3 x0.5 applied by caller
function tsSum(ts, prod, line, year) {
  let s = 0; const ll = line.toLowerCase(); const ye = year + '-12-31';
  for (const d of ts) {
    if (d.date !== ye) continue;
    if (prod !== null && d.prod !== prod) continue;
    if (d.line.toLowerCase() !== ll) continue;
    s += d.amt;
  }
  return s;
}
function surplusCalc(ts, surplusRows, tsAdj, years) {
  const modeled = { 'Medicare Supplement': 'Medicare Supplement', 'Hospital Indemnity': 'Hospital Indemnity', 'PreNeed': 'PreNeed' };
  const half = k => k === 'TSC3' ? 0.5 : 1;
  const out = {};
  for (const y of years) {
    // per-product charges
    const prod = {};
    for (const pn of Object.keys(modeled)) {
      prod[pn] = {};
      for (const k of TSC_KEYS) prod[pn][k] = tsSum(ts, pn, k, y) / 1e6 * half(k);
    }
    // all other = total(all) - the three; + adjustments to TSC1 and TSC1CS
    const allOther = {};
    for (const k of TSC_KEYS) {
      let tot = tsSum(ts, null, k, y) / 1e6 * half(k);
      let resid = tot - prod['Medicare Supplement'][k] - prod['Hospital Indemnity'][k] - prod['PreNeed'][k];
      if (k === 'TSC1') resid += tsAdj.G2;
      if (k === 'TSC1CS') resid += tsAdj.I2;
      allOther[k] = resid;
    }
    // totals
    const tot = {};
    for (const k of TSC_KEYS) tot[k] = prod['Medicare Supplement'][k] + prod['Hospital Indemnity'][k] + prod['PreNeed'][k] + allOther[k];
    const postCov = tot.TSC0 + tot.TSC4a + Math.sqrt(Math.pow(tot.TSC1 + tot.TSLR016 + tot.TSC3, 2) + tot.TSC1CS ** 2 + tot.TSC2 ** 2 + tot.TSC4b ** 2);
    const reqCap = postCov * 1.03;
    const tac = surplusRows.totalSurplus[y] - surplusRows.nonIns[y] + surplusRows.avr[y];
    out[y] = { prod, allOther, tot, postCov, reqCap, tac, ratio: tac / reqCap };
  }
  return out;
}
function loadSurplus(text) {
  const rows = parseCSV(text);
  // row0: 'Original', years...; row1 Total Surplus; row2 Portion in non-ins; row3 AVR
  const years = rows[0].slice(1).map(v => parseInt(v, 10));
  const pick = r => { const o = {}; years.forEach((y, i) => o[y] = num(rows[r][i + 1])); return o; };
  return { years, totalSurplus: pick(1), nonIns: pick(2), avr: pick(3) };
}


// surplus_recalc.js — scenario RBC matching workbook Surplus Recalc
//  charges: 2025 baseline; 2026+ scaled by full-book in-force ratio at an
//           off-by-one month index (2026->Value012, 2027->Value013, ...); All Other frozen.
//  TAC(Y)  = baseTAC(Y) + incDelta(Y+1), incDelta = dMS_ATI + dPN_ATI + dHI_ATI (new business).
const PNAME = { MS: 'Medicare Supplement', HI: 'Hospital Indemnity', PN: 'PreNeed' };

function surplusRecalc(origEV, scalars, ts, surplus, tsAdj, assum, years, preOrigVNB) {
  const recEV = R.recalcEV(origEV, scalars);
  const base = E.surplusCalc(ts, surplus, tsAdj, years);
  // full-book in-force by product, original vs recalc, indexed by Value column
  const oLIF = {}, rLIF = {};
  for (const code of ['MS', 'HI', 'PN']) { oLIF[code] = E.evMonthly(origEV, code, 'LivesInForce1'); rLIF[code] = E.evMonthly(recEV, code, 'LivesInForce1'); }
  // per-product new-business income, original vs recalc
  const vnb = {};
  // full book (new business + older <2026 block) so the TAC change captures older policy years
  for (const code of ['MS', 'PN', 'HI']) vnb[code] = { o: E.buildVNB(origEV, code, { assum }, { nMonths: 360, allBook: true }), r: E.buildVNB(recEV, code, { assum }, { nMonths: 360, allBook: true }) };
  const incDelta = y => {
    const dMS = (vnb.MS.r.annual.ATI[y] || 0) - (vnb.MS.o.annual.ATI[y] || 0);
    const dPN = (vnb.PN.r.annual.ATI[y] || 0) - (vnb.PN.o.annual.ATI[y] || 0);
    const dHI = (vnb.HI.r.annual.ATI[y] || 0) - (vnb.HI.o.annual.ATI[y] || 0);
    return dMS + dPN + dHI;
  };
  const ratioAt = (code, vi) => { const d = oLIF[code][vi] || 0; return Math.abs(d) > 1e-9 ? (rLIF[code][vi] || 0) / d : 1; };

  const out = {};
  for (const y of years) {
    const prod = {};
    const inf = {};
    for (const code of ['MS', 'HI', 'PN']) inf[code] = (y === 2025) ? 1 : ratioAt(code, 12 + (y - 2026));
    const NAME2CODE = { 'Medicare Supplement': 'MS', 'Hospital Indemnity': 'HI', 'PreNeed': 'PN' };
    for (const pname of Object.keys(base[y].prod)) {
      const code = NAME2CODE[pname];
      prod[pname] = {};
      for (const k of TSC_KEYS) prod[pname][k] = base[y].prod[pname][k] * inf[code];   // every charge scales by in-force ratio
    }
    const tot = {};
    for (const k of TSC_KEYS) tot[k] = prod['Medicare Supplement'][k] + prod['Hospital Indemnity'][k] + prod['PreNeed'][k] + base[y].allOther[k];
    const postCov = tot.TSC0 + tot.TSC4a + Math.sqrt(Math.pow(tot.TSC1 + tot.TSLR016 + tot.TSC3, 2) + tot.TSC1CS ** 2 + tot.TSC2 ** 2 + tot.TSC4b ** 2);
    const reqCap = postCov * 1.03;
    const baseTAC = surplus.totalSurplus[y] - surplus.nonIns[y] + surplus.avr[y];
    const tac = baseTAC + incDelta(y + 1);                                       // one-year-ahead income delta
    out[y] = { reqCap, tac, ratio: tac / reqCap, baseRatio: base[y].ratio };
  }
  return out;
}


/* ── Surplus Note cash-flow engine ──────────────────────────────────────────
 * Models a surplus note: the company receives `amount` ($M) at `startDate`,
 * pays an upfront fee (amount × fees) at issue, annual interest (amount × rate)
 * on each anniversary month, and repays principal at the end date
 * (= startDate + tenor years).
 *
 * Returns the NET cash flow (cash in − cash out) aggregated by calendar year.
 * Positive net adds to TAC in that year; negative net subtracts. This is the
 * ONLY place the surplus note touches the model — it flows through TAC as an
 * income change and nowhere else.
 *
 * Matches the workbook "Surplus note" tab:
 *   cash in   = amount at the start-date month
 *   cash out  = (amount×fees at start month)
 *             + (amount×rate when month==startMonth AND year>=startYear, i.e. each anniversary)
 *             + (amount at end-date month)
 *             ... but zero for any month strictly after the end date.
 */

// Parse a date input. Accepts 'YYYY-MM-DD' or 'YYYY-MM'. Normalizes to the
// month/year; day is retained for anniversary/end matching against month-ends.
function parseNoteDate(s) {
  if (!s) return null;
  const parts = String(s).trim().split('-');
  const y = parseInt(parts[0], 10);
  const m = parts.length > 1 ? parseInt(parts[1], 10) : 1;
  if (!isFinite(y) || !isFinite(m)) return null;
  return { year: y, month: m };       // month is 1-12
}

// End date = start + tenor years (same month/year offset).
function noteEndDate(start, tenorYears) {
  if (!start) return null;
  return { year: start.year + Math.round(tenorYears), month: start.month };
}

// Compute annual net cash flow by calendar year, 2026..2055.
// inputs: { tenor, rate, fees, amount, startDate }  (startDate as 'YYYY-MM-DD')
function surplusNoteAnnual(inputs) {
  const out = {};
  for (let y = 2025; y <= 2055; y++) out[y] = 0;
  if (!inputs || !inputs.on) return out;

  const amount = +inputs.amount || 0;
  const rate   = +inputs.rate   || 0;   // annual, decimal
  const fees   = +inputs.fees   || 0;   // decimal of amount
  const tenor  = +inputs.tenor  || 0;
  const start  = parseNoteDate(inputs.startDate);
  if (!start || amount === 0) return out;
  const end = noteEndDate(start, tenor);

  // Walk months Jan 2026 .. Nov 2055 (matches workbook horizon).
  for (let y = 2026; y <= 2055; y++) {
    for (let m = 1; m <= 12; m++) {
      if (y === 2055 && m === 12) continue;          // last month cut off (model convention)
      // Compare this month against start/end (month-level).
      const afterEnd = (y > end.year) || (y === end.year && m > end.month);
      if (afterEnd) continue;                         // no flows past end date

      let cashIn = 0, cashOut = 0;
      const isStart = (y === start.year && m === start.month);
      const isEnd   = (y === end.year   && m === end.month);
      const isAnniv = (m === start.month && y >= start.year);

      if (isStart) { cashIn += amount; cashOut += amount * fees; }
      if (isAnniv && !isEnd) { cashOut += amount * rate; }   // maturity year pays principal only, no interest
      if (isEnd)   { cashOut += amount; }

      out[y] += (cashIn - cashOut);
    }
  }
  return out;
}

return { surplusCalc: surplusCalc, loadTS: loadTS, loadSurplus: loadSurplus, surplusRecalc: surplusRecalc, TSC_KEYS: TSC_KEYS, surplusNoteAnnual: surplusNoteAnnual, noteEndDate: noteEndDate, parseNoteDate: parseNoteDate };
});
```

### `src/frontier.js`

```js
// frontier.js — scenario + efficient-frontier compute, shared by the viewer and the
// headless runner so both produce identical results. Ported verbatim from the legacy
// single-file viewer; the ONLY behavioral change is the forward sales-growth projection
// in mkScalars (see the comment there). All functions close over the caller's state
// object S and the engine EFENG, so the viewer's live config drives every calc.
//
// SCOPE NOTE (sales growth): growth is applied ONLY here, when projecting each sampled
// scenario's sales forward (updSales) for the efficient-frontier draws. It is a
// deterministic config assumption, NOT a sampled dimension. The baseline path
// (computeBaseline) never calls into this module, so the MODEL_CANON §1 baseline is
// unaffected by any growth setting. With an all-zero schedule, mkScalars reduces to the
// original flat projection byte-for-byte (see Invariant 2).
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) { module.exports = factory(); }
  else { root.EFFRONTIER = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function create(S, EFENG) {
    var PRODS = ['MS', 'PN', 'HI'];
    var PNAME = { MS: 'Medicare Supplement', PN: 'Preneed', HI: 'Hospital Indemnity' };
    var SALES_YEARS = [2026, 2027, 2028, 2029, 2030, 2031, 2032, 2033, 2034, 2035];
    var STOCH_SEED = 20260612;     // fixed default seed -> reproducible runs
    var NYEARS = 30;               // 2026..2055

    // ---- display helpers (used only to build constraint labels; non-numeric) ----
    function fmt(x, d) { if (x == null || !isFinite(x)) return '—'; return Number(x).toFixed(d != null ? d : 2); }
    function pct(x, d) { if (x == null || !isFinite(x)) return '—'; return (x * 100).toFixed(d != null ? d : 1) + '%'; }
    function rx(x) { if (x == null || !isFinite(x)) return '—'; return x.toFixed(3) + '×'; }

    // ---- seeded RNG (common random numbers + antithetic; see legacy notes) ----
    var RNG = Math.random;
    function setSeed(seed) { RNG = mulberry32(seed); }
    function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
    function nrand() { var u = RNG(); if (u < 1e-12) u = 1e-12; return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * RNG()); }
    function lhs(n, lo, hi) { var a = []; for (var i = 0; i < n; i++)a.push((i + RNG()) / n * (hi - lo) + lo); for (var i = n - 1; i > 0; i--) { var j = (RNG() * (i + 1)) | 0; var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
    function nvec(n) { var a = []; for (var i = 0; i < n; i++)a.push(nrand()); return a; }
    function buildShockBank(ns) {
      var bank = [];
      function mk() { var d = { cs: {}, ls: {}, cp: {}, lp: {} }; PRODS.forEach(function (c) { d.cs[c] = nrand(); d.ls[c] = nrand(); d.cp[c] = nvec(NYEARS); d.lp[c] = nvec(NYEARS); }); return d; }
      function neg(d) { var e = { cs: {}, ls: {}, cp: {}, lp: {} }; PRODS.forEach(function (c) { e.cs[c] = -d.cs[c]; e.ls[c] = -d.ls[c]; e.cp[c] = d.cp[c].map(function (z) { return -z; }); e.lp[c] = d.lp[c].map(function (z) { return -z; }); }); return e; }
      while (bank.length < ns) { var b = mk(); bank.push(b); if (bank.length < ns) bank.push(neg(b)); } return bank;
    }
    function shockFromBank(b) {
      var cm = {}, lm = {}; PRODS.forEach(function (c) {
        var cS = S.claimsSD[c] || 0, cP = (S.claimsProcSD && S.claimsProcSD[c]) || 0, lS = S.lapseSD[c] || 0, lP = (S.lapseProcSD && S.lapseProcSD[c]) || 0;
        var rho = (S.procCorr && S.procCorr[c]) || 0, rr = Math.sqrt(Math.max(0, 1 - rho * rho));
        var cAdj = 0.5 * (cS * cS + cP * cP), lAdj = 0.5 * (lS * lS + lP * lP), cmap = {}, lmap = {};
        for (var i = 0; i < NYEARS; i++) {
          var y = 2026 + i;
          cmap[y] = Math.exp(b.cs[c] * cS + b.cp[c][i] * cP - cAdj);
          lmap[y] = Math.exp(b.ls[c] * lS + (rho * b.cp[c][i] + rr * b.lp[c][i]) * lP - lAdj);
        }
        cm[c] = cmap; lm[c] = lmap;
      });
      return { cm: cm, lm: lm };
    }

    // ---- statistics / downside risk ----
    function pctile(arr, p) { if (!arr || !arr.length) return null; var s = arr.slice().filter(function (x) { return x != null && isFinite(x); }).sort(function (a, b) { return a - b; }); if (!s.length) return null; var i = (p / 100) * (s.length - 1), lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); }
    function stddev(arr) { if (!arr || arr.length < 2) return 0; var a = arr.filter(function (x) { return x != null && isFinite(x); }); if (!a.length) return 0; var m = a.reduce(function (s, x) { return s + x; }, 0) / a.length; return Math.sqrt(a.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / a.length); }
    function cteLow(arr, p) { var s = arr.filter(function (x) { return x != null && isFinite(x); }).slice().sort(function (a, b) { return a - b; }); if (!s.length) return null; var k = Math.max(1, Math.round(p / 100 * s.length)), sum = 0; for (var i = 0; i < k; i++)sum += s[i]; return sum / k; }
    function semidevBelow(arr, ref) { if (ref == null || !isFinite(ref)) return 0; var a = arr.filter(function (x) { return x != null && isFinite(x); }); if (!a.length) return 0; var s = 0; a.forEach(function (x) { var d = Math.min(0, x - ref); s += d * d; }); return Math.sqrt(s / a.length); }
    function downsideRisk(npvs, dds, det) { var sd = stddev(npvs), cte90 = cteLow(npvs, 10); var risk = (det != null && isFinite(det) && cte90 != null && isFinite(cte90)) ? (det - cte90) : sd; return { risk: risk, sd: sd, cte90: cte90, semidev: semidevBelow(npvs, det), ddMed: pctile(dds, 50), ddWorst: pctile(dds, 10) }; }
    function cteShortfall(npvs, det, p) { var c = cteLow(npvs, p); return (det != null && isFinite(det) && c != null) ? (det - c) : null; }
    function cteShortfallScaled(npvs, det, p, factor) { if (det == null || !isFinite(det)) return null; var s = npvs.map(function (x) { return det + (x - det) * factor; }); var c = cteLow(s, p); return c != null ? (det - c) : null; }

    // ---- surplus note -> TAC adjustment (cumulative net cash flow) ----
    function applyNoteToSurplus(sc) {
      if (!S.surplusNote || !S.surplusNote.on) return sc;
      var ann = EFENG.surplusNoteAnnual(S.surplusNote);
      var cum = 0, cumByYear = {};
      for (var y = 2025; y <= 2055; y++) { cum += (ann[y] || 0); cumByYear[y] = cum; }
      Object.keys(sc).forEach(function (yk) {
        var y = +yk, d = sc[y]; if (!d) return;
        var adj = cumByYear[y] || 0;
        var newTac = d.tac + adj;
        d.tac = newTac; d.ratio = d.reqCap ? newTac / d.reqCap : d.ratio; d.noteAdj = adj;
      });
      return sc;
    }

    // ---- baseline (NEVER sees the growth schedule; anchors MODEL_CANON §1) ----
    function computeBaseline() {
      if (!S.ev || !S.ts || !S.surplus) return;
      S.ev2026 = { rows: S.ev.rows.filter(function (r) { return r.iy === '2026'; }), maxP: S.ev.maxP };
      var P = S.params.assum, ys = S.years.filter(function (y) { return y <= 2035; });
      var vnbs = {}, origFull = {};
      var vnb26 = {};
      PRODS.forEach(function (c) {
        vnbs[c] = { v: EFENG.buildVNB(S.ev, c, { assum: P }, { nMonths: 360 }), full: EFENG.buildVNB(S.ev, c, { assum: P }, { nMonths: 360, allBook: true, pnShift: false }) };
        vnbs[c].r = EFENG.vnbResults(vnbs[c].v, P.disc); origFull[c] = vnbs[c].full;
        vnb26[c] = EFENG.buildVNB(S.ev, c, { assum: P }, { nMonths: 360, iy: '2026' });
      });
      S.origLIF = {}; PRODS.forEach(function (c) { S.origLIF[c] = EFENG.evMonthly(S.ev, c, 'LivesInForce1'); });
      S.origClaims = {}; PRODS.forEach(function (c) { S.origClaims[c] = EFENG.evMonthly(S.ev, c, 'IncClaims'); });
      var sc = EFENG.surplusCalc(S.ts, S.surplus, S.params.ts_adj, ys);
      applyNoteToSurplus(sc);
      var minRBC = Math.min.apply(null, [2026, 2027, 2028, 2029, 2030].map(function (y) { return sc[y].ratio; }));
      var de = []; for (var y = 2026; y <= 2055; y++)de.push(PRODS.reduce(function (s, c) { return s + (vnbs[c].v.annual.DE[y] || 0); }, 0));
      var de26 = []; for (var y = 2026; y <= 2055; y++)de26.push(PRODS.reduce(function (s, c) { return s + (vnb26[c].annual.DE[y] || 0); }, 0));
      var npv26 = EFENG.npv(P.disc, de26), irr26b = EFENG.irr(de26);
      S.baseline = { vnbs: vnbs, vnb26: vnb26, origFull: origFull, surplusCalc: sc, minRBC: minRBC, portIRR: EFENG.irr(de), portNPV: EFENG.npv(P.disc, de), npv26: npv26, irr26: irr26b };
      return S.baseline;
    }

    // ---- scalars (FORWARD SALES GROWTH lives here) ----
    function mkScalars(sales, claims, lapse) {
      var base = S.params.scalars, upd = {};
      PRODS.forEach(function (c) {
        // Forward sales projection per scenario: 2026 is the sampled anchor (unchanged);
        // 2027..2035 compound by this product/year's growth rate, year over year.
        // An all-zero schedule reproduces the original flat projection (updSales = anchor
        // every year) byte-for-byte — that is Invariant 2. Growth is applied ONLY to these
        // sampled scenario draws, never to the baseline.
        var g = (S.growth && S.growth[c]) || {};
        var prev = sales[c];
        upd[PNAME[c]] = base.years.map(function (y, idx) {
          if (idx === 0) return prev;                       // 2026 anchor — never grown
          var rate = (g[y] != null && isFinite(g[y])) ? g[y] : 0;
          prev = prev * (1 + rate);
          return prev;
        });
      });
      var cl = {}, lp = {}; PRODS.forEach(function (c) { cl[PNAME[c]] = claims[c]; lp[PNAME[c]] = lapse[c]; });
      // override origSales with per-year UI values where set; else fall back to the
      // workbook's per-year original-sales anchor for that SAME year (by index).
      var origSalesOverride = {};
      PRODS.forEach(function (c) {
        origSalesOverride[PNAME[c]] = base.years.map(function (y, idx) {
          var ui = S.origSales[c][y];
          if (ui != null && isFinite(ui)) return ui;
          var anchor = (base.origSales[PNAME[c]] || [])[idx];
          return (anchor != null && isFinite(anchor)) ? anchor : base.origSales[PNAME[c]][0];
        });
      });
      return { years: base.years, origSales: origSalesOverride, updSales: upd, claims: cl, lapse: lp };
    }

    function buildScen(sales, claims, lapse) {
      var P = S.params.assum, sc = mkScalars(sales, claims, lapse);
      var rec = EFENG.recalcEV(S.ev, sc), recNB = {}, recFull = {}, recLIF = {};
      var recClaims = {}; PRODS.forEach(function (c) { recNB[c] = EFENG.buildVNB(rec, c, { assum: P }, { nMonths: 360 }); recFull[c] = EFENG.buildVNB(rec, c, { assum: P }, { nMonths: 360, allBook: true, pnShift: false }); recLIF[c] = EFENG.evMonthly(rec, c, 'LivesInForce1'); recClaims[c] = EFENG.evMonthly(rec, c, 'IncClaims'); });
      var baseSc = S.baseline.surplusCalc, ys = S.years.filter(function (y) { return y <= 2035; }), sr = {};
      ys.forEach(function (y) {
        var prod = {};
        Object.keys(baseSc[y].prod).forEach(function (pname) { var code = pname === 'PreNeed' ? 'PN' : pname === 'Hospital Indemnity' ? 'HI' : 'MS'; var vi = (y - 2025) * 12; var oL = S.origLIF[code][vi] || 0, rL = recLIF[code] ? (recLIF[code][vi] || 0) : 0, inf = y === 2025 || Math.abs(oL) < 1e-9 ? 1 : rL / oL; var oC = (S.origClaims[code] && S.origClaims[code][vi]) || 0, rC = (recClaims[code] && recClaims[code][vi]) || 0, infC = y === 2025 || Math.abs(oC) < 1e-9 ? 1 : rC / oC; prod[pname] = {}; EFENG.TSC_KEYS.forEach(function (k) { prod[pname][k] = baseSc[y].prod[pname][k] * (k === 'TSC2' ? infC : inf); }); });
        var tot = {}; EFENG.TSC_KEYS.forEach(function (k) { tot[k] = Object.values(prod).reduce(function (s, p) { return s + p[k]; }, 0) + baseSc[y].allOther[k]; });
        var T = tot, pc = T.TSC0 + T.TSC4a + Math.sqrt(Math.pow(T.TSC1 + T.TSLR016 + T.TSC3, 2) + T.TSC1CS * T.TSC1CS + T.TSC2 * T.TSC2 + T.TSC4b * T.TSC4b), rq = pc * 1.03;
        var dy = y; var dMS = (recFull.MS.annual.ATI[dy] || 0) - (S.baseline.origFull.MS.annual.ATI[dy] || 0), dPN = (recFull.PN.annual.ATI[dy] || 0) - (S.baseline.origFull.PN.annual.ATI[dy] || 0), dHI = (recFull.HI.annual.ATI[dy] || 0) - (S.baseline.origFull.HI.annual.ATI[dy] || 0);
        var id = dMS + dPN + dHI, bt = S.surplus.totalSurplus[y] - S.surplus.nonIns[y] + S.surplus.avr[y], tac = bt + id;
        sr[y] = { prod: prod, allOther: baseSc[y].allOther, tot: tot, postCov: pc, reqCap: rq, tac: tac, ratio: tac / rq, incDelta: id, baseRatio: baseSc[y].ratio };
      });
      applyNoteToSurplus(sr);
      var de = {}, cumDE = {}, cum = 0; for (var y = 2026; y <= 2055; y++) { de[y] = PRODS.reduce(function (s, c) { return s + (recNB[c].annual.DE[y] || 0); }, 0); cum += de[y]; cumDE[y] = cum; }
      var deStream = []; for (var y = 2026; y <= 2055; y++)deStream.push(de[y]);
      var portIRR = EFENG.irr(deStream), portNPV = EFENG.npv(P.disc, deStream);

      var rec26 = {}; PRODS.forEach(function (c) { rec26[c] = EFENG.buildVNB(rec, c, { assum: P }, { nMonths: 360, iy: '2026' }); });
      var de26 = {}, cumDE26 = {}, cum26 = 0; for (var y = 2026; y <= 2055; y++) { de26[y] = PRODS.reduce(function (s, c) { return s + (rec26[c].annual.DE[y] || 0); }, 0); cum26 += de26[y]; cumDE26[y] = cum26; }
      var deStream26 = []; for (var y = 2026; y <= 2055; y++)deStream26.push(de26[y]);
      var irr26 = EFENG.irr(deStream26), npv26 = EFENG.npv(P.disc, deStream26);
      var cumDE26PosYr = null; for (var y = 2026; y <= 2055; y++) { if (cumDE26[y] > 0) { cumDE26PosYr = y; break; } }
      var de26PosYr = null; for (var y = 2026; y <= 2055; y++) { if (de26[y] > 0) { de26PosYr = y; break; } }

      var minRBC = Math.min.apply(null, [2026, 2027, 2028, 2029, 2030].map(function (y) { return sr[y] ? sr[y].ratio : 0; }));
      var tacChg = {};[2026, 2027, 2028, 2029, 2030, 2031, 2032, 2033, 2034, 2035].forEach(function (y) { var a = sr[y - 1] ? sr[y - 1].tac : (y === 2026 ? (S.surplus.totalSurplus[2025] - S.surplus.nonIns[2025] + S.surplus.avr[2025]) : 0), b = sr[y] ? sr[y].tac : 0; tacChg[y] = (a && isFinite(a) && a !== 0) ? (b - a) / a : 0; });
      var atiBopCS = {};[2026, 2027, 2028, 2029, 2030, 2031, 2032, 2033, 2034, 2035].forEach(function (y) { var ati = PRODS.reduce(function (s, c) { return s + (recFull[c].annual.ATI[y] || 0); }, 0), pt = sr[y - 1] ? sr[y - 1].tac : 0; atiBopCS[y] = pt ? ati / pt : 0; });
      var maxDecline = 0;[2027, 2028, 2029, 2030, 2031, 2032, 2033, 2034, 2035].forEach(function (y) { var a = sr[y - 1], b = sr[y]; if (a && b && a.tac > 0) maxDecline = Math.max(maxDecline, (a.tac - b.tac) / a.tac); });
      var tot2 = sales.MS + sales.PN + sales.HI, wtdIRR = (sales.MS * S.hurdles.MS + sales.PN * S.hurdles.PN + sales.HI * S.hurdles.HI) / tot2;
      return {
        portIRR: portIRR, portNPV: portNPV, wtdIRR: wtdIRR, minRBC: minRBC, de: de, cumDE: cumDE, atiBopCS: atiBopCS, maxDecline: maxDecline, tacChg: tacChg,
        irr26: irr26, npv26: npv26, de26: de26, cumDE26: cumDE26, de26PosYr: de26PosYr, cumDE26PosYr: cumDE26PosYr,
        surplus: sr, recNB: recNB, recFull: recFull, recLIF: recLIF, scalars: sc
      };
    }

    function stochMetrics(sales, claims, lapse) {
      var P = S.params.assum, sc = mkScalars(sales, claims, lapse), rec = EFENG.recalcEV(S.ev2026 || S.ev, sc), de = [];
      PRODS.forEach(function (c) { var v = EFENG.buildVNB(rec, c, { assum: P }, { nMonths: 360, iy: '2026' }); for (var y = 2026; y <= 2055; y++) { de[y - 2026] = (de[y - 2026] || 0) + (v.annual.DE[y] || 0); } });
      var cum = 0, dd = 0; for (var t = 0; t < de.length; t++) { cum += (de[t] || 0); if (cum < dd) dd = cum; }
      return { irr: EFENG.irr(de), npv: EFENG.npv(P.disc, de), dd: dd };
    }

    function evalCons(m, stochR) {
      var c = S.cons, f = [];
      function lbl(n, code, det, full) { return { code: code, num: n, label: full || ('Constraint ' + n), detail: det }; }
      if (m.minRBC < c.rbcFloor) f.push(lbl(1, 'RBC_FLOOR', 'min RBC ' + rx(m.minRBC) + ' < floor ' + rx(c.rbcFloor), 'C1: Min RBC ≥ ' + rx(c.rbcFloor)));
      var minTacChg = Math.min.apply(null, Object.values(m.tacChg));
      if (minTacChg < c.tacChgFloor) f.push(lbl(2, 'TAC_CHG', 'min ΔTAC/BOP TAC ' + pct(minTacChg) + ' < floor ' + pct(c.tacChgFloor), 'C2: ΔTAC/BOP TAC ≥ ' + pct(c.tacChgFloor)));
      if (c.irr3on && m.irr26 != null && m.irr26 < m.wtdIRR) f.push(lbl(3, 'IRR_TARGET', '2026-issue IRR ' + pct(m.irr26) + ' < target ' + pct(m.wtdIRR), 'C3: 2026-issue IRR ≥ weighted target'));
      if (stochR && stochR.irrs && stochR.irrs.length) { var bl = stochR.irrs.filter(function (x) { return x != null && x < c.irrA; }).length, prob = bl / stochR.irrs.length; if (prob > c.irrB) f.push(lbl(4, 'IRR_TAIL', 'P(2026-issue IRR<' + pct(c.irrA) + ')=' + pct(prob) + ' > ' + pct(c.irrB), 'C4: 2026-issue IRR tail risk')); }
      var dy = 2025 + c.deYr; if ((m.de26[dy] || 0) <= 0) f.push(lbl(5, 'DE_BY_YEAR', '2026-issue DE yr ' + c.deYr + ' (' + dy + ')=' + fmt(m.de26[dy] || 0, 2), 'C5: 2026-issue DE > 0 by yr ' + c.deYr));
      var cy = 2025 + c.cumDeYr; if ((m.cumDE26[cy] || 0) <= 0) f.push(lbl(6, 'CUMDE_BY_YEAR', '2026-issue CumDE yr ' + c.cumDeYr + ' (' + cy + ')=' + fmt(m.cumDE26[cy] || 0, 2), 'C6: 2026-issue CumDE > 0 by yr ' + c.cumDeYr));
      var minCumDE26 = Math.min.apply(null, Object.values(m.cumDE26)); if (c.cumDEFloor != null && minCumDE26 < c.cumDEFloor) f.push(lbl('CF', 'CUMDE_FLOOR', 'min 2026-issue cumDE $' + fmt(minCumDE26, 1) + 'M < floor $' + fmt(c.cumDEFloor, 1) + 'M', 'CumDE floor ≥ $' + fmt(c.cumDEFloor, 1) + 'M'));
      if (c.de1Floor != null && (m.de26[2026] || 0) < c.de1Floor) f.push(lbl('D1', 'DE1_FLOOR', '2026 (year-1) DE $' + fmt(m.de26[2026] || 0, 1) + 'M < floor $' + fmt(c.de1Floor, 1) + 'M', 'Year-1 DE floor ≥ $' + fmt(c.de1Floor, 1) + 'M'));
      return f;
    }
    function markFrontier(arr) { var feas = arr.filter(function (s) { return s.feasible && s.portNPV != null && isFinite(s.portNPV); }); feas.forEach(function (s) { s.isFrontier = !feas.some(function (o) { return o !== s && o.portNPV >= s.portNPV && o.risk <= s.risk && (o.portNPV > s.portNPV || o.risk < s.risk); }); }); }
    function frontierSetBy(riskFn) {
      var feas = S.results.filter(function (s) { return !s.isCustom && s.feasible && isFinite(s.portNPV) && isFinite(riskFn(s)); });
      var set = {};
      feas.forEach(function (s) { var dom = feas.some(function (o) { return o !== s && o.portNPV >= s.portNPV && riskFn(o) <= riskFn(s) && (o.portNPV > s.portNPV || riskFn(o) < riskFn(s)); }); if (!dom) set[s.id] = true; });
      return set;
    }

    return {
      setSeed: setSeed, mulberry32: mulberry32, nrand: nrand, lhs: lhs, nvec: nvec,
      buildShockBank: buildShockBank, shockFromBank: shockFromBank,
      pctile: pctile, stddev: stddev, cteLow: cteLow, semidevBelow: semidevBelow,
      downsideRisk: downsideRisk, cteShortfall: cteShortfall, cteShortfallScaled: cteShortfallScaled,
      applyNoteToSurplus: applyNoteToSurplus, computeBaseline: computeBaseline, mkScalars: mkScalars, buildScen: buildScen,
      stochMetrics: stochMetrics, evalCons: evalCons, markFrontier: markFrontier, frontierSetBy: frontierSetBy,
      STOCH_SEED: STOCH_SEED, NYEARS: NYEARS, fmt: fmt, pct: pct, rx: rx
    };
  }

  return { create: create };
});
```
