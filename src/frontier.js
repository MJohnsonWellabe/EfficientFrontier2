// frontier.js — scenario + efficient-frontier compute, shared by the viewer and the
// headless runner so both produce identical results. Ported verbatim from the legacy
// single-file viewer; the ONLY behavioral change is the forward sales-growth projection
// in mkScalars (see the comment there). All functions close over the caller's state
// object S and the engine EFENG, so the viewer's live config drives every calc.
//
// SCOPE NOTE (sales growth): growth is applied ONLY here, when projecting each sampled
// scenario's sales forward (updSales) for the efficient-frontier draws. It is a
// deterministic config assumption, NOT a sampled dimension. The baseline path
// (computeBaseline) never calls into this module, so the MODEL_CANON §1 baseline is
// unaffected by any growth setting. With an all-zero schedule, mkScalars reduces to the
// original flat projection byte-for-byte (see Invariant 2).
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) { module.exports = factory(); }
  else { root.EFFRONTIER = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function create(S, EFENG) {
    var PRODS = ['MS', 'PN', 'HI'];
    var PNAME = { MS: 'Medicare Supplement', PN: 'Preneed', HI: 'Hospital Indemnity' };
    var SALES_YEARS = [2026, 2027, 2028, 2029, 2030, 2031, 2032, 2033, 2034, 2035];
    var STOCH_SEED = 20260612;     // fixed default seed -> reproducible runs
    var NYEARS = 30;               // 2026..2055

    // ---- display helpers (used only to build constraint labels; non-numeric) ----
    function fmt(x, d) { if (x == null || !isFinite(x)) return '—'; return Number(x).toFixed(d != null ? d : 2); }
    function pct(x, d) { if (x == null || !isFinite(x)) return '—'; return (x * 100).toFixed(d != null ? d : 1) + '%'; }
    function rx(x) { if (x == null || !isFinite(x)) return '—'; return x.toFixed(3) + '×'; }

    // ---- seeded RNG (common random numbers + antithetic; see legacy notes) ----
    var RNG = Math.random;
    function setSeed(seed) { RNG = mulberry32(seed); }
    function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
    function nrand() { var u = RNG(); if (u < 1e-12) u = 1e-12; return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * RNG()); }
    function lhs(n, lo, hi) { var a = []; for (var i = 0; i < n; i++)a.push((i + RNG()) / n * (hi - lo) + lo); for (var i = n - 1; i > 0; i--) { var j = (RNG() * (i + 1)) | 0; var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
    function nvec(n) { var a = []; for (var i = 0; i < n; i++)a.push(nrand()); return a; }
    function buildShockBank(ns) {
      var bank = [];
      // PN NIER (investment-yield) draws are appended AFTER the existing per-product
      // draws so the MS/HI/claims/lapse RNG stream is unchanged bit-for-bit; only the
      // new PN NIER dimension consumes extra entropy at the tail.
      function mk() { var d = { cs: {}, ls: {}, cp: {}, lp: {}, ni: {}, nip: {} }; PRODS.forEach(function (c) { d.cs[c] = nrand(); d.ls[c] = nrand(); d.cp[c] = nvec(NYEARS); d.lp[c] = nvec(NYEARS); }); d.ni.PN = nrand(); d.nip.PN = nvec(NYEARS); return d; }
      function neg(d) { var e = { cs: {}, ls: {}, cp: {}, lp: {}, ni: {}, nip: {} }; PRODS.forEach(function (c) { e.cs[c] = -d.cs[c]; e.ls[c] = -d.ls[c]; e.cp[c] = d.cp[c].map(function (z) { return -z; }); e.lp[c] = d.lp[c].map(function (z) { return -z; }); }); e.ni.PN = -d.ni.PN; e.nip.PN = d.nip.PN.map(function (z) { return -z; }); return e; }
      while (bank.length < ns) { var b = mk(); bank.push(b); if (bank.length < ns) bank.push(neg(b)); } return bank;
    }
    function shockFromBank(b) {
      var cm = {}, lm = {}, nm = {}, nmProc = {}; PRODS.forEach(function (c) {
        if (c === 'PN') {
          // Preneed: a death is simultaneously a claim, a reserve release, and a
          // decrement, so claims and termination are ONE coupled mortality shock —
          // cm.PN === lm.PN (claims↑, lives↓, reserve release↑ via the per-life
          // rescale in recalcEV, netting to the thin net-amount-at-risk margin).
          // The dominant PN risk is a separate additive-bps NIER (earned-rate) shift,
          // returned both as combined (systematic+process, for new business 2026+) and
          // process-only (for the pre-2026 back book — see buildScen NIER→RBC scoping).
          var mS = S.claimsSD.PN || 0, mP = (S.claimsProcSD && S.claimsProcSD.PN) || 0, mAdj = 0.5 * (mS * mS + mP * mP), mmap = {};
          var niS = (S.nierSD && S.nierSD.PN) || 0, niP = (S.nierProcSD && S.nierProcSD.PN) || 0, nmap = {}, npmap = {};
          for (var i = 0; i < NYEARS; i++) {
            var y = 2026 + i;
            mmap[y] = Math.exp(b.cs.PN * mS + b.cp.PN[i] * mP - mAdj);
            npmap[y] = b.nip.PN[i] * niP;                  // process only (year-to-year reinvestment) — hits every issue year
            nmap[y] = b.ni.PN * niS + npmap[y];            // systematic + process — hits 2026+ new business
          }
          cm.PN = mmap; lm.PN = mmap; nm.PN = nmap; nmProc.PN = npmap;
        } else {
          var cS = S.claimsSD[c] || 0, cP = (S.claimsProcSD && S.claimsProcSD[c]) || 0, lS = S.lapseSD[c] || 0, lP = (S.lapseProcSD && S.lapseProcSD[c]) || 0;
          var rho = (S.procCorr && S.procCorr[c]) || 0, rr = Math.sqrt(Math.max(0, 1 - rho * rho));
          var cAdj = 0.5 * (cS * cS + cP * cP), lAdj = 0.5 * (lS * lS + lP * lP), cmap = {}, lmap = {};
          for (var i = 0; i < NYEARS; i++) {
            var y = 2026 + i;
            cmap[y] = Math.exp(b.cs[c] * cS + b.cp[c][i] * cP - cAdj);
            lmap[y] = Math.exp(b.ls[c] * lS + (rho * b.cp[c][i] + rr * b.lp[c][i]) * lP - lAdj);
          }
          cm[c] = cmap; lm[c] = lmap;
        }
      });
      return { cm: cm, lm: lm, nm: nm, nmProc: nmProc };
    }

    // ---- statistics / downside risk ----
    function pctile(arr, p) { if (!arr || !arr.length) return null; var s = arr.slice().filter(function (x) { return x != null && isFinite(x); }).sort(function (a, b) { return a - b; }); if (!s.length) return null; var i = (p / 100) * (s.length - 1), lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); }
    function stddev(arr) { if (!arr || arr.length < 2) return 0; var a = arr.filter(function (x) { return x != null && isFinite(x); }); if (!a.length) return 0; var m = a.reduce(function (s, x) { return s + x; }, 0) / a.length; return Math.sqrt(a.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / a.length); }
    function cteLow(arr, p) { var s = arr.filter(function (x) { return x != null && isFinite(x); }).slice().sort(function (a, b) { return a - b; }); if (!s.length) return null; var k = Math.max(1, Math.round(p / 100 * s.length)), sum = 0; for (var i = 0; i < k; i++)sum += s[i]; return sum / k; }
    function semidevBelow(arr, ref) { if (ref == null || !isFinite(ref)) return 0; var a = arr.filter(function (x) { return x != null && isFinite(x); }); if (!a.length) return 0; var s = 0; a.forEach(function (x) { var d = Math.min(0, x - ref); s += d * d; }); return Math.sqrt(s / a.length); }
    function downsideRisk(npvs, dds, det) { var sd = stddev(npvs), cte90 = cteLow(npvs, 10); var risk = (det != null && isFinite(det) && cte90 != null && isFinite(cte90)) ? (det - cte90) : sd; return { risk: risk, sd: sd, cte90: cte90, semidev: semidevBelow(npvs, det), ddMed: pctile(dds, 50), ddWorst: pctile(dds, 10) }; }
    function cteShortfall(npvs, det, p) { var c = cteLow(npvs, p); return (det != null && isFinite(det) && c != null) ? (det - c) : null; }
    function cteShortfallScaled(npvs, det, p, factor) { if (det == null || !isFinite(det)) return null; var s = npvs.map(function (x) { return det + (x - det) * factor; }); var c = cteLow(s, p); return c != null ? (det - c) : null; }

    // ---- surplus note -> TAC adjustment (cumulative net cash flow) ----
    function applyNoteToSurplus(sc) {
      if (!S.surplusNote || !S.surplusNote.on) return sc;
      var ann = EFENG.surplusNoteAnnual(S.surplusNote);
      var cum = 0, cumByYear = {};
      for (var y = 2025; y <= 2055; y++) { cum += (ann[y] || 0); cumByYear[y] = cum; }
      Object.keys(sc).forEach(function (yk) {
        var y = +yk, d = sc[y]; if (!d) return;
        var adj = cumByYear[y] || 0;
        var newTac = d.tac + adj;
        d.tac = newTac; d.ratio = d.reqCap ? newTac / d.reqCap : d.ratio; d.noteAdj = adj;
      });
      return sc;
    }

    // ---- baseline (NEVER sees the growth schedule; anchors MODEL_CANON §1) ----
    function computeBaseline() {
      if (!S.ev || !S.ts || !S.surplus) return;
      S.ev2026 = { rows: S.ev.rows.filter(function (r) { return r.iy === '2026'; }), maxP: S.ev.maxP };
      var P = S.params.assum, ys = S.years.filter(function (y) { return y <= 2035; });
      var vnbs = {}, origFull = {};
      var vnb26 = {};
      PRODS.forEach(function (c) {
        vnbs[c] = { v: EFENG.buildVNB(S.ev, c, { assum: P }, { nMonths: 360 }), full: evFullBook(S.ev, c, null, null) };
        vnbs[c].r = EFENG.vnbResults(vnbs[c].v, P.disc); origFull[c] = vnbs[c].full;
        vnb26[c] = EFENG.buildVNB(S.ev, c, { assum: P }, { nMonths: 360, iy: '2026' });
      });
      S.origLIF = {}; PRODS.forEach(function (c) { S.origLIF[c] = EFENG.evMonthly(S.ev, c, 'LivesInForce1'); });
      S.origClaims = {}; PRODS.forEach(function (c) { S.origClaims[c] = EFENG.evMonthly(S.ev, c, 'IncClaims'); });
      var sc = EFENG.surplusCalc(S.ts, S.surplus, S.params.ts_adj, ys);
      applyNoteToSurplus(sc);
      var minRBC = Math.min.apply(null, [2026, 2027, 2028, 2029, 2030].map(function (y) { return sc[y].ratio; }));
      var de = []; for (var y = 2026; y <= 2055; y++)de.push(PRODS.reduce(function (s, c) { return s + (vnbs[c].v.annual.DE[y] || 0); }, 0));
      var de26 = []; for (var y = 2026; y <= 2055; y++)de26.push(PRODS.reduce(function (s, c) { return s + (vnb26[c].annual.DE[y] || 0); }, 0));
      var npv26 = EFENG.npv(P.disc, de26), irr26b = EFENG.irr(de26);
      S.baseline = { vnbs: vnbs, vnb26: vnb26, origFull: origFull, surplusCalc: sc, minRBC: minRBC, portIRR: EFENG.irr(de), portNPV: EFENG.npv(P.disc, de), npv26: npv26, irr26: irr26b };
      return S.baseline;
    }

    // ---- scalars (FORWARD SALES GROWTH lives here) ----
    function mkScalars(sales, claims, lapse) {
      var base = S.params.scalars, upd = {};
      PRODS.forEach(function (c) {
        // Forward sales projection per scenario: 2026 is the sampled anchor (unchanged);
        // 2027..2035 compound by this product/year's growth rate, year over year.
        // An all-zero schedule reproduces the original flat projection (updSales = anchor
        // every year) byte-for-byte — that is Invariant 2. Growth is applied ONLY to these
        // sampled scenario draws, never to the baseline.
        if (Array.isArray(sales[c])) {
          // Explicit per-year sales table (custom scenario): use the values as-is, by year
          // index, with NO growth applied on top — these ARE the actual sales each year.
          upd[PNAME[c]] = base.years.map(function (y, idx) {
            var v = sales[c][idx];
            return (v != null && isFinite(v)) ? v : 0;
          });
          return;
        }
        var g = (S.growth && S.growth[c]) || {};
        var prev = sales[c];
        upd[PNAME[c]] = base.years.map(function (y, idx) {
          if (idx === 0) return prev;                       // 2026 anchor — never grown
          var rate = (g[y] != null && isFinite(g[y])) ? g[y] : 0;
          prev = prev * (1 + rate);
          return prev;
        });
      });
      var cl = {}, lp = {}; PRODS.forEach(function (c) { cl[PNAME[c]] = claims[c]; lp[PNAME[c]] = lapse[c]; });
      // override origSales with per-year UI values where set; else fall back to the
      // workbook's per-year original-sales anchor for that SAME year (by index).
      var origSalesOverride = {};
      PRODS.forEach(function (c) {
        origSalesOverride[PNAME[c]] = base.years.map(function (y, idx) {
          var ui = S.origSales[c][y];
          if (ui != null && isFinite(ui)) return ui;
          var anchor = (base.origSales[PNAME[c]] || [])[idx];
          return (anchor != null && isFinite(anchor)) ? anchor : base.origSales[PNAME[c]][0];
        });
      });
      return { years: base.years, origSales: origSalesOverride, updSales: upd, claims: cl, lapse: lp };
    }

    // merge two buildVNB results' annual maps (used to combine cohort-split full-book NIER pieces;
    // NII/ATI/DE are linear in cohort reserves so the sum equals one all-book valuation)
    function mergeAnnual(a, b) {
      var out = { annual: {} }, keys = {};
      Object.keys(a.annual).forEach(function (k) { keys[k] = 1; }); Object.keys(b.annual).forEach(function (k) { keys[k] = 1; });
      Object.keys(keys).forEach(function (k) {
        var m = {}, av = a.annual[k] || {}, bv = b.annual[k] || {}, ys = {};
        Object.keys(av).forEach(function (y) { ys[y] = 1; }); Object.keys(bv).forEach(function (y) { ys[y] = 1; });
        Object.keys(ys).forEach(function (y) { m[y] = (av[y] || 0) + (bv[y] || 0); });
        out.annual[k] = m;
      });
      return out;
    }
    // Full-book valuation for the EV side. PN's back book (pre-2026 in-force) uses the
    // separate PN EV NIER schedule (assum 'NIER_EV'); PN new business and MS/HI stay on
    // 'NIER'. MS/HI without a NIER shock use one all-book valuation (byte-identical to the
    // prior behavior). Splitting PN means origFull.PN/recFull.PN reflect the back-book NIER
    // — this only feeds the scenario EV-side TAC delta, never a MODEL_CANON §1 target.
    function evFullBook(rec, c, combShift, procShift) {
      var P = S.params.assum; combShift = combShift || null; procShift = procShift || null;
      if (c !== 'PN' && !combShift && !procShift) {
        return EFENG.buildVNB(rec, c, { assum: P }, { nMonths: 360, allBook: true, pnShift: false });
      }
      var nb = EFENG.buildVNB(rec, c, { assum: P }, { nMonths: 360, pnShift: false, nierShift: combShift });                                            // new business (2026+)
      var infOpts = { nMonths: 360, allBook: true, pnShift: false, iy: '<2026', nierShift: procShift };                                                  // pre-2026 in-force
      if (c === 'PN') infOpts.nierKind = 'NIER_EV';
      var inf = EFENG.buildVNB(rec, c, { assum: P }, infOpts);
      return mergeAnnual(nb, inf);
    }
    // nier (optional): { combined:{PN:map}, proc:{PN:map} } — back-book NIER routed into RBC only.
    // Systematic+process hits 2026+ new business; process-only hits the pre-2026 in-force.
    // When absent, every call is the original single valuation -> §1 / frontier path unchanged.
    function buildScen(sales, claims, lapse, nier) {
      var P = S.params.assum, sc = mkScalars(sales, claims, lapse);
      var rec = EFENG.recalcEV(S.ev, sc), recNB = {}, recFull = {}, recLIF = {};
      var nComb = (nier && nier.combined) || null, nProc = (nier && nier.proc) || null;
      var recClaims = {}; PRODS.forEach(function (c) { recNB[c] = EFENG.buildVNB(rec, c, { assum: P }, { nMonths: 360, nierShift: (nComb && nComb[c]) || null }); recFull[c] = evFullBook(rec, c, nComb && nComb[c], nProc && nProc[c]); recLIF[c] = EFENG.evMonthly(rec, c, 'LivesInForce1'); recClaims[c] = EFENG.evMonthly(rec, c, 'IncClaims'); });
      var baseSc = S.baseline.surplusCalc, ys = S.years.filter(function (y) { return y <= 2035; }), sr = {};
      var prevTac = null, prevBt = null;   // cumulative TAC roll-forward state (no-note basis; note added by applyNoteToSurplus)
      ys.forEach(function (y) {
        var prod = {};
        Object.keys(baseSc[y].prod).forEach(function (pname) { var code = pname === 'PreNeed' ? 'PN' : pname === 'Hospital Indemnity' ? 'HI' : 'MS'; var vi = (y - 2025) * 12; var oL = S.origLIF[code][vi] || 0, rL = recLIF[code] ? (recLIF[code][vi] || 0) : 0, inf = y === 2025 || Math.abs(oL) < 1e-9 ? 1 : rL / oL; var oC = (S.origClaims[code] && S.origClaims[code][vi]) || 0, rC = (recClaims[code] && recClaims[code][vi]) || 0, infC = y === 2025 || Math.abs(oC) < 1e-9 ? 1 : rC / oC; prod[pname] = {}; EFENG.TSC_KEYS.forEach(function (k) { prod[pname][k] = baseSc[y].prod[pname][k] * (k === 'TSC2' ? infC : inf); }); });
        var tot = {}; EFENG.TSC_KEYS.forEach(function (k) { tot[k] = Object.values(prod).reduce(function (s, p) { return s + p[k]; }, 0) + baseSc[y].allOther[k]; });
        var T = tot, pc = T.TSC0 + T.TSC4a + Math.sqrt(Math.pow(T.TSC1 + T.TSLR016 + T.TSC3, 2) + T.TSC1CS * T.TSC1CS + T.TSC2 * T.TSC2 + T.TSC4b * T.TSC4b), rq = pc * 1.03;
        // Scenario TAC — cumulative roll-forward (mirrors Surplus Recalc row 50, V2Slim_Final_4):
        //   seed year:  TAC = baseTAC + Σ(recalc − baseline) PRE-tax income (full book)
        //   year Y>seed: TAC = TAC(Y−1) + ΔbaseTAC(Y) + [baseTAC fell ? PRE-tax : AFTER-tax income delta]
        // Income deltas are full-book (new business + back book) = recFull − origFull.
        var dlt = function (kind) { return PRODS.reduce(function (s, c) { return s + ((recFull[c].annual[kind][y] || 0) - ((S.baseline.origFull[c].annual[kind] || {})[y] || 0)); }, 0); };
        var bt = S.surplus.totalSurplus[y] - S.surplus.nonIns[y] + S.surplus.avr[y];   // no-note baseline TAC
        var tac;
        if (prevTac === null) { tac = bt + dlt('PTI'); }                               // seed (first year): pre-tax delta
        else { tac = bt - prevBt + prevTac + ((bt < prevBt) ? dlt('PTI') : dlt('ATI')); }
        prevTac = tac; prevBt = bt;
        var id = tac - bt;                                                             // cumulative deviation from baseline TAC (display)
        sr[y] = { prod: prod, allOther: baseSc[y].allOther, tot: tot, postCov: pc, reqCap: rq, tac: tac, ratio: tac / rq, incDelta: id, baseRatio: baseSc[y].ratio };
      });
      applyNoteToSurplus(sr);
      var de = {}, cumDE = {}, cum = 0; for (var y = 2026; y <= 2055; y++) { de[y] = PRODS.reduce(function (s, c) { return s + (recNB[c].annual.DE[y] || 0); }, 0); cum += de[y]; cumDE[y] = cum; }
      var deStream = []; for (var y = 2026; y <= 2055; y++)deStream.push(de[y]);
      var portIRR = EFENG.irr(deStream), portNPV = EFENG.npv(P.disc, deStream);

      var rec26 = {}; PRODS.forEach(function (c) { rec26[c] = EFENG.buildVNB(rec, c, { assum: P }, { nMonths: 360, iy: '2026', nierShift: (nComb && nComb[c]) || null }); });   // 2026-issue with the same NIER shock as recNB (null for deterministic)
      var de26 = {}, cumDE26 = {}, cum26 = 0; for (var y = 2026; y <= 2055; y++) { de26[y] = PRODS.reduce(function (s, c) { return s + (rec26[c].annual.DE[y] || 0); }, 0); cum26 += de26[y]; cumDE26[y] = cum26; }
      var deStream26 = []; for (var y = 2026; y <= 2055; y++)deStream26.push(de26[y]);
      var irr26 = EFENG.irr(deStream26), npv26 = EFENG.npv(P.disc, deStream26);
      var cumDE26PosYr = null; for (var y = 2026; y <= 2055; y++) { if (cumDE26[y] > 0) { cumDE26PosYr = y; break; } }
      var de26PosYr = null; for (var y = 2026; y <= 2055; y++) { if (de26[y] > 0) { de26PosYr = y; break; } }

      var minRBC = Math.min.apply(null, [2026, 2027, 2028, 2029, 2030].map(function (y) { return sr[y] ? sr[y].ratio : 0; }));
      var tacChg = {};[2026, 2027, 2028, 2029, 2030, 2031, 2032, 2033, 2034, 2035].forEach(function (y) { var a = sr[y - 1] ? sr[y - 1].tac : (y === 2026 ? (S.surplus.totalSurplus[2025] - S.surplus.nonIns[2025] + S.surplus.avr[2025]) : 0), b = sr[y] ? sr[y].tac : 0; tacChg[y] = (a && isFinite(a) && a !== 0) ? (b - a) / a : 0; });
      var atiBopCS = {};[2026, 2027, 2028, 2029, 2030, 2031, 2032, 2033, 2034, 2035].forEach(function (y) { var ati = PRODS.reduce(function (s, c) { return s + (recFull[c].annual.ATI[y] || 0); }, 0), pt = sr[y - 1] ? sr[y - 1].tac : 0; atiBopCS[y] = pt ? ati / pt : 0; });
      var maxDecline = 0;[2027, 2028, 2029, 2030, 2031, 2032, 2033, 2034, 2035].forEach(function (y) { var a = sr[y - 1], b = sr[y]; if (a && b && a.tac > 0) maxDecline = Math.max(maxDecline, (a.tac - b.tac) / a.tac); });
      // sales may be a scalar 2026 anchor (frontier draws) or a per-year array (custom scenario);
      // weight the target hurdle by the 2026 level either way.
      var s0 = function (v) { return Array.isArray(v) ? v[0] : v; };
      var wMS = s0(sales.MS), wPN = s0(sales.PN), wHI = s0(sales.HI), tot2 = wMS + wPN + wHI;
      var wtdIRR = (wMS * S.hurdles.MS + wPN * S.hurdles.PN + wHI * S.hurdles.HI) / tot2;
      return {
        portIRR: portIRR, portNPV: portNPV, wtdIRR: wtdIRR, minRBC: minRBC, de: de, cumDE: cumDE, atiBopCS: atiBopCS, maxDecline: maxDecline, tacChg: tacChg,
        irr26: irr26, npv26: npv26, de26: de26, cumDE26: cumDE26, de26PosYr: de26PosYr, cumDE26PosYr: cumDE26PosYr,
        surplus: sr, recNB: recNB, recFull: recFull, recLIF: recLIF, scalars: sc
      };
    }

    function stochMetrics(sales, claims, lapse, nier) {
      var P = S.params.assum, sc = mkScalars(sales, claims, lapse), rec = EFENG.recalcEV(S.ev2026 || S.ev, sc), de = [];
      PRODS.forEach(function (c) { var v = EFENG.buildVNB(rec, c, { assum: P }, { nMonths: 360, iy: '2026', nierShift: (nier && nier[c]) || null }); for (var y = 2026; y <= 2055; y++) { de[y - 2026] = (de[y - 2026] || 0) + (v.annual.DE[y] || 0); } });
      var cum = 0, dd = 0; for (var t = 0; t < de.length; t++) { cum += (de[t] || 0); if (cum < dd) dd = cum; }
      return { irr: EFENG.irr(de), npv: EFENG.npv(P.disc, de), dd: dd };
    }

    function evalCons(m, stochR) {
      var c = S.cons, f = [];
      function lbl(n, code, det, full) { return { code: code, num: n, label: full || ('Constraint ' + n), detail: det }; }
      if (m.minRBC < c.rbcFloor) f.push(lbl(1, 'RBC_FLOOR', 'min RBC ' + rx(m.minRBC) + ' < floor ' + rx(c.rbcFloor), 'C1: Min RBC ≥ ' + rx(c.rbcFloor)));
      var minTacChg = Math.min.apply(null, Object.values(m.tacChg));
      if (minTacChg < c.tacChgFloor) f.push(lbl(2, 'TAC_CHG', 'min ΔTAC/BOP TAC ' + pct(minTacChg) + ' < floor ' + pct(c.tacChgFloor), 'C2: ΔTAC/BOP TAC ≥ ' + pct(c.tacChgFloor)));
      if (c.irr3on && m.irr26 != null && m.irr26 < m.wtdIRR) f.push(lbl(3, 'IRR_TARGET', '2026-issue IRR ' + pct(m.irr26) + ' < target ' + pct(m.wtdIRR), 'C3: 2026-issue IRR ≥ weighted target'));
      if (stochR && stochR.irrs && stochR.irrs.length) { var bl = stochR.irrs.filter(function (x) { return x != null && x < c.irrA; }).length, prob = bl / stochR.irrs.length; if (prob > c.irrB) f.push(lbl(4, 'IRR_TAIL', 'P(2026-issue IRR<' + pct(c.irrA) + ')=' + pct(prob) + ' > ' + pct(c.irrB), 'C4: 2026-issue IRR tail risk')); }
      var dy = 2025 + c.deYr; if ((m.de26[dy] || 0) <= 0) f.push(lbl(5, 'DE_BY_YEAR', '2026-issue DE yr ' + c.deYr + ' (' + dy + ')=' + fmt(m.de26[dy] || 0, 2), 'C5: 2026-issue DE > 0 by yr ' + c.deYr));
      var cy = 2025 + c.cumDeYr; if ((m.cumDE26[cy] || 0) <= 0) f.push(lbl(6, 'CUMDE_BY_YEAR', '2026-issue CumDE yr ' + c.cumDeYr + ' (' + cy + ')=' + fmt(m.cumDE26[cy] || 0, 2), 'C6: 2026-issue CumDE > 0 by yr ' + c.cumDeYr));
      var minCumDE26 = Math.min.apply(null, Object.values(m.cumDE26)); if (c.cumDEFloor != null && minCumDE26 < c.cumDEFloor) f.push(lbl(7, 'CUMDE_FLOOR', 'min 2026-issue cumDE $' + fmt(minCumDE26, 1) + 'M < floor $' + fmt(c.cumDEFloor, 1) + 'M', 'C7: CumDE floor ≥ $' + fmt(c.cumDEFloor, 1) + 'M'));
      if (c.de1Floor != null && (m.de26[2026] || 0) < c.de1Floor) f.push(lbl(8, 'DE1_FLOOR', '2026 (year-1) DE $' + fmt(m.de26[2026] || 0, 1) + 'M < floor $' + fmt(c.de1Floor, 1) + 'M', 'C8: Year-1 DE floor ≥ $' + fmt(c.de1Floor, 1) + 'M'));
      if (stochR && stochR.minRBCs && stochR.minRBCs.length && c.rbcTailX != null && c.rbcTailY != null) {   // C9 trough-RBC tail (Slow mode only)
        var rb = stochR.minRBCs.filter(function (r) { return r != null && r < c.rbcTailX; }).length, rprob = rb / stochR.minRBCs.length;
        if (rprob > c.rbcTailY) f.push(lbl(9, 'RBC_TAIL', 'P(trough RBC<' + rx(c.rbcTailX) + ')=' + pct(rprob) + ' > ' + pct(c.rbcTailY), 'C9: RBC tail — P(trough RBC < ' + rx(c.rbcTailX) + ') ≤ ' + pct(c.rbcTailY)));
      }
      return f;
    }
    function markFrontier(arr) { var feas = arr.filter(function (s) { return s.feasible && s.portNPV != null && isFinite(s.portNPV); }); feas.forEach(function (s) { s.isFrontier = !feas.some(function (o) { return o !== s && o.portNPV >= s.portNPV && o.risk <= s.risk && (o.portNPV > s.portNPV || o.risk < s.risk); }); }); }
    function frontierSetBy(riskFn) {
      var feas = S.results.filter(function (s) { return !s.isCustom && s.feasible && isFinite(s.portNPV) && isFinite(riskFn(s)); });
      var set = {};
      feas.forEach(function (s) { var dom = feas.some(function (o) { return o !== s && o.portNPV >= s.portNPV && riskFn(o) <= riskFn(s) && (o.portNPV > s.portNPV || riskFn(o) < riskFn(s)); }); if (!dom) set[s.id] = true; });
      return set;
    }
    function _ddFromCum(cum) { var d = 0; for (var y = 2026; y <= 2055; y++) { var v = cum[y]; if (v != null && v < d) d = v; } return d; }
    var _now = (typeof performance !== 'undefined' && performance.now) ? function () { return performance.now(); } : function () { return Date.now(); };
    // Shared frontier sweep — one source of compute truth for the viewer Web Worker, the viewer
    // main-thread fallback, and the headless runner. Async so the fallback can yield via opts.onYield
    // (time-budgeted); the worker/runner pass no callbacks and run a tight, unthrottled loop.
    // opts: { onProgress(done,n), onYield(), onTick(i,k,n,ns), startResults, onPartial(result,i) } — all optional.
    // startResults seeds `results` with already-computed scenarios (checkpoint/resume): the LHS arrays and
    // shock BANK are prebuilt from the seed and the per-scenario compute reads only BANK[k]/msA[i] (no
    // sequential RNG in the loop), so resuming at index startResults.length reproduces the identical full
    // set for a given seed. onPartial streams each completed scenario for persistence. Both are no-ops when
    // absent, so a normal run is byte-identical to before (validation gate). Returns marked results.
    async function runSweep(opts) {
      opts = opts || {};
      var n = S.nScen, ns = S.nStoch, slow = S.slowMode;
      setSeed(S.seed != null ? S.seed : STOCH_SEED);
      var msA = lhs(n, S.bounds.MS[0], S.bounds.MS[1]), pnA = lhs(n, S.bounds.PN[0], S.bounds.PN[1]), hiA = lhs(n, S.bounds.HI[0], S.bounds.HI[1]);
      var BANK = buildShockBank(ns), _yt = _now();
      var results = (opts.startResults && opts.startResults.length) ? opts.startResults.slice(0, n) : [];
      for (var i = results.length; i < n; i++) {
        var sales = { MS: msA[i], PN: pnA[i], HI: hiA[i] }, u = { MS: 1, PN: 1, HI: 1 };
        var det = buildScen(sales, u, u);
        var sIRRs = [], sNPVs = [], sDD = [], sMinRBC = [], stochScalarsList = [];
        for (var k = 0; k < ns; k++) {
          var _s = shockFromBank(BANK[k]), cm = _s.cm, lm = _s.lm, nm = _s.nm;
          stochScalarsList.push({ claims: Object.assign({}, cm), lapse: Object.assign({}, lm), nier: Object.assign({}, nm), nierProc: Object.assign({}, _s.nmProc) });
          if (slow) { var sm = buildScen(sales, cm, lm, { combined: _s.nm, proc: _s.nmProc }); sIRRs.push(sm.irr26); sNPVs.push(sm.npv26); sDD.push(_ddFromCum(sm.cumDE26)); sMinRBC.push(sm.minRBC); }
          else { var sm = stochMetrics(sales, cm, lm, nm); sIRRs.push(sm.irr); sNPVs.push(sm.npv); sDD.push(sm.dd); }
          if (opts.onYield && _now() - _yt > 40) { if (opts.onTick) opts.onTick(i, k, n, ns); await opts.onYield(); _yt = _now(); }
        }
        var dr = downsideRisk(sNPVs, sDD, det.npv26);
        var fails = evalCons(det, slow ? { irrs: sIRRs, minRBCs: sMinRBC } : { irrs: sIRRs });
        results.push({ id: i + 1, sales: sales, portIRR: det.irr26, portNPV: det.npv26, wtdIRR: det.wtdIRR, risk: dr.risk, portIRRAll: det.portIRR, portNPVAll: det.portNPV, irr26: det.irr26, npv26: det.npv26, de26: det.de26, cumDE26: det.cumDE26, minRBC: det.minRBC, de: det.de, cumDE: det.cumDE, atiBopCS: det.atiBopCS, maxDecline: det.maxDecline, tacChg: det.tacChg, scalars: det.scalars, stochIRRs: sIRRs, stochNPVs: sNPVs, stochMinRBC: slow ? sMinRBC : null, stochScalars: stochScalarsList, riskSD: dr.sd, cte90: dr.cte90, semidev: dr.semidev, ddMed: dr.ddMed, ddWorst: dr.ddWorst, stochDD: sDD, failures: fails, feasible: fails.length === 0, isFrontier: false });
        if (opts.onPartial) opts.onPartial(results[results.length - 1], i);
        if (opts.onProgress) opts.onProgress(i + 1, n);
        if (opts.onYield) await opts.onYield();
      }
      markFrontier(results);
      return results;
    }

    return {
      setSeed: setSeed, mulberry32: mulberry32, nrand: nrand, lhs: lhs, nvec: nvec,
      buildShockBank: buildShockBank, shockFromBank: shockFromBank,
      pctile: pctile, stddev: stddev, cteLow: cteLow, semidevBelow: semidevBelow,
      downsideRisk: downsideRisk, cteShortfall: cteShortfall, cteShortfallScaled: cteShortfallScaled,
      applyNoteToSurplus: applyNoteToSurplus, computeBaseline: computeBaseline, mkScalars: mkScalars, buildScen: buildScen,
      stochMetrics: stochMetrics, evalCons: evalCons, markFrontier: markFrontier, frontierSetBy: frontierSetBy, runSweep: runSweep,
      STOCH_SEED: STOCH_SEED, NYEARS: NYEARS, fmt: fmt, pct: pct, rx: rx
    };
  }

  return { create: create };
});
