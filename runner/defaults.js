// defaults.js — the headless runner's view of the Configuration tab defaults.
// These mirror the viewer's initial state S and the HTML input defaults exactly, so a
// headless run reproduces the in-browser frontier bit-for-bit (the engine is seeded).
'use strict';
var fs = require('fs');
var path = require('path');

var PRODS = ['MS', 'PN', 'HI'];
var PNAME = { MS: 'Medicare Supplement', PN: 'Preneed', HI: 'Hospital Indemnity' };
var SALES_YEARS = [2026, 2027, 2028, 2029, 2030, 2031, 2032, 2033, 2034, 2035];

// Per-product annual sales-GROWTH RANGE (decimals), applied year-over-year 2027..2030.
// This replaces the old fixed per-year growth schedule: the multi-year frontier samples a
// growth rate per product PER YEAR from within each product's [lo,hi] range (LHS), so the
// plan chooses how fast each product grows. 2026 is the sampled starting level (S.bounds);
// 2031..2035 issuance is held flat at the 2030 level (outside the 2026-2030 program/RBC window).
// Defaults span the old schedule (MS could fall 12% or grow 10%; PN 0-10%; HI 0-5%).
function defaultGrowthRange() {
  return { MS: [-0.12, 0.10], PN: [0.0, 0.10], HI: [0.0, 0.05] };
}
function zeroGrowthRange() {
  return { MS: [0.0, 0.0], PN: [0.0, 0.0], HI: [0.0, 0.0] };   // flat: every product holds its 2026 level
}

// Build the full headless state S from the data/ files + engine, matching the viewer.
function buildState(EFENG, dataDir, growthRange) {
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
    baseline: null, origLIF: null, ev2026: null, evProg: null,
    bounds: { MS: [250, 350], PN: [200, 240], HI: [18, 25] },   // 2026 starting-level LHS range per product
    hurdles: { MS: 0.12, PN: 0.10, HI: 0.10 },
    origSales: origSales,
    growthRange: growthRange || zeroGrowthRange(),   // per-product annual growth [lo,hi], sampled per year 2027-2030
    progYears: [2026, 2027, 2028, 2029, 2030],       // the multi-year new-business program horizon (objective + decision)
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
    // Constraints scoped to the 2026-2030 new-business PROGRAM. deYr/cumDEFloor/de1Floor are
    // program-scale (a 5-year issuance program carries ~5x the early strain of a single cohort and
    // turns cash-positive in 2031): DE>0 by 2032 (deYr 7), cumDE trough floor -$650M, year-1 floor
    // -$175M. This leaves C1 (min RBC 2026-2030 >= 4.0) as the binding constraint that drives the
    // "only grow down when RBC requires it" behavior. All adjustable on the Config tab.
    cons: { rbcFloor: 4.0, tacChgFloor: -0.12, irr3on: true, irrA: 0.08, irrB: 0.15, deYr: 7, cumDeYr: 10, cumDEFloor: -650, de1Floor: -175, rbcTailX: 3.5, rbcTailY: 0.25 },
    surplusNote: { on: true, amount: 150, tenor: 10, rate: 0.09, fees: 0.03, nierSN: 0.04, startDate: '2026-06-30' },
    // Reinsurance — MS quota share, ON by default at 10%/yr. Mirrors viewer S init / Config-tab Reinsurance section.
    // cede: retained-share cession % by MS issue year; lagYears: 1-yr cession lag; commUpfront: $M
    // front-end ceding commission by year; commTable: ongoing $/policy/yr sliding scale by loss-ratio band.
    reinsurance: {
      on: true, lagYears: 1,
      cede: { '<2026': 0.10, '2026': 0.10, '2027': 0.10, '2028': 0.10, '2029': 0.10, '2030': 0.10, '2031': 0.10, '2032': 0.10, '2033': 0.10, '2034': 0.10, '2035': 0.10 },
      commUpfront: { 2026: 10, 2027: 5, 2028: 5 },
      commTable: [[0, 0.75, 250], [0.75, 0.85, 200], [0.85, 0.95, 150], [0.95, Infinity, 100]]
    },
    results: []
  };
}

module.exports = { buildState: buildState, defaultGrowthRange: defaultGrowthRange, zeroGrowthRange: zeroGrowthRange, PRODS: PRODS, SALES_YEARS: SALES_YEARS };
