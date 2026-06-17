// run.js — headless efficient-frontier runner (100 LHS × 100 stochastic by default).
// Loads the decomposed engine + shared frontier compute + data/, runs the frontier the
// same way the browser viewer does (seeded, so results are reproducible and identical),
// and writes a results JSON the viewer / verification can consume.
//
// Usage:  node runner/run.js [default|zero] [outFile]
//   default  -> apply the default growth schedule (PN/HI grow, MS flat)
//   zero     -> all growth = 0 (reproduces the legacy static frontier; the default)
'use strict';
var fs = require('fs');
var path = require('path');
var EFENG = require('../src/engine.js');
var FRONTIER = require('../src/frontier.js');
var D = require('./defaults.js');

var ROOT = path.join(__dirname, '..');
var DATA = path.join(ROOT, 'data');

// Headless sweep — uses the SAME shared src/frontier.js runSweep as the viewer (worker + fallback),
// so headless and in-browser results are identical for a given seed. (Tight loop, no yield callbacks.)
function runFrontier(S, F) { return F.runSweep(); }

async function main() {
  var mode = (process.argv[2] || 'zero').toLowerCase();
  var growth = (mode === 'default') ? D.defaultGrowth() : D.zeroGrowth();
  var S = D.buildState(EFENG, DATA, growth);
  if (process.argv.indexOf('slow') >= 0) S.slowMode = true;   // Slow mode: per-draw trough-RBC tail
  var F = FRONTIER.create(S, EFENG);
  F.computeBaseline();
  var results = await runFrontier(S, F);

  var out = {
    meta: {
      mode: mode, generatedAt: new Date().toISOString(),
      seed: F.STOCH_SEED, nScen: S.nScen, nStoch: S.nStoch,
      bounds: S.bounds, growth: S.growth
    },
    baseline: {
      vnb: {
        MS: { irr: S.baseline.vnbs.MS.r.irr, npvDE: S.baseline.vnbs.MS.r.npvDE },
        PN: { irr: S.baseline.vnbs.PN.r.irr, npvDE: S.baseline.vnbs.PN.r.npvDE },
        HI: { irr: S.baseline.vnbs.HI.r.irr, npvDE: S.baseline.vnbs.HI.r.npvDE }
      },
      rbc: [2026, 2027, 2028, 2029, 2030].map(function (y) { return S.baseline.surplusCalc[y].ratio; }),
      npv26: S.baseline.npv26, portIRR: S.baseline.portIRR, minRBC: S.baseline.minRBC
    },
    scenarios: results.map(function (r) {
      return {
        id: r.id, sales: r.sales, npv26: r.npv26, irr26: r.irr26, wtdIRR: r.wtdIRR,
        risk: r.risk, riskSD: r.riskSD, cte90: r.cte90, ddWorst: r.ddWorst, minRBC: r.minRBC,
        feasible: r.feasible, isFrontier: r.isFrontier, failCodes: r.failures.map(function (f) { return f.code; }),
        stochIRRs: r.stochIRRs, stochNPVs: r.stochNPVs, stochDD: r.stochDD
      };
    })
  };
  var dir = path.join(__dirname, 'results');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  var outFile = process.argv[3] || path.join(dir, 'frontier_' + mode + '.json');
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2) + '\n');
  var nf = results.filter(function (r) { return r.isFrontier; }).length;
  var nfe = results.filter(function (r) { return r.feasible; }).length;
  console.log('mode=' + mode + '  scenarios=' + results.length + '  feasible=' + nfe + '  frontier=' + nf);
  console.log('baseline VNB IRR  MS/PN/HI = ' + ['MS', 'PN', 'HI'].map(function (c) { return out.baseline.vnb[c].irr.toFixed(8); }).join(' / '));
  console.log('baseline RBC 26-30 = ' + out.baseline.rbc.map(function (x) { return x.toFixed(2); }).join(' / '));
  console.log('wrote ' + outFile);
}

main().catch(function (e) { console.error(e); process.exit(1); });
