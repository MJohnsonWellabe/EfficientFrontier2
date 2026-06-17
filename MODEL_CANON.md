# MODEL CANON — Capital Deployment / Efficient Frontier

**Purpose.** This is the single source of truth for the model's validated behavior. Any session (Claude Code, a Project, a teammate) reads this first. **Nothing here is changed casually** — these are values you reconciled to machine precision against the source workbook (`EffFrontierEngine`). If a code change alters any of these, the change is wrong until proven otherwise.

> Status note: the numbers and mechanics below are captured from your build sessions. Treat this file as *yours* — confirm each item against your workbook on first use and correct anything I transcribed imperfectly. The two items I could **not** fully capture are flagged `⚠ CONFIRM`.

---

## 1. Validated targets (the regression gate)

Standalone VNB basis (`buildVNB` with the default, full-data month width; PN acq/maint +1 shift active):

| Product | VNB IRR | VNB NPV |
|---|---|---|
| Medicare Supplement (MS) | `0.21938929` | `$633.23M` |
| Preneed (PN) | `0.10667571` | `$33.553M` |
| Hospital Indemnity (HI) | `0.17163078` | `$29.458M` |

MS recalc IRR under workbook scalars: `0.17763524`

Baseline RBC ratios, 2026–2030: `5.67 / 5.15 / 4.35 / 4.27 / 4.72` (minimum `4.27` in **2029**).

> **Re-baseline note (2026-06-15c).** RBC ratios moved from `5.23 / 4.34 / 3.36 / 3.18 / 3.58` to mirror **`EffFrontierEngine_V2Slim_Final_4`**: a refresh of the **Input TS** charge amounts (378 cells) and **Input Surplus** Total Surplus (2026–2035), regenerated into `data/InputTS.csv` / `data/InputSurplus.csv`. VNB IRR/NPV and MS recalc IRR unchanged. The baseline minimum is now `4.27` (2029) — back above the §2 **C1** floor (≥ 4.0×). (That workbook revision also changed the Surplus-Recalc TAC roll-forward formula — tracked separately; the engine's scenario-TAC logic is unchanged pending confirmation.)

> **Re-baseline note (2026-06-15b).** RBC ratios moved from `5.14 / 4.28 / 3.32 / 3.15 / 3.54` to mirror **`EffFrontierEngine_V2Slim_Final_1`**: a per-year **PN C-1 swap** (move `$M` from C-1o/`TSC1` to C-1cs/`TSC1CS`, `data/params.json` `ts_adj.c1Swap`, applied in `surplusCalc` allOther; the recalc inherits via `baseSc.allOther`) shifts the covariance and lifts the ratios slightly. The same workbook revision also moved the **surplus note to quarterly coupons** (`surplusNoteAnnual`) — note-adjusted TAC only, **no §1 effect** (the gate is no-note). VNB IRR/NPV and MS recalc IRR unchanged. Baseline min (`3.18`) is still below the §2 **C1** floor (≥ 4.0×).

> **Re-baseline note (2026-06-15).** The five RBC ratios were re-baselined from `5.36 / 4.67 / 3.80 / 3.76 / 4.33` to mirror the **`EffFrontierEngine_V2Slim_Final`** workbook: (a) the NAIC **×0.5 factor on the C-3 (TSC3) charge was removed** (`src/rbc-surplus.js`), so C-3 is now charged in full; and (b) **Input TS** (RBC charge amounts) and **Input Surplus** (Total Surplus, 2026–2035) were rebased from the workbook (`data/InputTS.csv`, `data/InputSurplus.csv`). VNB IRR/NPV and the MS recalc IRR are **unchanged** (Input EV and new-business assumptions untouched). A separate **PN EV (back-book) NIER** schedule was also added (`data/params.json` `Preneed.NIER_EV`; `src/vnb.js`/`src/frontier.js`) — it feeds only the scenario EV-side TAC delta and moves no §1 target. **Note:** the new baseline minimum (`3.15`) is below the §2 **C1** floor (≥ 4.0×), so the unshocked baseline is now C1-infeasible — revisit the C1 threshold if that floor is still intended.

> **Refresh note (2026-06-13).** The **PN VNB** (`0.10667571 / $33.553M`) and the **MS recalc IRR** (`0.17763524`) were **re-derived from the current `EfficientFrontier-29.html` workbook** and replace the prior transcriptions `0.14688215 / $6.574M` and `0.17833333`, which were stale from an earlier dataset (PN's sales/in-force inputs in -29 differ materially). MS VNB, HI VNB, and all RBC ratios were already exact and are unchanged. All five numbers above now reproduce to full precision via `runner/validate.js`.

**Rule:** any engine edit must re-produce all of the above to full precision before it is "done." Run `node runner/validate.js` — it is the executable form of this gate. See `BUILD_STANDARDS.md` → Validation gate.

---

## 2. Directed mechanics (intentional design decisions)

These are choices you made deliberately. They are not up for "cleanup."

- **Persistency as a lapse-rate shock.** Shocked retention = `1 − (1 − base retention) × lapse_scalar`, bounded to `[0, 1]`, applied **from a policy's second year onward**.
- **Preneed mortality is a single coupled stochastic shock (2026-06-14).** Preneed is pre-funded, so a death is at once a claim, a reserve release, and a decrement — modeling a termination shock (or a gross-claims shock) alone is wrong. In `frontier.js → shockFromBank`, PN sets **`cm.PN === lm.PN`** from one mortality draw (PN's `claimsSD`/`claimsProcSD` *are* the mortality σ): claims rise, lives fall, and the per-life reserve rescale in `recalcEV` releases those lives' reserves — the strain netting to the **net amount at risk** (large for young business, shrinking as reserves build). PN therefore has **no separate lapse σ and no claims↔lapse ρ** (`procCorr.PN` retired; ρ = 1 by construction). This is **stochastic-path only** — `recalcEV`/`buildVNB` formulas are unchanged and the deterministic projection, the frontier scatter, and **§1** are untouched.
- **Preneed-only NIER (investment-yield) shock (2026-06-14)** — the dominant PN risk. An **additive basis-point level shift** on the earned rate (systematic + process), drawn in `shockFromBank` (`nm.PN`) and applied in `buildVNB` via `opts.nierShift` (`nier = assumLookup(...) + shift`). **Inert when not passed** (MS/HI and all deterministic/§1 paths), so §1 is unaffected. Defaults **35 bps systematic / 15 bps process** (see §6). The PN NIER bank draws are **appended after** the existing per-product draws so the MS/HI/claims/lapse RNG stream is bit-identical.
- **NIER cohort scoping → RBC only (2026-06-14).** The **stochastic risk axis stays 2026-issue** (NIER sys+proc on the 2026 cohort, unchanged). The **back-book NIER difference flows into the RBC/TAC** path via `buildScen(sales, claims, lapse, nier)`: when a stochastic *sensitivity run* is selected (RBC/Debug/VNB tabs), the full-book valuation (`recFull`) applies **process NIER to every issue year** (incl pre-2026 in-force) and **systematic NIER to 2026+ new business** — implemented as two `buildVNB` calls (new business `nb='N'` with sys+proc; pre-2026 `iy:'<2026'` with proc-only), merged. `buildScen` with **no `nier` arg is byte-identical** to before → the deterministic frontier scenarios, feasibility, and §1 are unchanged (NIER never enters the frontier loop or `stochMetrics`). NIER does **not** move feasibility — IRR_TAIL failures are MS/HI-driven (MS dominates the portfolio 2026-issue IRR); PN's own 2026-issue IRR stays well above the C4 floor.
- **Per-product IRR is scale-invariant.** Scaling a product's sales level does not change its IRR (verified bit-for-bit). Per-product IRR differences vs the workbook come from the scenario's sales **trajectory** (the growth schedule vs the workbook's per-year sales shape), not the recalc engine; the **portfolio** IRR also moves with the sales **mix**. (With default growth ≈ the workbook growth, HI reproduces the workbook IRR to ~0.001pp.) Surfaced in the Debug tab's per-product IRR section.
- **Preneed loading scales per life only** and does **not** respond to the claims shock.
- **Surplus TAC under a scenario uses full-book income deltas** (not new-business only): `MS after-tax income + PN after-tax income + HI distributable earnings`, with a **one-year-ahead offset**.
- **Required capital = PostCov × 1.03**, with **no** additional conservatism factor.
- **All-Other TS charges and the G2 / I2 manual add-ins are frozen** across all scenarios.

---

## 3. Intentional inconsistencies replicated from the source workbook

These look like bugs. They are not. They exist to match `EffFrontierEngine` exactly. **Do not "fix" them.**

- **PN acq/maint +1 month shift is disabled** in the stacked VNB layout (it is active only in the standalone display).
- **Charge-scaling month index advances one month per year**, not 12.
- **HI uses distributable earnings** (not after-tax income) for the TAC income delta.

---

## 4. Known corrections made *to* the workbook (do not re-introduce the originals)

Where the source workbook was genuinely wrong, you corrected it. These corrections are canonical:

- Inverted TS scaling formula in the 2026+ cohort recalc rows → corrected to direct `recalc / original` scaling.
- PN in-force was bypassing the persistency regime → corrected to use the same year-based build/persistency switch as MS and HI.
- Phantom terminal surplus release from the 360-vs-374-month grid difference → handled via tail pass-through logic.
- **Surplus-note maturity-year interest (2026-06-13).** `surplusNoteAnnual` was charging interest on *every* anniversary including maturity, so a 10-yr note paid 11 interest charges and the final year paid interest **and** principal. Corrected so the maturity year pays **principal only** (interest accrues on each anniversary from the start through the year before maturity). The frozen `legacy/EfficientFrontier-29.html` keeps the old behavior; this is a decomposed-engine correction. (Does not affect §1 — `validate.js` computes RBC without the note.)

---

## 5. Configuration defaults

- **Sales bounds:** MS `250–350`, PN `200–240`, HI `18–25` (updated 2026-06-13)
- **Hurdle rates:** MS `12%`, PN `10%`, HI `10%`
- **Stochastic grid:** `100` LHS scenarios × `100` stochastic runs
- **Constraints (Configuration-tab defaults, updated 2026-06-13):**
  - C1 — Min RBC ratio 2026–2030 ≥ **4.0×**
  - C2 — Min ΔTAC / BOP TAC ≥ **−12%** (every year)
  - C3 — 2026-issue IRR ≥ sales-weighted hurdle (**on**)
  - C4 — 2026-issue IRR tail: P(IRR < **8%**) ≤ **15%**
  - C5 — 2026-issue DE > 0 by **yr 4** (2029)
  - C6 — 2026-issue cumulative DE > 0 by **yr 10** (2035)
  - C7 — CumDE floor ≥ **−$180M**
  - C8 — Year-1 DE floor ≥ **−$150M**
  - C9 — Trough-RBC tail (**Slow mode only**): P(min RBC 2026–2030 < **350%**) ≤ **25%** across stochastic draws — the stochastic counterpart to C1, full-book/note-adjusted.
- **Run mode:** **Fast** (default) skips the trough-RBC tail (per-draw 2026-issue metrics only, ~1 min); **Slow** runs a full RBC recompute per stochastic draw to evaluate the trough-RBC tail (~4–5 min at 100×100).
- **Surplus note:** default **ON**, **$150M**, 10-yr tenor, 9% interest (quarterly coupon), 3% upfront fee, 4% investment income on proceeds, 2026-06-30 start.
  Because the note flows through TAC, the viewer's **displayed** baseline RBC is note-adjusted (above the
  §1 figures). **§1 RBC remains the no-note engine anchor** verified by `node runner/validate.js`.

---

## 6. Stochastic σ assumptions — OPEN ITEM

The per-product σ for claims and lapse currently driving the stochastic engine are **assumed**, not empirical. This is the open thread: deriving them from seriatim **aggregate A/E ratio** distributions (process risk vs. systematic/parameter risk decomposition), per the most recent working session.

Current placeholder σ (Configuration-tab / `runner/defaults.js` defaults, all editable):

| Product | Claims/mortality σ (sys / proc) | Termination σ (sys / proc) | Claims↔term ρ | NIER shift σ (sys / proc) |
|---|---|---|---|---|
| Medicare Supplement | 4.0% / 3.0% | 6.5% / 3.0% | 0.25 | — |
| Preneed | **3.5% / 2.0%** (mortality, coupled) | *= mortality (coupled)* | *n/a (ρ=1)* | **35 bps / 15 bps** |
| Hospital Indemnity | 5.5% / 4.0% | 7.0% / 4.0% | 0.25 | — |

- **PN NIER σ (35 bps sys / 15 bps proc) is research-grounded, not a placeholder** (2026-06-14): industry net yield on invested assets ≈ 4.57% (YE2024) with ~15 bps/yr book-yield moves → process ≈ 15 bps; preneed pricing interest/discount adverse-deviation margins of 20–50 bps plus the multi-year drift → systematic ≈ 35 bps. Additive bps level shift (not lognormal). Sources: NEAM 2024 U.S. Life Industry Investment Highlights; NAIC 2024 life industry commentary / capital-markets asset-mix YE2024; preneed insurer SEC filings. Documented in the Methodology tab's *Preneed NIER shock* calibration.
- ⚠ CONFIRM / TO DO: the claims/termination A/E σ for MS/HI (and the PN mortality σ) remain assumed — replace with empirically derived ones once the seriatim work lands. Note whether the distribution is actually normal (likely not) and what that means for the LHS sampling.

---

## 8. Forward sales growth — scenario draws ONLY (never the baseline)

The forward sales projection compounds each sampled scenario's 2026 anchor by a per-product,
per-year growth schedule for 2027–2035. This is a **deterministic config assumption**, not a
sampled/stochastic/LHS dimension — the efficient-frontier sampler still samples only the 2026
anchors.

- **Where it lives.** `src/frontier.js → mkScalars` (the only changed mechanic). It rewrites
  `updSales` for the sampled scenario draws and nothing else. With an **all-zero** schedule it
  reduces to the original flat projection **byte-for-byte**.
- **Baseline is sacred.** The baseline path (`frontier.js → computeBaseline`, used by the VNB /
  RBC tabs and the canon §1 gate) **never reads `S.growth`**. No growth setting can move any
  §1 number. If §1 moves, growth has leaked into the baseline and the change is wrong.
- **2026 is the anchor.** Year 2026 is the sampled value and is **never** grown; only 2027–2035
  compound, year over year: `sales[y] = sales[y-1] × (1 + rate[y])`.

**Default schedule** (decimals; editable in the Configuration tab under each product's sales anchor):

| Product | 2027 | 2028 | 2029 | 2030 | 2031 | 2032–2035 |
|---|---|---|---|---|---|---|
| Medicare Supplement (MS) | −12% | 0% | 0% | 10% | 10% | 5% |
| Preneed (PN) | 10% | 10% | 10% | 10% | 10% | 10% |
| Hospital Indemnity (HI) | 5% | 5% | 5% | 5% | 5% | 5% |

**Invariants (both verified 2026-06-13):**

1. **Baseline untouched.** With the default schedule loaded, every MODEL_CANON §1 target
   reproduces to full precision (`node runner/validate.js`) — identical to a zero-growth load.
2. **Zero growth = old static frontier.** With all growth at 0%, the decomposed efficient
   frontier matches the legacy single-file frontier **exactly** (1700 field checks across all
   100 LHS scenarios and their stochastic draws, 0 diffs — legacy engine + flat sales vs the
   decomposed engine + `frontier.js` at zero growth). Seeded RNG (`STOCH_SEED = 20260612`)
   makes this reproducible.

**Expected live behavior.** Under the default schedule, the frontier's *feasible set* and
*frontier membership* shift (capital/RBC reflect 2027+ growth: e.g. 90→85 feasible, 32→30
frontier at the 100×100 default). The scatter **coordinates** (2026-issue PVDE / risk) do not
move, because those axes are 2026-issue-only by existing design and growth is a 2027+ effect that
flows through the full-book capital path (full-book PVDE and `minRBC` do move). This is correct,
not a leak.

---

## 7. Application surface (six tabs)

`Configuration` · `Efficient Frontier` (scatter + table) · `VNB by Product` · `RBC & Surplus` · `Debug` (peer-review sections) · `Methodology`

The HTML app is a **viewer**, not the compute environment. Heavy runs go through the headless `runner/` (see `BUILD_STANDARDS.md`).

---

## 9. Excel workbook — per-year systematic/process scalar parity (validation harness)

**Canonical workbook: `EffFrontierEngine_V2Slim_Final.xlsx`** — Matt's hand-refined, **validated** workbook. It is **native Excel** (no "format/extension" open warning) and slim (13 sheets). Its `Scalars` sheet carries the same systematic + process decomposition but in a cleaner **2-D product×year `INDEX`** layout (e.g. `Input EV Recalc` claims = `INDEX(Scalars!$C$17:$AF$19, MATCH(product), MATCH(year))`), so the exact cell rows differ from the description below. The `_Final` revision (2026-06-15) carries three directed model changes now mirrored into the engine and re-baselined in §1: the **C-3 (TSC3) ×0.5 factor removed** (charged in full), **Input TS / Input Surplus rebased**, and a **PN EV (back-book) NIER** schedule added (see §1 re-baseline note and `Preneed.NIER_EV` in `data/params.json`). Supersedes the earlier `EffFrontierEngine_V2Slim.xlsx`.

The notes below document the *original* programmatic migration (`tools/per_year_scalars.py` on the now-retired `EffFrontierEngine_5.xlsx`), which established the mechanics; the V2Slim layout supersedes the specific row addresses but keeps the same math. The matching scenario export is `runner/export-scalars.js` (and the viewer's RBC-tab **Export scalars** button).

- **Original Scalars layout** (`_5`; sales block rows 1–14 unchanged): systematic (single cell, identity-default) `C17/18/19` claims, `C22/23/24` term (`C23==C18`), `C26` NIER(PN, bps); process (per year `C:AF`, identity-default) claims `29/30/31`, term `34/35/36` (`row35==row30`), NIER(PN) `39`.
- **Combination in the recalc formulas:** `claims_eff[y] = C17·claims_proc[y]`; `term_eff[y] = C22·term_proc[y]`; NIER **new business** (`VNB Recalc`, `B="N"`) `= C26 + nier_proc[y]`; NIER **back book** (`EV Recalc`, `B="E"`) `= nier_proc[y]`. This matches the online cohort scoping (systematic+process for 2026+ new business, process-only for the pre-2026 back book).
- **Why it factors cleanly:** the online per-year multiplier `exp(z_sys·σ_sys + z_proc[y]·σ_proc − ½(σ_sys²+σ_proc²))` equals `systematic × process[y]` exactly (verified to machine precision in `export-scalars.js`). Claims/term apply by experience year uniformly across cohorts; only NIER carries the cohort split.
- **Flat-equivalence invariant:** with identity defaults (1 / 1 / 0) every `INDEX/MATCH` returns the identity, so the recalc reproduces the baseline byte-for-byte — the workbook's existing RBC chain (required-capital charges scaled by recalc-vs-baseline LivesInForce, **C2 by IncClaims**; TAC = baseline + VNB-side Δ + EV-side Δ; surplus-note row 54) is untouched. Verified: claims/lapse cells bit-identical pre/post (pycel `cycles=False`); all 32,673 rewrites are exactly the documented token swap; JS §1 gate still green.
- **NIER note (supersedes the old `Scalars!B30` "online-only"):** the cohort split IS now in Excel via the VNB(new)/EV(back-book) tab separation.
