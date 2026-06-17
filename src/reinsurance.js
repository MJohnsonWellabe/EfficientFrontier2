// reinsurance.js — Medicare Supplement quota-share reinsurance layer (MS only).
//
// An OPT-IN treaty modeled like the surplus note: when `cfg.on` is false, none of
// this runs and every result is byte-identical to the no-reinsurance model. When on,
// the cession is computed ONCE deterministically in `frontier.js → computeBaseline`
// (a "retained EV" + ceding commissions + retained-share RBC charge scaling); the
// efficient-frontier scenarios then scale off that already-reinsured baseline — the
// cession logic is never re-applied per scenario. See CLAUDE.md / the reinsurance tab.
//
// Mechanics (mirrors the BlockbusterDeals quota-share engine, adapted to EF's
// disaggregated EV/RBC data, MS only):
//   • Cede share by MS issue year, with a 1-year cession lag (business issued in a
//     policy year is reinsured starting the following calendar year).
//   • Retained EV: MS EarnedPrem/IncClaims/TabRes/CLRes/TS scale by the retained
//     fraction (1−cede). Counts (LivesInForce1/LivesIssued) and the cedant's own
//     expenses (Comm/PremTax/Acq/Maint) stay GROSS — the reinsurer reimburses the
//     ceded expense load through the ceding commission, not by netting the EV.
//   • Ceding commissions: an upfront cash schedule + an ongoing sliding-scale
//     allowance ($/policy/yr that falls as the MS loss ratio rises).
//   • RBC: MS charges scale by retained share — lives ratio for the premium-related
//     charges (TSC0/TSC1/TSLR016/TSC1CS/TSC3), claims ratio for TSC2; TSC4a/TSC4b
//     are unchanged (not relieved by a quota share). Mirrors compute_net_rbc.
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) { module.exports = factory(); }
  else { root.EFENG = root.EFENG || {}; var m = factory(); for (var k in m) root.EFENG[k] = m[k]; }
})(typeof self !== "undefined" ? self : this, function () {
  'use strict';

  // EV rows are keyed by the product CODE ('MS'); surplusCalc charges by the full NAME.
  var MS_CODE = 'MS';
  var MS_NAME = 'Medicare Supplement';

  // Calendar year of EV month index p. p=0 → Dec 2025 → 2025; p=1..12 → 2026; etc.
  function calYearOf(p) { return p <= 0 ? 2025 : 2026 + Math.floor((p - 1) / 12); }

  // Issue year as a number (the <2026 back book is treated as issued 2025).
  function issuedYear(iy) { return iy === '<2026' ? 2025 : parseInt(iy, 10); }

  // Cede fraction (0..1) for an MS cohort `iy` at EV month index p, with the lag.
  function cedeRate(cfg, iy, p) {
    if (!cfg || !cfg.on) return 0;
    var c = (cfg.cede && cfg.cede[iy] != null) ? +cfg.cede[iy] : 0;
    if (!(c > 0)) return 0;
    var lag = (cfg.lagYears != null) ? +cfg.lagYears : 1;
    if (calYearOf(p) < issuedYear(iy) + lag) return 0;   // not yet ceded
    return Math.min(Math.max(c, 0), 1);
  }

  // Build the "retained EV": a proportional quota share scales EVERY MS row (premium,
  // claims, reserves, expenses AND lives counts) by the retained fraction (1−cede) per
  // period, so the retained MS book is exactly (1−cede) of the gross block — the cedant's
  // own per-policy expense is ceded in the same proportion (the reinsurer's expense/profit
  // reimbursement is the separate ceding commission). Non-MS rows pass through unchanged.
  //
  // Period-varying cession (the 1-year lag) is safe through recalcEV: the only cession
  // step-changes for a cohort fall in recalcEV's *build* regime (proportional/additive,
  // issue year..+1); its persistency-ratio regime starts at issue year+2, by which point
  // the cohort's cede rate is constant, so the (1−cede) factor cancels in every ratio.
  function buildRetainedEV(ev, cfg) {
    if (!cfg || !cfg.on) return ev;
    var out = [];
    for (var i = 0; i < ev.rows.length; i++) {
      var r = ev.rows[i];
      if (r.prod !== MS_CODE) { out.push(r); continue; }
      var vals = new Float64Array(ev.maxP + 1);
      for (var p = 0; p <= ev.maxP; p++) vals[p] = r.vals[p] * (1 - cedeRate(cfg, r.iy, p));
      out.push({ iy: r.iy, nb: r.nb, prod: r.prod, varName: r.varName, vals: vals });
    }
    return { rows: out, maxP: ev.maxP };
  }

  // Per-year retained share of the MS book, at year-end month index vi=(y−2025)*12
  // (the same point-in-time index frontier.js → buildScen uses to scale charges).
  // Returns { y: { lives, claims } } as retained ratios in [0,1].
  function retainedRatios(ev, cfg, years) {
    var out = {};
    for (var yi = 0; yi < years.length; yi++) {
      var y = years[yi], vi = (y - 2025) * 12;
      if (vi > ev.maxP) vi = ev.maxP;
      var gL = 0, rL = 0, gC = 0, rC = 0;
      for (var i = 0; i < ev.rows.length; i++) {
        var r = ev.rows[i]; if (r.prod !== MS_CODE) continue;
        var vn = r.varName.toLowerCase();
        if (vn === 'livesinforce1') { var lv = r.vals[vi] || 0; gL += lv; rL += lv * (1 - cedeRate(cfg, r.iy, vi)); }
        else if (vn === 'incclaims') { var cv = r.vals[vi] || 0; gC += cv; rC += cv * (1 - cedeRate(cfg, r.iy, vi)); }
      }
      out[y] = { lives: gL ? rL / gL : 1, claims: gC ? rC / gC : 1 };
    }
    return out;
  }

  // Scale a surplusCalc result's MS charges by retained share, in place, and
  // recompute totals / covariance / required capital / ratio for each year.
  // ratios: output of retainedRatios. TSC_KEYS/PostCov mirror rbc-surplus.js.
  function scaleMSCharges(sc, ratios) {
    var KEYS = ['TSC0', 'TSC1', 'TSLR016', 'TSC1CS', 'TSC2', 'TSC3', 'TSC4a', 'TSC4b'];
    var LIVES = { TSC0: 1, TSC1: 1, TSLR016: 1, TSC1CS: 1, TSC3: 1 };  // premium-related: lives ratio
    Object.keys(sc).forEach(function (yk) {
      var y = +yk, d = sc[y], rr = ratios[y]; if (!d || !rr || !d.prod || !d.prod[MS_NAME]) return;
      var ms = d.prod[MS_NAME];
      KEYS.forEach(function (k) {
        if (k === 'TSC2') ms[k] = ms[k] * rr.claims;
        else if (LIVES[k]) ms[k] = ms[k] * rr.lives;
        // TSC4a / TSC4b: unchanged by a quota share
      });
      var tot = {};
      KEYS.forEach(function (k) {
        tot[k] = Object.keys(d.prod).reduce(function (s, pn) { return s + d.prod[pn][k]; }, 0) + d.allOther[k];
      });
      var T = tot;
      var postCov = T.TSC0 + T.TSC4a + Math.sqrt(Math.pow(T.TSC1 + T.TSLR016 + T.TSC3, 2) + T.TSC1CS * T.TSC1CS + T.TSC2 * T.TSC2 + T.TSC4b * T.TSC4b);
      d.tot = tot; d.postCov = postCov; d.reqCap = postCov * 1.03;
      d.ratio = d.reqCap ? d.tac / d.reqCap : d.ratio;
    });
    return sc;
  }

  // Ongoing-commission sliding scale: $/policy/yr for a loss ratio, matched
  // lr >= lo AND lr < hi (last band hi = Infinity). Mirrors lookup_cco.
  function lookupCco(lr, table) {
    if (!table || !table.length) return 0;
    for (var i = 0; i < table.length; i++) {
      var lo = +table[i][0], hi = table[i][1], comm = +table[i][2];
      hi = (hi === Infinity || hi === 'Inf' || hi == null) ? Infinity : +hi;
      if (lr >= lo && lr < hi) return comm;
    }
    return +table[table.length - 1][2];
  }

  // Ceding commissions paid by the reinsurer to the cedant, $M by calendar year.
  //   upfront(y): the negotiated front-end schedule (cfg.commUpfront), as-is.
  //   ongoing(y): ceded MS policy-years × the sliding-scale $/policy from the MS
  //               loss ratio that year. Computed on the GROSS EV.
  // Returns { upfront:{y}, ongoing:{y}, total:{y} } over 2026..maxYear.
  function cedingCommissions(ev, cfg) {
    var upfront = {}, ongoing = {}, total = {};
    if (!cfg || !cfg.on) return { upfront: upfront, ongoing: ongoing, total: total };
    var maxY = calYearOf(ev.maxP);
    // gross MS premium / claims / ceded-policy-months by calendar year
    var prem = {}, clm = {}, cededPolMonths = {};
    for (var y = 2026; y <= maxY; y++) { prem[y] = 0; clm[y] = 0; cededPolMonths[y] = 0; }
    for (var i = 0; i < ev.rows.length; i++) {
      var r = ev.rows[i]; if (r.prod !== MS_CODE) continue;
      var vn = r.varName.toLowerCase();
      if (vn !== 'earnedprem' && vn !== 'incclaims' && vn !== 'livesinforce1') continue;
      for (var p = 1; p <= ev.maxP; p++) {
        var y2 = calYearOf(p); if (y2 < 2026) continue;
        if (vn === 'earnedprem') prem[y2] += r.vals[p];
        else if (vn === 'incclaims') clm[y2] += r.vals[p];
        else cededPolMonths[y2] += (r.vals[p] || 0) * cedeRate(cfg, r.iy, p);
      }
    }
    for (var y3 = 2026; y3 <= maxY; y3++) {
      upfront[y3] = (cfg.commUpfront && +cfg.commUpfront[y3]) || 0;     // $M, as entered
      var lr = prem[y3] ? clm[y3] / prem[y3] : 0;
      var cco = lookupCco(lr, cfg.commTable);                          // $/policy/yr
      ongoing[y3] = (cededPolMonths[y3] / 12) * cco / 1e6;             // ceded policy-yrs × $/pol → $M
      total[y3] = upfront[y3] + ongoing[y3];
    }
    return { upfront: upfront, ongoing: ongoing, total: total };
  }

  return {
    reinsCalYearOf: calYearOf,
    reinsCedeRate: cedeRate,
    buildRetainedEV: buildRetainedEV,
    retainedRatios: retainedRatios,
    scaleMSCharges: scaleMSCharges,
    cedingCommissions: cedingCommissions,
    lookupCco: lookupCco
  };
});
