# Actuarial Review Plan — Capital Deployment / Efficient Frontier Model

**Audience:** Wellabe actuarial reviewers
**Owner:** Matt Johnson
**Model under review:** EfficientFrontier2 (browser viewer on GitHub Pages)
**Reference Excel:** `EffFrontierEngine_V2Slim_Final_4.xlsx` (VNB / Surplus Calc / Surplus Recalc /
Dynamic Validation sheets) and the MS reinsurance workbook `MS_Reins_Projection_04302026Slim.xlsx`.

---

## 0. Purpose & how to use this document

This is a staged plan to **independently validate** the online efficient-frontier model against the
existing Excel model. The review proceeds in five phases; **do not advance to the next phase until the
current one is signed off**:

| Phase | What it proves | Note | Reins |
|---|---|---|---|
| **1 — Base engine** | VNB + RBC mechanics tie to Excel with no overlays | OFF | OFF |
| **2 — Surplus note** | The note cash flows feed TAC correctly | ON | OFF |
| **3 — Reinsurance** | The MS quota-share overlay is correct | ON | ON |
| **4 — Data refresh** | Re-tie after loading newer VNB data | ON | ON |
| **5 — 2027 refocus** | (Future code change) lock 2026, optimize 2027–2030 | — | — |

**Working style.** All hands-on validation is done in the **browser viewer + Excel**: toggle a setting,
**Run**, **Export scalars**, paste into the workbook, recalculate, and compare. Each phase has a
**formula walk** (read and agree the Excel logic) and a **numeric tie-out** (paste-and-compare), and ends
with a sign-off row in **Appendix E**.

> The engineering team also maintains two automated regression gates — `node runner/validate.js` (the
> §1 VNB/RBC anchor) and `node runner/reins-tieout.js` (the reinsurance anchor). Reviewers do **not** need
> Node; those gates are cited here only as the source of the target numbers in Appendices A–B.

---

## 1. Model map — what ties to what

| Model piece | Online location | Ties to (Excel) |
|---|---|---|
| **VNB by product** (monthly DE → IRR/PVDE per cohort) | VNB by Product tab; Debug §3 | VNB workbook / `VNB Recalc` sheet |
| **EV recalc** (sales scalar, two-regime in-force roll-forward) | Debug §1–§2 | `EV Recalc` sheet |
| **RBC charges & required capital** (NAIC covariance) | RBC & Surplus tab; Debug §4 | `Surplus Calc` (baseline), `Surplus Recalc` (scenario) |
| **TAC roll-forward** | RBC & Surplus tab | `Surplus Calc` / `Surplus Recalc` row 50 |
| **Surplus note** | Config §5 toggle | note schedule → TAC only |
| **Reinsurance (MS quota share)** | Config §6 toggle | `MS_Reins_Projection_04302026Slim.xlsx` (transitive) |
| **Input data** | Config tab uploads | `Input EV` / `Input TS` / `Input Surplus` sheets → `data/*.csv` |

The model's `data/InputEV.csv`, `data/InputTS.csv`, `data/InputSurplus.csv`, and `data/params.json` were
generated from `EffFrontierEngine_V2Slim_Final_4.xlsx`. **The current data ties to the 2026 Round 2 plan.**

---

## 2. Environment & tools

### 2.1 Open the model
Open the model's GitHub Pages URL (Matt will provide) and enter the access password. The landing page
forwards to the viewer. (The password gate is light obfuscation only; treat the site as internal.)

### 2.2 Config tab — the controls you will use
- **§5 Surplus Note** — checkbox **"Enabled"** (`sn_on`). Default **ON**: amount **$150M**, tenor **10 yr**,
  rate **9%**, upfront fee **3%**, investment income **4%**, start **2026-06-30**.
- **§6 Reinsurance — MS Quota Share** — checkbox **"Enabled"** (`ri_on`). Default **ON**: **10%** cede every
  issue year, **1-yr** cession lag, **10-5-5** upfront ceding commission ($M, 2026/27/28), sliding-scale
  ongoing commission by MS loss ratio.
- **Sales bounds & growth band** — the 2026 starting-level bounds per product and the per-year growth band
  `[min, target]`. *(Not central to validation; leave at defaults unless reproducing a specific scenario.)*
- **Seed** — fix it (do not Randomize) so scenarios are reproducible across runs and exports.

### 2.3 The two export buttons
- **RBC & Surplus tab → "Export scalars"** — the core tie-out artifact. For the **selected scenario** and
  **selected run** it writes a CSV laid out **cell-for-cell for the workbook `Scalars` sheet**, plus the
  online RBC the workbook should reproduce. See §2.4.
- **Efficient Frontier tab → "Results CSV"** — one row per scenario (sales, PVDE, downside, IRR, min RBC,
  feasibility, frontier flag, failure codes). Use it for a portfolio-level overview, not formula tie-out.

### 2.4 What "Export scalars" contains (and where each piece pastes)
Run the frontier, pick a non-Baseline scenario in the **SCENARIO** dropdown, choose a run in the
**SENSITIVITY RUN** dropdown (use **Deterministic** for tie-out — all stochastic multipliers = 1.0), then
click **Export scalars**. The CSV has a header line (scenario id, MS/PN/HI sales path, run label, seed) and:

| Exported rows | Paste into `Scalars!` | Meaning |
|---|---|---|
| Sales scalar MS / PN / HI | `C12:L14` | updated ÷ original sales by issue year 2026–2035 |
| Claims systematic MS/PN/HI | `C17 / C18 / C19` | one multiplier per product (1.0 deterministic) |
| Term systematic MS/PN/HI | `C22 / C23 / C24` | "" |
| NIER systematic PN | `C26` | PN-only additive bps (0 deterministic) |
| Claims process MS/PN/HI | `C29:AF31` | per-year 2026–2055 (all 1.0 deterministic) |
| Term process MS/PN/HI | `C34:AF36` | "" |
| NIER process PN | `C39:AF39` | "" |
| **ONLINE EXPECTED TARGETS** | compare, don't paste | RBC ratio **no-note** (Surplus Recalc **row 52**), **w/ note** (**row 54**), TAC (**row 50**), required capital (**row 48**), years 2026–2030 |

**Tie-out is:** paste the scalar values → recalc the workbook → confirm `Surplus Recalc` rows 48/50/52/54
match the exported "ONLINE EXPECTED TARGETS" for 2026–2030.

### 2.5 The Debug tab (drill-down when something doesn't tie)
Five collapsible sections for the selected scenario/run: **§1 Sales Levels & Scalars**, **§2 In-Force &
Lives-Issued trace**, **§3 Income Comparison** (per product × cohort: Premium, NII, Claims, Other benefits,
PTI, ATI, ΔTS, DE — original vs recalc), **§4 RBC Charge Walk** (TSC charges → post-covariance → required
capital → TAC → ratio, baseline vs scenario), **§5 Constraint Status** (C1–C9 pass/fail). Use these to
localize any mismatch to a specific line, year, or cohort.

---

## 3. Phase 1 — Base engine (surplus note OFF, reinsurance OFF)

**Goal:** confirm the VNB and RBC engines reproduce the Excel with no overlays.

### 3.1 Set up
1. Config tab → **uncheck §5 "Enabled"** (`sn_on`) and **uncheck §6 "Enabled"** (`ri_on`).
2. Fix the seed.
3. Go to Efficient Frontier tab → **Run**.

### 3.2 Baseline tie-out (no scenario)
On the RBC & Surplus tab (Baseline selected), confirm the **baseline** numbers reproduce the §1 anchor and
your `Surplus Calc` / VNB workbook:

- **VNB IRR / PVDE** per product — Appendix A.
- **Baseline RBC ratios 2026–2030 (no note, no treaty)** = **5.67 / 5.15 / 4.35 / 4.27 / 4.72** (min 4.27 in
  2029). These should equal your `Surplus Calc` ratios.

### 3.3 Scenario tie-out (Export scalars → Excel)
1. Pick any feasible scenario; **SENSITIVITY RUN = Deterministic**; **Export scalars**.
2. Paste the scalar ranges into `Scalars!` per §2.4.
3. Recalc the workbook; compare `Surplus Recalc` rows 48/50/52/54 (2026–2030) to the exported targets.
   With the note OFF, **row 52 (no-note) and row 54 (w/ note) should be equal**.

### 3.4 Formula walk (agree the logic; tie to Dynamic Validation + VNB workbooks)
Walk and initial each block:

- **VNB income statement** (`VNB Recalc`): Premium = EarnedPrem − ReinsPrem; NII = mid-period assets ×
  monthly earned rate; Claims = IncClaims − ReinsClaims; Other benefits (Δ tabular reserve, Δ loading);
  Commission & premium tax scale with premium; Acquisition = lives issued × per-life cost (inflated);
  Maintenance = lives in-force × per-policy cost ÷ 12; PTI → Tax → ATI; ΔTS; **DE = ATI + ΔTS**. Confirm
  **IRR** (multi-root solver, Excel-IRR convention) and **PVDE** at the configured discount rate.
- **EV recalc** (`EV Recalc`): sales scalar `ss(Y) = updatedSales(Y) / originalSales(Y)`; two-regime
  lives roll-forward (build regime proportional; persistency regime rolling year-over-year); dollars
  rescale per surviving life; claims also carry the claims scalar.
- **RBC** (`Surplus Calc`): post-covariance
  `TSC0 + TSC4a + √((TSC1+TSLR016+TSC3)² + TSC1CS² + TSC2² + TSC4b²)`; required capital × 1.03; **TSC2 scales
  by the incurred-claims ratio, all other charges by the lives-in-force ratio**; TAC cumulative roll-forward
  (pre-tax delta in the seed year and in any year baseline TAC declined, else after-tax).

### 3.5 Phase 1 acceptance
- [ ] Baseline VNB IRR/PVDE match Appendix A.
- [ ] Baseline RBC 2026–2030 = 5.67 / 5.15 / 4.35 / 4.27 / 4.72.
- [ ] Selected scenario's `Surplus Recalc` rows 48/50/52/54 reproduce the exported targets (no-note = w/note).
- [ ] Reviewer agrees with all VNB / EV-recalc / RBC formulas. → **Sign off (Appendix E).**

---

## 4. Phase 2 — Surplus note ON

**Goal:** confirm the note feeds TAC correctly and nothing else.

1. Config §5 → **check "Enabled"**; leave reinsurance OFF. Re-Run.
2. Export scalars for the same scenario/seed. Now the **w/ note** target (row 54) diverges from **no-note**
   (row 52) by the note's TAC contribution.
3. **Formula walk** the note schedule in Excel: proceeds **− upfront fee** at start; **monthly investment
   income** on proceeds at the note rate (issue → maturity); **quarterly coupon** (¼ of the annual rate
   every three months, including the maturity quarter); **principal repaid at maturity**. The net cash flow
   accumulates **into TAC only** — required capital and all charges are unchanged, so the RBC ratio is just
   re-derived from note-adjusted TAC.
4. Confirm: row 52 (no-note) is **unchanged from Phase 1**, row 54 (w/ note) matches the exported w/note
   targets, and the difference equals your note schedule's TAC effect by year.

**Phase 2 acceptance**
- [ ] No-note RBC unchanged vs Phase 1. - [ ] W/ note RBC matches export. - [ ] Note formulas agreed.
→ **Sign off (Appendix E).**

---

## 5. Phase 3 — Reinsurance ON (MS quota share)

**Goal:** confirm the MS quota-share overlay (retained EV, scaled charges, commissions, surplus flow).

1. Config §6 → **check "Enabled"** (keep the note ON). Re-Run.
2. **Formula walk** the cession (this overlay lives in the engine, not the `Scalars` sheet, so tie it to the
   reinsurance workbook `MS_Reins_Projection_04302026Slim.xlsx`):
   - **Retained MS EV** = gross MS EV × (1 − cede), with a **1-year cession lag** (the just-issued cohort is
     not ceded until the next year). **PN and HI are never ceded.**
   - **MS RBC charges** scale by the retained share (premium-related charges by the lives ratio, claims
     charge TSC2 by the claims ratio; TSC4a/4b untouched).
   - **Ceding commissions:** upfront **10-5-5** ($M, 2026/27/28) + ongoing **sliding scale** by MS loss-ratio
     band ($250 / $200 / $150 / $100 per policy/yr across <75% / 75–85% / 85–95% / ≥95%).
   - **After-tax surplus flow** (commissions − ceded profit) into TAC, computed once on the baseline and
     inherited by every scenario (the cession is never re-applied per scenario).
3. **Numeric anchor (Appendix B):** the engine's **net (treaty) RBC for 2026–2030** ties to the
   Excel-validated BlockbusterDeals model. For the validation deal (10% cede, flat $200 ongoing, no note)
   the net RBC 2026–2030 = **6.040 / 5.688 / 4.928 / 4.800 / 5.193** (predeal = §1 = 5.674 / 5.148 / 4.351 /
   4.273 / 4.723). Post-2030 run-off is a documented, out-of-window divergence — not gated.

**Phase 3 acceptance**
- [ ] Retained-EV, charge-scaling, commission, and surplus-flow formulas agreed.
- [ ] Net RBC 2026–2030 ties to the reinsurance workbook / Appendix B anchor. → **Sign off (Appendix E).**

---

## 6. Phase 4 — Refresh to newer VNB data

**Goal:** move off the **2026 Round 2 plan** data to the newer VNB and re-tie.

> **Open item to investigate:** in the current data the **MS IRRs rise and the PN IRRs fall** across issue
> years. These tie to the 2026 Round 2 plan but may not be right going forward — confirm the pattern against
> the newer VNB during this refresh and flag if it is an input artifact.

1. Export the new **Input EV / Input TS / Input Surplus** ranges from the updated workbook to CSV (the Config
   tab has **"Download template"** buttons showing the exact column layout to match).
2. Config tab → upload via **`fEV` / `fTS` / `fSurp`**; the source tag updates and the baseline recomputes.
3. **Re-run the Phase 1–3 tie-outs** on the new data (baseline VNB/RBC, scenario Export-scalars, note, reins).
4. **`params.json`** (economic assumptions, original-sales anchors, NIER schedules) is **not** uploadable in
   the browser — if assumptions change it must be edited in `data/params.json` and the page reloaded. **Flag
   to engineering who owns that edit.** If the data move is intended to be permanent, the §1 anchor numbers
   (Appendix A) and the `validate.js` gate should be re-baselined to the new workbook.

**Phase 4 acceptance**
- [ ] New data uploaded; baseline re-ties. - [ ] Scenario/note/reins re-tie. - [ ] MS/PN IRR trend reviewed.
→ **Sign off (Appendix E).**

---

## 7. Phase 5 — Refocus to 2027 first year (FUTURE — requires a code change)

**Goal:** treat everything **through 2026 year-end as locked / factual**, load the **Round 1 plan**, and
optimize **2027–2030**. This is **not** a configuration toggle — it is a model/code change. This section is
the spec for the engineering team and the acceptance criteria for the reviewers.

**Intended behavior**
- 2026 sales become a **fixed, known cohort** (the locked actual / Round 1 2026), not a sampled decision.
- **2027 becomes the first sampled decision year**; growth is drawn for 2028–2030.
- The optimization **objective and per-cohort constraints cover 2027–2030 only**; 2026 still contributes to
  the full-book RBC/TAC roll-forward (it is known, not gated).

**Engineering touchpoints** (for implementation, not for the reviewer to action)
- `src/vnb.js`: add an **`iyMin`** filter (mirror the existing `iyMax`) so the program objective can be
  restricted to issue years ≥ 2027 (`recNB` built with `iyMin: 2027, iyMax: 2030`).
- `src/frontier.js → runSweep`: make 2026 a fixed cohort; sample the **2027** level; shift growth draws to
  2028–2030; adjust `mkPath` and the `repairGrowth` year order; move the per-cohort C5–C8 loop and the
  min-RBC window to **2027–2030**.
- `computeBaseline` and the **§1 validation gate are unchanged** (the baseline never reads growth), so the
  Appendix A anchors must still reproduce exactly — this should be an additive, opt-in pathway.
- Viewer Config: relabel the bounds to **2027** and add the locked-2026 input(s).

**Phase 5 acceptance**
- [ ] §1 anchors (Appendix A) still reproduce (gate green).
- [ ] 2026 is fixed and excluded from the objective and per-cohort constraints; 2027–2030 optimized.
- [ ] Round 1 plan data loaded and re-tied to Excel (repeat Phases 1–3). → **Sign off (Appendix E).**

---

## Appendix A — §1 validated targets (no note, no treaty)

Standalone VNB basis (these are what Phase 1 must reproduce; source: `MODEL_CANON.md §1`,
machine-checked by `node runner/validate.js`):

| Metric | Target |
|---|---|
| MS VNB IRR / PVDE | `0.21938929` / `$633.23M` |
| PN VNB IRR / PVDE | `0.10667571` / `$33.553M` |
| HI VNB IRR / PVDE | `0.17163078` / `$29.458M` |
| MS recalc IRR (under workbook scalars) | `0.17763524` |
| Baseline RBC 2026 / 27 / 28 / 29 / 30 | `5.67 / 5.15 / 4.35 / 4.27 / 4.72` (min 4.27 @ 2029) |

---

## Appendix B — §10 reinsurance tie-out anchor

Transitive tie: EfficientFrontier2 → BlockbusterDeals (`src/engine.py`) → Excel
`MS_Reins_Projection_04302026Slim.xlsx`. Validation deal: 10% quota-share on issue years ≤ 2030, 1-yr lag,
10-5-5 upfront, **flat $200/policy/yr** ongoing, **note OFF**. Source: `MODEL_CANON.md §10`,
machine-checked by `node runner/reins-tieout.js`.

| Year | Predeal RBC (= §1) | Net RBC @ 10% (anchor) |
|---|---|---|
| 2026 | 5.674 | **6.040** |
| 2027 | 5.148 | **5.688** |
| 2028 | 4.351 | **4.928** |
| 2029 | 4.273 | **4.800** |
| 2030 | 4.723 | **5.193** |

Upfront ceding commissions tie exactly (10 / 5 / 5 $M). Net RBC for 2031–2034 drifts above BBD by
+0.12 → +0.18 — a documented run-off-tail divergence **outside** the 2026–2030 decision window; not gated.

---

## Appendix C — Config defaults & where they live

Defaults are mirrored in three places that engineering keeps in sync: `viewer/index.html` (form inputs),
`viewer/app.js` (the `S` state init), and `runner/defaults.js` (headless runner).

- **Surplus note (`sn_on`, default ON):** $150M, 10-yr, 9% rate, 3% fee, 4% investment income, 2026-06-30.
- **Reinsurance (`ri_on`, default ON):** 10% cede all issue years, 1-yr lag, 10-5-5 upfront, sliding-scale
  ongoing ($250/$200/$150/$100 per policy/yr by loss-ratio band).
- **Data uploads:** `fEV` / `fTS` / `fSurp` (CSV); `data/params.json` is file-edit only.

---

## Appendix D — Glossary

- **VNB** — value of new business (PV of distributable earnings on newly issued cohorts).
- **DE** — distributable earnings = after-tax income + change in target surplus.
- **PVDE** — present value of the DE stream at the discount rate; **IRR** solves NPV(DE) = 0.
- **TAC** — total adjusted capital; **RBC ratio** = TAC ÷ required capital.
- **NIER** — net investment earned rate (Preneed's dominant risk; modeled as an additive bps shock).
- **Cede / retained EV** — the share of MS reinsured / the share kept (gross × (1 − cede), 1-yr lag).
- **CTE-90** — conditional tail expectation; the risk axis is the CTE-90 PVDE shortfall vs the plan.
- **Program (2026–2030)** — the multi-year new-business window the frontier optimizes and constrains.

---

## Appendix E — Sign-off log

| Phase | Reviewer | Date | Result (Pass / Fail / Notes) |
|---|---|---|---|
| 1 — Base engine (note OFF, reins OFF) | | | |
| 2 — Surplus note ON | | | |
| 3 — Reinsurance ON | | | |
| 4 — Newer VNB data | | | |
| 5 — 2027 refocus (post code change) | | | |
