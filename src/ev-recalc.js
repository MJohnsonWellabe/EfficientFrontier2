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
