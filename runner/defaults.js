// defaults.js — the headless runner's view of the Configuration tab defaults.
// These mirror the viewer's initial state S and the HTML input defaults exactly, so a
// headless run reproduces the in-browser frontier bit-for-bit (the engine is seeded).
'use strict';
var fs = require('fs');
var path = require('path');

var PRODS = ['MS', 'PN', 'HI'];
var PNAME = { MS: 'Medicare Supplement', PN: 'Preneed', HI: 'Hospital Indemnity' };
var SALES_YEARS = [2026, 2027, 2028, 2029, 2030, 2031, 2032, 2033, 2034, 2035];

// Per-product annual sales-GROWTH TARGET and MIN (decimals), applied year-over-year 2027..2030.
// The multi-year frontier samples only the 2026 starting level (S.bounds); growth STARTS at the
// target for every product and is cut ONLY to reach feasibility (frontier.js repairGrowth): MS first
// (it drives RBC) down toward growthMin.MS (negative allowed), then HI, then PN. So plans grow toward
// target and only go down when constraints require it. 2031..2035 held flat at the 2030 level.
function defaultGrowthTarget() {
  return { MS: 0.05, PN: 0.10, HI: 0.10 };
}
function defaultGrowthMin() {
  return { MS: -0.12, PN: 0.0, HI: 0.0 };   // floor growth can be cut to for feasibility (MS may decline)
}
function zeroGrowthTarget() {
  return { MS: 0.0, PN: 0.0, HI: 0.0 };      // flat: every product holds its 2026 level (no growth)
}

// Build the full headless state S from the data/ files + engine, matching the viewer.
function buildState(EFENG, dataDir, growthTarget) {
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
    bounds: { MS: [150, 400], PN: [150, 270], HI: [15, 25] },   // 2026 starting-level LHS range per product
    hurdles: { MS: 0.12, PN: 0.10, HI: 0.10 },
    origSales: origSales,
    growthTarget: growthTarget || zeroGrowthTarget(),   // per-product target annual growth (start; repaired down for feasibility)
    growthMin: defaultGrowthMin(),                      // per-product floor growth (repair cuts toward this; MS may go negative)
    progYears: [2026, 2027, 2028, 2029, 2030],          // the multi-year new-business program horizon (objective + decision)
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
    // Constraints. C5-C8 apply the ORIGINAL single-cohort thresholds to EACH issue year 2026-2030
    // independently (frontier.js evalCons): DE>0 by yr 4, cumDE>0 by yr 10, min cumDE >= -$180M,
    // year-1 DE >= -$150M (per cohort, on its own timeline). C1 (min RBC 2026-2030 >= 4.0) is the
    // binding constraint that drives the growth repair ("grow to target, cut only for feasibility").
    cons: { rbcFloor: 4.0, tacChgFloor: -0.12, irr3on: true, irrA: 0.08, irrB: 0.15, deYr: 4, cumDeYr: 10, cumDEFloor: -180, de1Floor: -150, rbcTailX: 3.5, rbcTailY: 0.25 },
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

module.exports = { buildState: buildState, defaultGrowthTarget: defaultGrowthTarget, defaultGrowthMin: defaultGrowthMin, zeroGrowthTarget: zeroGrowthTarget, PRODS: PRODS, SALES_YEARS: SALES_YEARS };
