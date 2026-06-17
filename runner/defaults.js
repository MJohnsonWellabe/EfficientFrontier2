// defaults.js — the headless runner's view of the Configuration tab defaults.
// These mirror the viewer's initial state S and the HTML input defaults exactly, so a
// headless run reproduces the in-browser frontier bit-for-bit (the engine is seeded).
'use strict';
var fs = require('fs');
var path = require('path');

var PRODS = ['MS', 'PN', 'HI'];
var PNAME = { MS: 'Medicare Supplement', PN: 'Preneed', HI: 'Hospital Indemnity' };
var SALES_YEARS = [2026, 2027, 2028, 2029, 2030, 2031, 2032, 2033, 2034, 2035];

// Default forward-sales growth schedule (decimals), 2027..2035. This is the single
// source of truth shared with the viewer (viewer/app.js loads the same numbers).
//   MS: 0% every year. PN: 10% for 2027-2029, then 6% for 2030-2035. HI: 5% every year.
function defaultGrowth() {
  var g = { MS: {}, PN: {}, HI: {} };
  for (var i = 0; i < SALES_YEARS.length; i++) {
    var y = SALES_YEARS[i];
    if (y === 2026) continue;                       // 2026 is the anchor, never grown
    g.MS[y] = (y === 2027) ? -0.12 : (y === 2028 || y === 2029) ? 0.0 : (y === 2030 || y === 2031) ? 0.10 : 0.05;
    g.PN[y] = 0.10;
    g.HI[y] = 0.05;
  }
  return g;
}
function zeroGrowth() {
  var g = { MS: {}, PN: {}, HI: {} };
  for (var i = 0; i < SALES_YEARS.length; i++) {
    var y = SALES_YEARS[i]; if (y === 2026) continue;
    g.MS[y] = 0.0; g.PN[y] = 0.0; g.HI[y] = 0.0;
  }
  return g;
}

// Build the full headless state S from the data/ files + engine, matching the viewer.
function buildState(EFENG, dataDir, growth) {
  var ev = EFENG.loadEV(fs.readFileSync(path.join(dataDir, 'InputEV.csv'), 'utf8'));
  var ts = EFENG.loadTS(fs.readFileSync(path.join(dataDir, 'InputTS.csv'), 'utf8'));
  var surplus = EFENG.loadSurplus(fs.readFileSync(path.join(dataDir, 'InputSurplus.csv'), 'utf8'));
  var params = JSON.parse(JSON.stringify(JSON.parse(fs.readFileSync(path.join(dataDir, 'params.json'), 'utf8'))));

  var years = []; for (var y = 2025; y <= 2055; y++) years.push(y);

  // origSales per-year, exactly as the viewer's init() derives it from params.scalars.
  var origSales = { MS: {}, PN: {}, HI: {} };
  var base = params.scalars.origSales;
  var scalarYears = params.scalars.years || SALES_YEARS;
  PRODS.forEach(function (c) {
    var arr = base[PNAME[c]] || [];
    arr.forEach(function (v, i) { var yy = scalarYears[i]; if (yy != null && v != null) origSales[c][yy] = v; });
  });

  return {
    ev: ev, ts: ts, surplus: surplus, params: params, years: years,
    baseline: null, origLIF: null, ev2026: null,
    bounds: { MS: [250, 350], PN: [200, 240], HI: [18, 25] },
    hurdles: { MS: 0.12, PN: 0.10, HI: 0.10 },
    origSales: origSales,
    growth: growth || zeroGrowth(),
    claimsSD: { MS: 0.04, PN: 0.035, HI: 0.055 },
    claimsProcSD: { MS: 0.03, PN: 0.02, HI: 0.04 },
    lapseSD: { MS: 0.065, PN: 0.045, HI: 0.07 },
    lapseProcSD: { MS: 0.03, PN: 0.02, HI: 0.04 },
    procCorr: { MS: 0.25, PN: 0.50, HI: 0.25 },
    // PN-only additive-bps NIER shock σ (35bps syst / 15bps proc). PN claimsSD above is its mortality σ
    // (drives the coupled claims+decrement+reserve-release shock); PN lapseSD/procCorr are unused.
    nierSD: { MS: 0, PN: 0.0035, HI: 0 },
    nierProcSD: { MS: 0, PN: 0.0015, HI: 0 },
    nScen: 100, nStoch: 100, slowMode: false,
    cons: { rbcFloor: 4.0, tacChgFloor: -0.12, irr3on: true, irrA: 0.08, irrB: 0.15, deYr: 4, cumDeYr: 10, cumDEFloor: -180, de1Floor: -150, rbcTailX: 3.5, rbcTailY: 0.25 },
    surplusNote: { on: true, amount: 150, tenor: 10, rate: 0.09, fees: 0.03, nierSN: 0.04, startDate: '2026-06-30' },
    results: []
  };
}

module.exports = { buildState: buildState, defaultGrowth: defaultGrowth, zeroGrowth: zeroGrowth, PRODS: PRODS, SALES_YEARS: SALES_YEARS };
