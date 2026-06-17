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
  const arr = perProd[prodName][kind] || perProd[prodName].NIER;  // fallback (e.g. NIER_EV only defined for PN)
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
    const nshift = (opts.nierShift && opts.nierShift[yr] != null) ? opts.nierShift[yr] : 0;   // additive bps NIER shock (PN stochastic only; 0 elsewhere -> §1 unchanged)
    const nier = assumLookup(P.perProduct, prodName, opts.nierKind || 'NIER', yr) + nshift;    // nierKind: 'NIER_EV' for the PN back book (EV side)
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
