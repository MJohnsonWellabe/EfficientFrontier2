// export-scalars.js — export ONE seeded scenario's scalar stream in the layout of the
// (restructured) workbook `Scalars` sheet, so it can be pasted into Excel for an
// apples-to-apples RBC comparison against the online engine.
//
// The workbook's Scalars sheet (after tools/per_year_scalars.py) holds the online
// engine's systematic + process decomposition. This script reproduces a scenario
// deterministically (same seed/LHS/shock-bank as runner/run.js), decomposes its draws
// into the SAME systematic/process multipliers (claims/term) and additive bps shifts
// (NIER) the sheet expects, and writes:
//   1) a paste-ready CSV mirroring the Scalars rows (years as columns 2026..2055), and
//   2) the online RBC ratios / TAC / reqCap for that scenario (the expected targets).
//
// Usage:  node runner/export-scalars.js [lhsIndex] [stochIndex] [growthMode] [outCsv]
//   lhsIndex    0-based index into the LHS sales draws (default 0)
//   stochIndex  0-based index into the shock bank      (default 0)
//   growthMode  default | zero  (sales-growth schedule; default 'default')
//   outCsv      output path (default runner/results/scalars_<lhs>_<stoch>_<mode>.csv)
'use strict';
var fs = require('fs');
var path = require('path');
var EFENG = require('../src/engine.js');
var FRONTIER = require('../src/frontier.js');
var D = require('./defaults.js');

var ROOT = path.join(__dirname, '..');
var DATA = path.join(ROOT, 'data');
var PRODS = ['MS', 'PN', 'HI'];
var PNAME = { MS: 'Medicare Supplement', PN: 'Preneed', HI: 'Hospital Indemnity' };
var YEARS = []; for (var y = 2026; y <= 2055; y++) YEARS.push(y);       // experience years (process)
var SYRS = []; for (var y = 2026; y <= 2035; y++) SYRS.push(y);         // sales years

function main() {
  var lhsI = parseInt(process.argv[2] != null ? process.argv[2] : '0', 10);
  var stoI = parseInt(process.argv[3] != null ? process.argv[3] : '0', 10);
  var mode = (process.argv[4] || 'default').toLowerCase();
  var growthTarget = (mode === 'zero') ? D.zeroGrowthTarget() : D.defaultGrowthTarget();

  var S = D.buildState(EFENG, DATA, growthTarget);
  var F = FRONTIER.create(S, EFENG);
  F.computeBaseline();

  // reproduce the EXACT sampling order of frontier.js runSweep: per-product 2026 level (MS,PN,HI), then
  // the 12-dim per-year growth LHS (each product x 2027-2030), then the shock bank. The drawn growth is
  // then repaired (F.repairGrowth) so the sales path matches the frontier's scenario at this lhsIndex.
  F.setSeed(F.STOCH_SEED);
  var TGT = S.growthTarget || { MS: 0, PN: 0, HI: 0 }, GMIN = S.growthMin || { MS: 0, PN: 0, HI: 0 };
  var levelA = { MS: F.lhs(S.nScen, S.bounds.MS[0], S.bounds.MS[1]), PN: F.lhs(S.nScen, S.bounds.PN[0], S.bounds.PN[1]), HI: F.lhs(S.nScen, S.bounds.HI[0], S.bounds.HI[1]) };
  var grA = {}; PRODS.forEach(function (c) { grA[c] = [0, 1, 2, 3].map(function () { return F.lhs(S.nScen, GMIN[c], TGT[c]); }); });
  var BANK = F.buildShockBank(S.nStoch);
  if (lhsI < 0 || lhsI >= levelA.MS.length) throw new Error('lhsIndex out of range 0..' + (levelA.MS.length - 1));
  if (stoI < 0 || stoI >= BANK.length) throw new Error('stochIndex out of range 0..' + (BANK.length - 1));

  var level = { MS: levelA.MS[lhsI], PN: levelA.PN[lhsI], HI: levelA.HI[lhsI] };
  var gdraw = { MS: grA.MS.map(function (a) { return a[lhsI]; }), PN: grA.PN.map(function (a) { return a[lhsI]; }), HI: grA.HI.map(function (a) { return a[lhsI]; }) };
  var sales = F.mkPath(level, F.repairGrowth(level, gdraw).growth);
  var b = BANK[stoI];

  // ---- decompose the draw into systematic / process, matching shockFromBank exactly ----
  // claims/term multipliers: systematic = exp(z*sig - 0.5 sig^2); process[y] = exp(z[y]*sig - 0.5 sig^2)
  // (product of the two == the combined per-year multiplier shockFromBank applies).
  function lognorm(z, sig) { return Math.exp(z * sig - 0.5 * sig * sig); }
  var clSys = {}, clProc = {}, tmSys = {}, tmProc = {};
  PRODS.forEach(function (c) {
    if (c === 'PN') {
      var mS = S.claimsSD.PN || 0, mP = (S.claimsProcSD && S.claimsProcSD.PN) || 0;
      clSys.PN = lognorm(b.cs.PN, mS);
      clProc.PN = YEARS.map(function (yy, i) { return lognorm(b.cp.PN[i], mP); });
      tmSys.PN = clSys.PN;                       // PN term == PN claims (coupled mortality)
      tmProc.PN = clProc.PN.slice();
    } else {
      var cS = S.claimsSD[c] || 0, cP = (S.claimsProcSD && S.claimsProcSD[c]) || 0;
      var lS = S.lapseSD[c] || 0, lP = (S.lapseProcSD && S.lapseProcSD[c]) || 0;
      var rho = (S.procCorr && S.procCorr[c]) || 0, rr = Math.sqrt(Math.max(0, 1 - rho * rho));
      clSys[c] = lognorm(b.cs[c], cS);
      clProc[c] = YEARS.map(function (yy, i) { return lognorm(b.cp[c][i], cP); });
      tmSys[c] = lognorm(b.ls[c], lS);
      tmProc[c] = YEARS.map(function (yy, i) { return lognorm(rho * b.cp[c][i] + rr * b.lp[c][i], lP); });
    }
  });
  // NIER (PN only, additive bps): systematic = z*sig ; process[y] = z[y]*sig
  var niS = (S.nierSD && S.nierSD.PN) || 0, niP = (S.nierProcSD && S.nierProcSD.PN) || 0;
  var nierSys = b.ni.PN * niS;
  var nierProc = YEARS.map(function (yy, i) { return b.nip.PN[i] * niP; });

  // ---- combined maps for the online RBC computation (must equal shockFromBank) ----
  var shock = F.shockFromBank(b);
  var nier = { combined: { PN: shock.nm.PN }, proc: { PN: shock.nmProc.PN } };
  var det = F.buildScen(sales, shock.cm, shock.lm, nier);

  // sales scalar per issue year = updSales / origSales (from mkScalars, incl. growth)
  var salesScalar = {};
  PRODS.forEach(function (c) {
    var nm = PNAME[c], up = det.scalars.updSales[nm], og = det.scalars.origSales[nm];
    salesScalar[c] = SYRS.map(function (yy, i) { return up[i] / og[i]; });
  });

  // online RBC ratios: row52 = no note, row54 = with note (= det ratio when note ON)
  var rbcNoNote = {}, rbcNote = {}, tac = {}, reqCap = {};
  SYRS.forEach(function (yy) {
    var d = det.surplus[yy]; if (!d) return;
    reqCap[yy] = d.reqCap;
    var noteAdj = d.noteAdj || 0;
    tac[yy] = d.tac;                          // post-note TAC
    rbcNote[yy] = d.ratio;                    // with surplus note
    rbcNoNote[yy] = d.reqCap ? (d.tac - noteAdj) / d.reqCap : null;
  });

  // ---- write CSV (years as columns; single-value rows place value in 2026 col) ----
  function rowYears(label, vals) { return [label].concat(vals.map(function (v) { return v; })).join(','); }
  function rowSingle(label, v) { var a = [label, v]; for (var i = 1; i < YEARS.length; i++) a.push(''); return a.join(','); }
  function rowSales(label, vals) { var a = [label].concat(vals); for (var i = vals.length; i < YEARS.length; i++) a.push(''); return a.join(','); }
  var L = [];
  L.push('# EfficientFrontier scalar stream  seed=' + F.STOCH_SEED + '  lhsIndex=' + lhsI + '  stochIndex=' + stoI + '  growth=' + mode);
  L.push('# sales path $M (2026..2035)  MS=[' + sales.MS.map(function (v) { return v.toFixed(1); }).join(',') + ']  PN=[' + sales.PN.map(function (v) { return v.toFixed(1); }).join(',') + ']  HI=[' + sales.HI.map(function (v) { return v.toFixed(1); }).join(',') + ']');
  L.push('# Paste each value range into the indicated Scalars! cells, then recalc. Years run 2026..2055.');
  L.push(rowYears('label \\ year', YEARS));
  L.push(rowSales('Sales scalar MS (C12:L12)', salesScalar.MS));
  L.push(rowSales('Sales scalar PN (C13:L13)', salesScalar.PN));
  L.push(rowSales('Sales scalar HI (C14:L14)', salesScalar.HI));
  L.push(rowSingle('Claims systematic MS (C17)', clSys.MS));
  L.push(rowSingle('Claims systematic PN (C18)', clSys.PN));
  L.push(rowSingle('Claims systematic HI (C19)', clSys.HI));
  L.push(rowSingle('Term systematic MS (C22)', tmSys.MS));
  L.push(rowSingle('Term systematic PN (C23)', tmSys.PN));
  L.push(rowSingle('Term systematic HI (C24)', tmSys.HI));
  L.push(rowSingle('NIER systematic PN (C26)', nierSys));
  L.push(rowYears('Claims process MS (C29:AF29)', clProc.MS));
  L.push(rowYears('Claims process PN (C30:AF30)', clProc.PN));
  L.push(rowYears('Claims process HI (C31:AF31)', clProc.HI));
  L.push(rowYears('Term process MS (C34:AF34)', tmProc.MS));
  L.push(rowYears('Term process PN (C35:AF35)', tmProc.PN));
  L.push(rowYears('Term process HI (C36:AF36)', tmProc.HI));
  L.push(rowYears('NIER process PN (C39:AF39)', nierProc));
  L.push('');
  L.push('# ---- ONLINE EXPECTED TARGETS (compare after recalc) ----');
  L.push(rowSales('year', SYRS));
  L.push(rowSales('RBC ratio no-note (Surplus Recalc row 52)', SYRS.map(function (yy) { return rbcNoNote[yy] != null ? rbcNoNote[yy].toFixed(4) : ''; })));
  L.push(rowSales('RBC ratio w/ note (Surplus Recalc row 54)', SYRS.map(function (yy) { return rbcNote[yy] != null ? rbcNote[yy].toFixed(4) : ''; })));
  L.push(rowSales('TAC (Surplus Recalc row 50)', SYRS.map(function (yy) { return tac[yy] != null ? tac[yy].toFixed(3) : ''; })));
  L.push(rowSales('Required capital (Surplus Recalc row 48)', SYRS.map(function (yy) { return reqCap[yy] != null ? reqCap[yy].toFixed(3) : ''; })));

  var dir = path.join(__dirname, 'results');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  var outCsv = process.argv[5] || path.join(dir, 'scalars_' + lhsI + '_' + stoI + '_' + mode + '.csv');
  fs.writeFileSync(outCsv, L.join('\n') + '\n');

  // JSON sidecar (full record)
  var json = {
    meta: { seed: F.STOCH_SEED, lhsIndex: lhsI, stochIndex: stoI, growth: mode, sales: sales },
    scalars: { salesScalar: salesScalar, claimsSys: clSys, claimsProc: clProc, termSys: tmSys, termProc: tmProc, nierSys: nierSys, nierProc: nierProc, years: YEARS },
    online: { rbcNoNote: rbcNoNote, rbcWithNote: rbcNote, tac: tac, reqCap: reqCap, minRBC: det.minRBC }
  };
  fs.writeFileSync(outCsv.replace(/\.csv$/, '.json'), JSON.stringify(json, null, 2) + '\n');

  console.log('scenario: lhsIndex=' + lhsI + ' stochIndex=' + stoI + ' growth=' + mode + '  sales MS/PN/HI=' +
    sales.MS[0].toFixed(2) + '/' + sales.PN[0].toFixed(2) + '/' + sales.HI[0].toFixed(2) + ' (2026 anchor)');
  console.log('online RBC no-note 26-30 = ' + [2026, 2027, 2028, 2029, 2030].map(function (yy) { return rbcNoNote[yy].toFixed(3); }).join(' / '));
  console.log('online RBC w/note  26-30 = ' + [2026, 2027, 2028, 2029, 2030].map(function (yy) { return rbcNote[yy].toFixed(3); }).join(' / '));
  console.log('wrote ' + outCsv);
  console.log('wrote ' + outCsv.replace(/\.csv$/, '.json'));
}

main();
