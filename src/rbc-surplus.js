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
// charge for product (exact name), line, calendar year-end; C-3 (TSC3) charged in full
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
  // C-3 (TSC3) is charged in full. The prior NAIC ×0.5 factor was removed 2026-06-15
  // to mirror the EffFrontierEngine_V2Slim_Final workbook; this moves the §1 RBC anchors.
  const swap = (tsAdj && tsAdj.c1Swap) || {};   // per-year $M moved from PN C-1o (TSC1) to C-1cs (TSC1CS); shifts covariance
  const out = {};
  for (const y of years) {
    // per-product charges
    const prod = {};
    for (const pn of Object.keys(modeled)) {
      prod[pn] = {};
      for (const k of TSC_KEYS) prod[pn][k] = tsSum(ts, pn, k, y) / 1e6;
    }
    // all other = total(all) - the three; + adjustments to TSC1 and TSC1CS
    const sw = +swap[y] || 0;
    const allOther = {};
    for (const k of TSC_KEYS) {
      let tot = tsSum(ts, null, k, y) / 1e6;
      let resid = tot - prod['Medicare Supplement'][k] - prod['Hospital Indemnity'][k] - prod['PreNeed'][k];
      if (k === 'TSC1') resid += tsAdj.G2 - sw;       // C-1o swap: move `sw` out of C1o ...
      if (k === 'TSC1CS') resid += tsAdj.I2 + sw;     // ... and into C1cs (covariance shift; recalc inherits via baseSc.allOther)
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

// SUPERSEDED / LEGACY (do not rely on): this standalone recalc predates the decomposition
// and references module-level `R`/`E` that no longer exist here (it throws ReferenceError if
// called). The LIVE scenario RBC recalc is `frontier.js buildScen`'s inline `sr[]`, which IS
// PN-EV-NIER-aware via `evFullBook`. Kept (and kept logically correct below) only as a record.
function surplusRecalc(origEV, scalars, ts, surplus, tsAdj, assum, years, preOrigVNB) {
  const recEV = R.recalcEV(origEV, scalars);
  const base = E.surplusCalc(ts, surplus, tsAdj, years);
  // full-book in-force by product, original vs recalc, indexed by Value column
  const oLIF = {}, rLIF = {};
  for (const code of ['MS', 'HI', 'PN']) { oLIF[code] = E.evMonthly(origEV, code, 'LivesInForce1'); rLIF[code] = E.evMonthly(recEV, code, 'LivesInForce1'); }
  // per-product new-business income, original vs recalc
  const vnb = {};
  // full book (new business + older <2026 block) so the TAC change captures older policy years
  // PN values its back book (pre-2026 in-force) on the EV NIER schedule (NIER_EV) while new
  // business stays on NIER — so split PN into new + back and sum the annual flows (mirrors
  // frontier.js evFullBook). MS/HI use one all-book valuation.
  const fbAnnual = (ev, code) => {
    if (code !== 'PN') return E.buildVNB(ev, code, { assum }, { nMonths: 360, allBook: true, pnShift: false });
    const nb = E.buildVNB(ev, 'PN', { assum }, { nMonths: 360, pnShift: false });
    const bk = E.buildVNB(ev, 'PN', { assum }, { nMonths: 360, allBook: true, pnShift: false, iy: '<2026', nierKind: 'NIER_EV' });
    const annual = {}; const keys = new Set([...Object.keys(nb.annual), ...Object.keys(bk.annual)]);
    for (const k of keys) {
      const m = {}, a = nb.annual[k] || {}, b = bk.annual[k] || {};
      for (const y of new Set([...Object.keys(a), ...Object.keys(b)])) m[y] = (a[y] || 0) + (b[y] || 0);
      annual[k] = m;
    }
    return { annual };
  };
  for (const code of ['MS', 'PN', 'HI']) vnb[code] = { o: fbAnnual(origEV, code), r: fbAnnual(recEV, code) };
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
 * Models a surplus note: the company receives `amount` ($M) at `startDate` and
 * earns monthly investment income on the proceeds (amount × monthly-equiv of
 * `nierSN`) after issue through maturity; it pays an upfront fee (amount × fees)
 * at issue, QUARTERLY interest (amount × rate / 4) every three months after issue
 * (including the maturity month), and repays principal at the end date
 * (= startDate + tenor years).
 *
 * Returns the NET cash flow (cash in − cash out) aggregated by calendar year.
 * Positive net adds to TAC in that year; negative net subtracts. This is the
 * ONLY place the surplus note touches the model — it flows through TAC as an
 * income change and nowhere else.
 *
 * Matches the workbook "Surplus note" tab (quarterly coupon revision 2026-06-15):
 *   cash in   = amount at the start-date month
 *             + amount × ((1+nierSN)^(1/12) − 1) each month after issue through maturity
 *   cash out  = (amount×fees at start month)
 *             + (amount×rate/4 every quarter strictly after start: months where
 *                (month − startMonth) is a multiple of 3, including the maturity month)
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
  const nierSN = +inputs.nierSN || 0;   // annual investment-earnings rate on the note proceeds (decimal)
  const investRate = nierSN ? Math.pow(1 + nierSN, 1 / 12) - 1 : 0;   // monthly equivalent
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
      const afterStart = (y > start.year) || (y === start.year && m > start.month);
      const isQuarter  = ((((m - start.month) % 3) + 3) % 3) === 0;   // start month + every 3 months (quarterly coupons)

      if (isStart) { cashIn += amount; cashOut += amount * fees; }
      if (afterStart) { cashIn += amount * investRate; }              // monthly investment income on the proceeds (after issue through maturity)
      if (afterStart && isQuarter) { cashOut += amount * rate / 4; }  // quarterly coupon (incl. the maturity month); none at issue
      if (isEnd)   { cashOut += amount; }

      out[y] += (cashIn - cashOut);
    }
  }
  return out;
}

return { surplusCalc: surplusCalc, loadTS: loadTS, loadSurplus: loadSurplus, surplusRecalc: surplusRecalc, TSC_KEYS: TSC_KEYS, surplusNoteAnnual: surplusNoteAnnual, noteEndDate: noteEndDate, parseNoteDate: parseNoteDate };
});
