// validate.js — the regression gate (BUILD_STANDARDS "Validation gate").
// Reproduces every MODEL_CANON §1 target from the decomposed engine + data/ and checks
// each to full precision. Exit code 0 iff all targets match. This is also the script that
// anchors the canon values: the "standalone VNB basis" is buildVNB with the default
// (full-data) month width and the PN acq/maint +1 shift active; the MS recalc applies the
// workbook scalars (data/params.json -> scalars) and reads MS VNB on the same basis.
'use strict';
var fs = require('fs');
var path = require('path');
var EFENG = require('../src/engine.js');

var DATA = path.join(__dirname, '..', 'data');
var ev = EFENG.loadEV(fs.readFileSync(path.join(DATA, 'InputEV.csv'), 'utf8'));
var ts = EFENG.loadTS(fs.readFileSync(path.join(DATA, 'InputTS.csv'), 'utf8'));
var surplus = EFENG.loadSurplus(fs.readFileSync(path.join(DATA, 'InputSurplus.csv'), 'utf8'));
var params = JSON.parse(fs.readFileSync(path.join(DATA, 'params.json'), 'utf8'));
var P = params.assum;

// MODEL_CANON §1 targets (after the 2026-06-13 refresh of the two stale transcriptions).
var CANON = {
  vnb: {
    MS: { irr: 0.21938929, npvDE: 633.23 },
    PN: { irr: 0.10667571, npvDE: 33.553 },   // refreshed from the -29 workbook (was 0.14688215 / 6.574)
    HI: { irr: 0.17163078, npvDE: 29.458 }
  },
  msRecalcIRR: 0.17763524,                     // refreshed from the -29 workbook (was 0.17833333)
  rbc: [5.67, 5.15, 4.35, 4.27, 4.72]          // re-baselined 2026-06-15 for V2Slim_Final_4 (Input TS/Surplus refresh). Prior: [5.23,4.34,3.36,3.18,3.58].
};

var fails = 0;
function check(label, got, want, tol, dec) {
  var ok = Math.abs(got - want) <= tol;
  if (!ok) fails++;
  console.log((ok ? '  OK  ' : ' FAIL ') + label.padEnd(34) +
    'got ' + got.toFixed(dec) + '   canon ' + want.toFixed(dec));
}

console.log('=== MODEL_CANON §1 validation gate ===');
['MS', 'PN', 'HI'].forEach(function (c) {
  var r = EFENG.vnbResults(EFENG.buildVNB(ev, c, { assum: P }, {}), P.disc); // default (full-data) basis
  check(c + ' VNB IRR', r.irr, CANON.vnb[c].irr, 5e-9, 8);
  check(c + ' VNB NPV ($M)', r.npvDE, CANON.vnb[c].npvDE, 5e-4, 3);
});
var recMS = EFENG.vnbResults(EFENG.buildVNB(EFENG.recalcEV(ev, params.scalars), 'MS', { assum: P }, {}), P.disc);
check('MS recalc IRR (workbook scalars)', recMS.irr, CANON.msRecalcIRR, 5e-9, 8);

var years = []; for (var y = 2025; y <= 2035; y++) years.push(y);
var sc = EFENG.surplusCalc(ts, surplus, params.ts_adj, years);
[2026, 2027, 2028, 2029, 2030].forEach(function (yr, i) {
  check('RBC ratio ' + yr, sc[yr].ratio, CANON.rbc[i], 5e-3, 2);
});

console.log('\n' + (fails === 0 ? 'ALL CANON §1 TARGETS REPRODUCED' : fails + ' TARGET(S) FAILED'));
process.exit(fails ? 1 : 0);
