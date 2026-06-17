(function(){'use strict';
var S={ev:null,ts:null,surplus:null,params:null,baseline:null,origLIF:null,chart:null,
  bounds:{MS:[250,350],PN:[200,240],HI:[18,25]},hurdles:{MS:.12,PN:.10,HI:.10},
  origSales:{MS:{2026:212.92,2027:200,2028:200,2029:200,2030:200},PN:{2026:230.0,2027:253.0,2028:278.3,2029:306.13,2030:336.743},HI:{2026:19.124725,2027:20.08096125,2028:21.0850093125,2029:22.139259778125,2030:23.24622276703125}},
  claimsSD:{MS:.04,PN:.035,HI:.055},claimsProcSD:{MS:.03,PN:.02,HI:.04},lapseSD:{MS:.065,PN:.045,HI:.07},lapseProcSD:{MS:.03,PN:.02,HI:.04},procCorr:{MS:.25,PN:.50,HI:.25},
  nierSD:{MS:0,PN:.0035,HI:0},nierProcSD:{MS:0,PN:.0015,HI:0},   // PN-only additive-bps NIER shock σ (35bps syst / 15bps proc; PN claimsSD now = mortality σ, lapseSD/procCorr retired for PN)
  nScen:100,nStoch:100,seed:null,lastRunSeed:null,slowMode:false,_wakeLock:null,_running:false,
  cons:{rbcFloor:4.0,tacChgFloor:-.12,irr3on:true,irrA:.08,irrB:.15,deYr:4,cumDeYr:10,cumDEFloor:-180,de1Floor:-150,rbcTailX:3.5,rbcTailY:.25},
  surplusNote:{on:true,amount:150,tenor:10,rate:0.09,fees:0.03,nierSN:0.04,startDate:'2026-06-30'},
  sel:{scen:'base',sens:'det'},
  cmp:{a:'base',b:'base'},
  results:[],years:[],vnbProd:'MS',vnbBasis:'orig',rbcBasis:'orig'};
var PRODS=['MS','PN','HI'],PNAME={MS:'Medicare Supplement',PN:'Preneed',HI:'Hospital Indemnity'},PSURP={MS:'Medicare Supplement',PN:'PreNeed',HI:'Hospital Indemnity'};
var SALES_YEARS=[2026,2027,2028,2029,2030,2031,2032,2033,2034,2035];
for(var _y=2025;_y<=2055;_y++)S.years.push(_y);
function fmt(x,d){if(x==null||!isFinite(x))return'—';return Number(x).toFixed(d!=null?d:2);}
function pct(x,d){if(x==null||!isFinite(x))return'—';return(x*100).toFixed(d!=null?d:1)+'%';}
function rx(x){if(x==null||!isFinite(x))return'—';return x.toFixed(3)+'×';}
function sb(k,v,sub){return'<div class="stat-box"><span class="stat-lbl">'+k+'</span><span class="stat-val">'+v+'</span>'+(sub?'<span class="stat-sub">'+sub+'</span>':'')+'</div>';}
// Yield to the event loop WITHOUT setTimeout's background-tab clamp (≥1s when hidden):
// a MessageChannel macrotask is not throttled, so the run keeps progressing in an unfocused tab.
var _yieldCh=(typeof MessageChannel!=='undefined')?new MessageChannel():null,_yieldQ=[];
if(_yieldCh)_yieldCh.port1.onmessage=function(){var r=_yieldQ.shift();if(r)r();};
function sleep(){return new Promise(function(r){if(_yieldCh){_yieldQ.push(r);_yieldCh.port2.postMessage(0);}else{setTimeout(r,0);}});}

/* ---- data + shared compute wiring ----
   Workbook-derived inputs are fetched from data/ at runtime (no embedded blobs).
   The viewer computes in-browser using the SAME frontier.js module the headless
   runner/ uses — one source of compute truth, no viewer/runner drift. */
var EMBEDDED={};
var F=EFFRONTIER.create(S,EFENG);
S.seed=F.STOCH_SEED;   // default RNG seed (overridable via the Config seed input / Randomize)
// Sales to feed a scenario recompute: a custom scenario carries an explicit per-year
// salesTable (used verbatim, no growth); frontier scenarios only have a 2026 anchor
// (scalar) which mkScalars grows by the schedule. Use this everywhere a scenario is re-run.
function scenSales(scen){return (scen&&scen.salesTable)||(scen&&scen.sales);}
// drawdown (most-negative cumulative 2026-issue DE) from a buildScen cumDE26 map — matches stochMetrics' dd
function ddFromCum(cum){var d=0;for(var y=2026;y<=2055;y++){var v=cum[y];if(v!=null&&v<d)d=v;}return d;}
var lhs=F.lhs,buildShockBank=F.buildShockBank,shockFromBank=F.shockFromBank,
    pctile=F.pctile,stddev=F.stddev,cteLow=F.cteLow,semidevBelow=F.semidevBelow,
    downsideRisk=F.downsideRisk,cteShortfall=F.cteShortfall,cteShortfallScaled=F.cteShortfallScaled,
    frontierSetBy=F.frontierSetBy,mkScalars=F.mkScalars,buildScen=F.buildScen,
    stochMetrics=F.stochMetrics,evalCons=F.evalCons,markFrontier=F.markFrontier,
    applyNoteToSurplus=F.applyNoteToSurplus;
var STOCH_SEED=F.STOCH_SEED;
// Baseline compute is pure (frontier.js) and NEVER sees S.growth (Invariant 1); the
// viewer wraps it only to redraw the baseline cumulative-DE table.
function computeBaseline(){F.computeBaseline();renderCumDEBaseline();}
/* ---- forward sales-growth schedule (scenario draws only) ----
   Per-product annual growth for 2027..2035, compounded off the 2026 anchor. Applied ONLY
   to the sampled efficient-frontier draws (see frontier.js mkScalars), never the baseline.
   Defaults: MS 0% every year; PN 10% (2027-2029) then 6% (2030-2035); HI 5% every year. */
function defaultGrowth(){var g={MS:{},PN:{},HI:{}};SALES_YEARS.forEach(function(y){if(y===2026)return;g.MS[y]=(y===2027)?-0.12:(y===2028||y===2029)?0.0:(y===2030||y===2031)?0.10:0.05;g.PN[y]=0.10;g.HI[y]=0.05;});return g;}
S.growth=defaultGrowth();
function refreshGrowthUI(){
  var gy=SALES_YEARS.filter(function(y){return y>=2027;});
  var shortName={MS:'Med Supp',PN:'Preneed',HI:'Hosp Ind'};
  var h='<thead><tr><th>Product</th>'+gy.map(function(y){return'<th>'+y+'</th>';}).join('')+'</tr></thead><tbody>';
  PRODS.forEach(function(c){
    h+='<tr><td>'+shortName[c]+'</td>'+gy.map(function(y){
      var v=((S.growth&&S.growth[c]&&S.growth[c][y])||0)*100;
      return'<td><input type="number" id="gr_'+c+'_'+y+'" value="'+(+v.toFixed(3))+'" step="0.5" style="width:58px;font-size:11px;padding:2px 4px;font-family:var(--mono);border:1px solid var(--line);border-radius:4px;text-align:right"></td>';
    }).join('')+'</tr>';
  });
  document.getElementById('growthTbl').innerHTML=h+'</tbody>';
  var f='<div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center;font-size:11px"><span style="color:var(--muted)">Fill all years (2027-2035) with one rate:</span>';
  PRODS.forEach(function(c){f+='<span style="display:inline-flex;gap:4px;align-items:center">'+shortName[c]+' <input type="number" id="grfill_'+c+'" value="0" step="0.5" style="width:54px;font-size:11px;padding:2px 4px;font-family:var(--mono);border:1px solid var(--line);border-radius:4px;text-align:right"><span>%</span><button class="btn ghost sm" type="button" id="grfillbtn_'+c+'">Fill</button></span>';});
  f+='</div>';
  document.getElementById('growthFill').innerHTML=f;
  PRODS.forEach(function(c){
    gy.forEach(function(y){var el=document.getElementById('gr_'+c+'_'+y);if(el)el.addEventListener('change',readInputs);});
    var btn=document.getElementById('grfillbtn_'+c);if(btn)btn.addEventListener('click',function(){fillGrowth(c);});
  });
}
function fillGrowth(c){
  var v=+(document.getElementById('grfill_'+c)||{value:0}).value||0;
  SALES_YEARS.filter(function(y){return y>=2027;}).forEach(function(y){var el=document.getElementById('gr_'+c+'_'+y);if(el)el.value=v;});
  readInputs();
}
/* ---- Step 2: seeded Common-Random-Numbers + antithetic variance reduction ----
   Risk estimates now use ONE shared bank of standard-normal draws across every sales
   scenario (CRN) and pair each draw with its mirror (antithetic). The deterministic
   calc engine (EFENG) and per-draw mechanics are untouched: shocks are still applied as
   lognormal multipliers exp(z*sd - sd^2/2); we only changed WHICH z's feed them and that
   the same z's are reused across scenarios. Same seed -> identical frontier on rerun. */
/* One bank of ns draws, each a 6-vector of standard-normal z's (claims & lapse × MS/PN/HI),
   antithetic-paired. Built ONCE per run and reused for every scenario = common random numbers. */
/* Each draw: a SYSTEMATIC z per product/risk (one persistent shock) + a PROCESS z-vector per
   product/risk (independent each year). Antithetic pairing mirrors the entire draw. */
/* Combine systematic + process into a per-YEAR lognormal multiplier (mean 1):
   mult(y) = exp( z_sys*sigma_sys + z_proc[y]*sigma_proc - 0.5*(sigma_sys^2 + sigma_proc^2) ).
   Returns per-product per-year maps {2026:m,...}. process=0 -> constant across years (single shock). */
/* ---- Step 3: downside risk metrics ----
   Replaces std-dev (which penalizes upside equally) with measures the board / rating agencies
   actually use. Primary axis = CTE-90 shortfall: how much 2026 PVDE the worst 10% of outcomes
   give up versus the deterministic plan. Also computes downside semi-deviation and the
   stochastic max-drawdown (deepest cumulative-DE point) distribution. Std-dev kept for reference. */
function _dlCSV(content,fname){var blob=new Blob([content],{type:'text/csv;charset=utf-8;'});var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=fname;a.click();setTimeout(function(){URL.revokeObjectURL(a.href);},1000);}

/* ---- Download templates ---- */
function downloadEVTemplate(){_dlCSV(EMBEDDED.ev,'InputEV.csv');}
function downloadTSTemplate(){_dlCSV(EMBEDDED.ts,'InputTS.csv');}
function downloadSurplusTemplate(){_dlCSV(EMBEDDED.surplus,'InputSurplus.csv');}
function _UNUSED_downloadEVTemplate_OLD(){
  var cols=['ck.IssYear','ck.NewBus','Product','VarName'];
  for(var i=0;i<=360;i++)cols.push('Value'+String(i).padStart(3,'0'));
  var rows=[cols.join(','),
    '// Required: ck.IssYear (<2026 or 2026-2035), ck.NewBus (Y/N), Product (MS/PN/HI), VarName, then 361 monthly values',
    '// Variables: EarnedPrem ReinsPrem IncClaims ReinsClaims TabRes CLRes CededALRstat TS Comm PremTax LivesIssued LivesInForce1',
    '// Value000=Dec baseYear, Value001=Jan yr1, Value012=Dec yr1, Value013=Jan yr2, ...',
    '<2026,N,MS,EarnedPrem'+',0'.repeat(361)];
  _dlCSV(rows.join('\n'),'EV_template.csv');
}

function downloadScenCSV(){
  if(!S.results.length){alert('Run the frontier first.');return;}
  var h=['ID','MS','PN','HI','PVDE','DownsideCTE90','WorstDD','RiskSD','SemiDev','IRR','MinRBC','PctTroughRBCbelow','WtdTargetIRR','Feasible','Frontier','Failures'];
  var rows=[h.join(',')];
  S.results.forEach(function(r){var rp=(r.stochMinRBC&&r.stochMinRBC.length)?pct(r.stochMinRBC.filter(function(x){return x<S.cons.rbcTailX;}).length/r.stochMinRBC.length,1):'';rows.push([r.id,fmt(r.sales.MS,1),fmt(r.sales.PN,1),fmt(r.sales.HI,1),fmt(r.portNPV,2),fmt(r.risk,2),fmt(r.ddWorst,2),fmt(r.riskSD,2),fmt(r.semidev,2),pct(r.portIRR,3),rx(r.minRBC),rp,pct(r.wtdIRR,3),r.feasible?1:0,r.isFrontier?1:0,r.failures.map(function(f){return f.code;}).join(';')].join(','));});
  _dlCSV(rows.join('\n'),'frontier_results.csv');
}

/* ---- Export the systematic/process scalar stream for the SELECTED scenario + run,
   laid out cell-for-cell for the workbook Scalars sheet (see tools/per_year_scalars.py),
   so it can be pasted into Excel and recalced for an apples-to-apples RBC comparison.
   The run's draws are recovered by deterministically replaying the SAME seeded shock
   bank that runFrontier built (CRN), then split into systematic x process[y] exactly as
   shockFromBank combines them: mult(y)=exp(z_sys*sig_sys+z_proc[y]*sig_proc-0.5*(sig_sys^2+sig_proc^2)). */
function exportScalars(){
  if(!S.results.length){alert('Run the frontier first.');return;}
  var scen=currentScen();
  if(!scen){alert('Pick a scenario (not Baseline) in the SCENARIO dropdown first.');return;}
  var sensId=S.sel.sens||'det';
  var YEARS=[];for(var y=2026;y<=2055;y++)YEARS.push(y);
  var clSys={MS:1,PN:1,HI:1},tmSys={MS:1,PN:1,HI:1},nierSys=0,clProc={},tmProc={};
  var nierProc=YEARS.map(function(){return 0;});
  PRODS.forEach(function(c){clProc[c]=YEARS.map(function(){return 1;});tmProc[c]=YEARS.map(function(){return 1;});});
  var runLabel='Deterministic (no shocks)';
  if(sensId!=='det'){
    F.setSeed(S.lastRunSeed!=null?S.lastRunSeed:STOCH_SEED); // replay runFrontier's RNG order exactly (the seed that produced these results)
    lhs(S.nScen,S.bounds.MS[0],S.bounds.MS[1]);lhs(S.nScen,S.bounds.PN[0],S.bounds.PN[1]);lhs(S.nScen,S.bounds.HI[0],S.bounds.HI[1]);
    var BANK=buildShockBank(S.nStoch),k=+sensId;
    if(k<0||k>=BANK.length){alert('Selected run is out of range — re-run the frontier.');return;}
    var b=BANK[k];runLabel='Run '+(k+1);
    function ln(z,sig){return Math.exp(z*sig-0.5*sig*sig);}
    PRODS.forEach(function(c){
      if(c==='PN'){
        var mS=S.claimsSD.PN||0,mP=(S.claimsProcSD&&S.claimsProcSD.PN)||0;
        clSys.PN=ln(b.cs.PN,mS);clProc.PN=YEARS.map(function(yy,i){return ln(b.cp.PN[i],mP);});
        tmSys.PN=clSys.PN;tmProc.PN=clProc.PN.slice();                 // PN term == PN claims (coupled mortality)
      }else{
        var cS=S.claimsSD[c]||0,cP=(S.claimsProcSD&&S.claimsProcSD[c])||0,lS=S.lapseSD[c]||0,lP=(S.lapseProcSD&&S.lapseProcSD[c])||0;
        var rho=(S.procCorr&&S.procCorr[c])||0,rr=Math.sqrt(Math.max(0,1-rho*rho));
        clSys[c]=ln(b.cs[c],cS);clProc[c]=YEARS.map(function(yy,i){return ln(b.cp[c][i],cP);});
        tmSys[c]=ln(b.ls[c],lS);tmProc[c]=YEARS.map(function(yy,i){return ln(rho*b.cp[c][i]+rr*b.lp[c][i],lP);});
      }
    });
    var niS=(S.nierSD&&S.nierSD.PN)||0,niP=(S.nierProcSD&&S.nierProcSD.PN)||0;
    nierSys=b.ni.PN*niS;nierProc=YEARS.map(function(yy,i){return b.nip.PN[i]*niP;});
  }
  var sc=mkScalars(scenSales(scen),{MS:1,PN:1,HI:1},{MS:1,PN:1,HI:1}),salesScalar={};
  PRODS.forEach(function(c){var up=sc.updSales[PNAME[c]],og=sc.origSales[PNAME[c]];salesScalar[c]=SALES_YEARS.map(function(yy,i){return up[i]/og[i];});});
  var ss=sensScalars(scen,sensId),det=buildScen(scenSales(scen),ss.claims,ss.lapse,ss.nier);
  var rbcNo={},rbcNote={},tac={},req={};
  SALES_YEARS.forEach(function(yy){var d=det.surplus[yy];if(!d)return;req[yy]=d.reqCap;tac[yy]=d.tac;rbcNote[yy]=d.ratio;rbcNo[yy]=d.reqCap?(d.tac-(d.noteAdj||0))/d.reqCap:null;});
  function rowY(label,vals){return [label].concat(vals).join(',');}
  function rowS(label,v){var a=[label,v];for(var i=1;i<YEARS.length;i++)a.push('');return a.join(',');}
  function rowSal(label,vals){var a=[label].concat(vals);for(var i=vals.length;i<YEARS.length;i++)a.push('');return a.join(',');}
  var L=[];
  L.push('# EfficientFrontier scalar stream  scenario #'+scen.id+' (MS/PN/HI '+fmt(scen.sales.MS,1)+'/'+fmt(scen.sales.PN,1)+'/'+fmt(scen.sales.HI,1)+')  '+runLabel+'  seed='+(S.lastRunSeed!=null?S.lastRunSeed:STOCH_SEED));
  L.push('# Paste each value range into the indicated Scalars! cells, then recalc. Years 2026..2055. Sales scalars paste as VALUES over C12:L14.');
  L.push(rowY('label \\ year',YEARS));
  L.push(rowSal('Sales scalar MS (C12:L12)',salesScalar.MS));
  L.push(rowSal('Sales scalar PN (C13:L13)',salesScalar.PN));
  L.push(rowSal('Sales scalar HI (C14:L14)',salesScalar.HI));
  L.push(rowS('Claims systematic MS (C17)',clSys.MS));
  L.push(rowS('Claims systematic PN (C18)',clSys.PN));
  L.push(rowS('Claims systematic HI (C19)',clSys.HI));
  L.push(rowS('Term systematic MS (C22)',tmSys.MS));
  L.push(rowS('Term systematic PN (C23)',tmSys.PN));
  L.push(rowS('Term systematic HI (C24)',tmSys.HI));
  L.push(rowS('NIER systematic PN (C26)',nierSys));
  L.push(rowY('Claims process MS (C29:AF29)',clProc.MS));
  L.push(rowY('Claims process PN (C30:AF30)',clProc.PN));
  L.push(rowY('Claims process HI (C31:AF31)',clProc.HI));
  L.push(rowY('Term process MS (C34:AF34)',tmProc.MS));
  L.push(rowY('Term process PN (C35:AF35)',tmProc.PN));
  L.push(rowY('Term process HI (C36:AF36)',tmProc.HI));
  L.push(rowY('NIER process PN (C39:AF39)',nierProc));
  L.push('');
  L.push('# ---- ONLINE EXPECTED TARGETS (compare after recalc) ----');
  L.push(rowSal('year',SALES_YEARS));
  L.push(rowSal('RBC ratio no-note (Surplus Recalc row 52)',SALES_YEARS.map(function(yy){return rbcNo[yy]!=null?rbcNo[yy].toFixed(4):'';})));
  L.push(rowSal('RBC ratio w/ note (Surplus Recalc row 54)',SALES_YEARS.map(function(yy){return rbcNote[yy]!=null?rbcNote[yy].toFixed(4):'';})));
  L.push(rowSal('TAC (Surplus Recalc row 50)',SALES_YEARS.map(function(yy){return tac[yy]!=null?tac[yy].toFixed(3):'';})));
  L.push(rowSal('Required capital (Surplus Recalc row 48)',SALES_YEARS.map(function(yy){return req[yy]!=null?req[yy].toFixed(3):'';})));
  _dlCSV(L.join('\n'),'scalars_scen'+scen.id+'_'+(sensId==='det'?'det':'run'+(+sensId+1))+'.csv');
}

/* ---- Init ---- */
async function init(){
  // Data lives in data/, loaded at runtime (no gzip+base64 blobs embedded in code).
  var dir='../data/';
  var resp=await Promise.all([fetch(dir+'InputEV.csv'),fetch(dir+'InputTS.csv'),fetch(dir+'InputSurplus.csv'),fetch(dir+'params.json')]);
  EMBEDDED.ev=await resp[0].text();
  EMBEDDED.ts=await resp[1].text();
  EMBEDDED.surplus=await resp[2].text();
  EMBEDDED.params=await resp[3].json();
  S.params=JSON.parse(JSON.stringify(EMBEDDED.params));
  S.ev=EFENG.loadEV(EMBEDDED.ev);
  S.ts=EFENG.loadTS(EMBEDDED.ts);
  S.surplus=EFENG.loadSurplus(EMBEDDED.surplus);
  document.getElementById('srcEV').textContent='workbook (embedded, '+S.ev.rows.length+' rows)';
  document.getElementById('srcTS').textContent='workbook (embedded)';
  document.getElementById('srcSurp').textContent='workbook (embedded)';
  buildUI();
  // Pre-populate origSales from params for ALL scalar years (2026..2035),
  // mapping each array index to its scalar year. The editable UI table now exposes
  // all ten years, and S.origSales carries the full per-year anchors so sensitivity
  // scalars use the correct per-year denominator for every issue cohort.
  var base=S.params.scalars.origSales;
  var scalarYears=S.params.scalars.years||SALES_YEARS;
  PRODS.forEach(function(c){var arr=base[PNAME[c]]||[];arr.forEach(function(v,i){var y=scalarYears[i];if(y!=null&&v!=null)S.origSales[c][y]=v;});});
  refreshOrigSalesUI();
  refreshGrowthUI();
  readSurplusNote();
  computeBaseline();updateConsSummary();
  document.getElementById('hdrMeta').textContent='Wellabe · '+S.ev.rows.length+' EV rows · base 2025';
}

/* ---- Surplus note -> TAC adjustment ----
   The note's annual net cash flow accumulates into total adjusted capital. TAC is a
   stock (balance) at each year-end, so the adjustment in year Y is the CUMULATIVE net
   note cash flow through Y. Re-derives the RBC ratio from the adjusted TAC. This is the
   only place the note touches the model — it flows through TAC and nowhere else. */

/* ---- Baseline ---- */

/* ---- Scalars / Scenario ---- */

/* ---- Run ---- */
/* ---- Mobile resilience: Screen Wake Lock + IndexedDB checkpoint/resume ----
   A long run left in the foreground shouldn't be paused by the screen sleeping (Wake Lock); and if the
   tab is backgrounded long enough to be frozen/discarded (common on phones), the run shouldn't restart
   from zero. Each completed scenario is persisted to IndexedDB keyed by a signature of the run config;
   on the next Run with the same inputs, the saved scenarios seed runSweep's startResults so it resumes
   where it left off. Any input change → new signature → fresh run. */
function acquireWakeLock(){
  if(typeof navigator==='undefined' || !('wakeLock' in navigator)) return Promise.resolve();
  return navigator.wakeLock.request('screen').then(function(wl){S._wakeLock=wl;}).catch(function(){/* unsupported / denied — harmless */});
}
function releaseWakeLock(){ if(S._wakeLock){try{S._wakeLock.release();}catch(e){} S._wakeLock=null;} }

// Signature of everything that determines the run's results (must be read AFTER readInputs()).
function runSignature(){
  return JSON.stringify({seed:S.seed,nScen:S.nScen,nStoch:S.nStoch,slowMode:S.slowMode,
    bounds:S.bounds,hurdles:S.hurdles,cons:S.cons,growth:S.growth,surplusNote:S.surplusNote,
    claimsSD:S.claimsSD,claimsProcSD:S.claimsProcSD,lapseSD:S.lapseSD,lapseProcSD:S.lapseProcSD,
    procCorr:S.procCorr,nierSD:S.nierSD,nierProcSD:S.nierProcSD,origSales:S.origSales,years:S.years});
}
var _IDB_NAME='ef_checkpoints',_IDB_STORE='scenarios',_dbP=null;
function _db(){
  if(_dbP) return _dbP;
  _dbP=new Promise(function(res,rej){
    if(typeof indexedDB==='undefined'){rej(new Error('no IndexedDB'));return;}
    var req=indexedDB.open(_IDB_NAME,1);
    req.onupgradeneeded=function(){var db=req.result; if(!db.objectStoreNames.contains(_IDB_STORE)){var os=db.createObjectStore(_IDB_STORE,{keyPath:'key'}); os.createIndex('sig','sig',{unique:false});}};
    req.onsuccess=function(){res(req.result);};
    req.onerror=function(){rej(req.error);};
  });
  _dbP.catch(function(){_dbP=null;});   // allow retry if the open failed
  return _dbP;
}
function idbPutResult(sig,i,result){   // fire-and-forget per scenario
  return _db().then(function(db){return new Promise(function(res,rej){
    var tx=db.transaction(_IDB_STORE,'readwrite');
    tx.objectStore(_IDB_STORE).put({key:sig+'|'+i,sig:sig,i:i,result:result});
    tx.oncomplete=function(){res();}; tx.onerror=function(){rej(tx.error);};
  });}).catch(function(){/* persistence is best-effort */});
}
function idbLoad(sig){   // contiguous prefix of saved scenarios (0..k-1)
  return _db().then(function(db){return new Promise(function(res,rej){
    var tx=db.transaction(_IDB_STORE,'readonly');
    var req=tx.objectStore(_IDB_STORE).index('sig').getAll(IDBKeyRange.only(sig));
    req.onsuccess=function(){var byI={}; (req.result||[]).forEach(function(r){byI[r.i]=r.result;}); var arr=[]; for(var i=0;byI[i]!==undefined;i++)arr.push(byI[i]); res(arr);};
    req.onerror=function(){rej(req.error);};
  });}).catch(function(){return [];});
}
function idbClear(sig){   // drop this run's checkpoint (called on completion)
  return _db().then(function(db){return new Promise(function(res){
    var tx=db.transaction(_IDB_STORE,'readwrite');
    var req=tx.objectStore(_IDB_STORE).index('sig').openCursor(IDBKeyRange.only(sig));
    req.onsuccess=function(){var c=req.result; if(c){c.delete();c.continue();}};
    tx.oncomplete=function(){res();}; tx.onerror=function(){res();};
  });}).catch(function(){});
}
function idbClearExcept(sig){   // evict stale checkpoints from prior configs so storage doesn't grow
  return _db().then(function(db){return new Promise(function(res){
    var tx=db.transaction(_IDB_STORE,'readwrite');
    var req=tx.objectStore(_IDB_STORE).openCursor();
    req.onsuccess=function(){var c=req.result; if(c){ if(c.value.sig!==sig)c.delete(); c.continue();}};
    tx.oncomplete=function(){res();}; tx.onerror=function(){res();};
  });}).catch(function(){});
}

async function runFrontier(){
  readInputs();computeBaseline();
  var n=S.nScen;
  S.lastRunSeed=S.seed;                         // seed that produced these results (export/replay + custom-scenario CRN)
  var fill=document.getElementById('progFill'),pw=document.getElementById('progWrap'),st=document.getElementById('runStatus');
  document.getElementById('runBtn').disabled=true;pw.style.display='block';S.results=[];
  var sig=runSignature(),resume=[];
  await idbClearExcept(sig);                     // keep only the current config's checkpoint
  resume=await idbLoad(sig);                     // resume any saved scenarios for these exact inputs
  if(resume.length>n)resume=resume.slice(0,n);
  var resumedFrom=resume.length;
  S._running=true; await acquireWakeLock();       // keep the screen awake for the duration of a foreground run
  // Heavy sweep runs in a Web Worker so it keeps computing in a background/unfocused tab and never
  // freezes the UI. Falls back to the main thread (MessageChannel-yield loop) if workers are unavailable.
  var ran='Web Worker',failReason='';
  try{
    if(typeof Worker!=='undefined'){ S.results=await runSweepInWorker(fill,st,sig,resume,resumedFrom); }
    else { ran='main thread';failReason='this browser has no Web Worker support';S.results=await F.runSweep(mainThreadCallbacks(fill,st,'main thread',sig,resume,n)); }
  }catch(err){
    ran='main thread';failReason=(err&&err.message)||String(err);
    console.error('Web Worker sweep failed — running on the main thread instead (it will stall when the tab is backgrounded). Reason:',err);
    var resume2=await idbLoad(sig);               // pick up whatever the worker persisted before failing
    S.results=await F.runSweep(mainThreadCallbacks(fill,st,'main thread',sig,resume2,n));
  }finally{ S._running=false; releaseWakeLock(); }
  markFrontier(S.results);populateSelectors();
  await idbClear(sig);                            // run complete — drop the checkpoint
  pw.style.display='none';document.getElementById('runBtn').disabled=false;
  var nfr=S.results.filter(function(r){return r.isFrontier;}).length,nfe=S.results.filter(function(r){return r.feasible;}).length;
  st.textContent=nfr+' frontier / '+nfe+' feasible of '+n+'  ·  seed '+S.lastRunSeed+'  ·  '+ran+(resumedFrom>0?'  ·  resumed '+resumedFrom+'/'+n:'')+(failReason?' (worker unavailable: '+failReason+')':'');
  showTab('frontier');
}
function mainThreadCallbacks(fill,st,label,sig,resume,n){
  var resumedFrom=(resume&&resume.length)||0;
  return {
    startResults:(resume&&resume.length)?resume:null,
    onPartial:function(result,i){idbPutResult(sig,i,result);},   // persist each scenario
    onTick:function(i,k,n,ns){fill.style.width=Math.round((i*ns+k+1)/(n*ns)*100)+'%';},
    onYield:sleep,
    onProgress:function(done,n){fill.style.width=Math.round(done/n*100)+'%';st.textContent=done+'/'+n+' scenarios… · '+(label||'main thread')+(resumedFrom>0?' (resumed '+resumedFrom+'/'+n+')':'');}
  };
}
function runSweepInWorker(fill,st,sig,resume,resumedFrom){
  return new Promise(function(resolve,reject){
    var w=new Worker('worker.js?v=217');   // ?v matches index.html so the worker + engine load fresh (not stale-cached)
    var cfg={params:S.params,bounds:S.bounds,hurdles:S.hurdles,cons:S.cons,growth:S.growth,surplusNote:S.surplusNote,
      seed:S.seed,nScen:S.nScen,nStoch:S.nStoch,slowMode:S.slowMode,
      claimsSD:S.claimsSD,claimsProcSD:S.claimsProcSD,lapseSD:S.lapseSD,lapseProcSD:S.lapseProcSD,
      procCorr:S.procCorr,nierSD:S.nierSD,nierProcSD:S.nierProcSD,origSales:S.origSales,years:S.years};
    w.onmessage=function(e){var d=e.data;
      if(d.type==='partial'){idbPutResult(sig,d.i,d.result);}   // persist each completed scenario
      else if(d.type==='progress'){fill.style.width=Math.round(d.done/d.n*100)+'%';st.textContent=d.done+'/'+d.n+' scenarios… · Web Worker'+(resumedFrom>0?' (resumed '+resumedFrom+'/'+d.n+')':'');}
      else if(d.type==='done'){w.terminate();resolve(d.results);}
      else if(d.type==='error'){w.terminate();reject(new Error(d.message));}
    };
    w.onerror=function(ev){w.terminate();reject((ev&&ev.error)||new Error('worker load/runtime error'));};
    w.postMessage({type:'run',evText:EMBEDDED.ev,tsText:EMBEDDED.ts,surplusText:EMBEDDED.surplus,cfg:cfg,startResults:(resume&&resume.length)?resume:null});
  });
}

/* ---- Custom scenario: test a user-entered sales mix ---- */
async function testCustomScenario(){
  var resultEl=document.getElementById('cs_result');
  if(!S.baseline){computeBaseline();}
  // Read the per-year sales table (3 products × SALES_YEARS); these are explicit annual
  // sales — no growth schedule applied on top (mkScalars uses arrays verbatim).
  function cell(c,y){var el=document.getElementById('csc_'+c+'_'+y);return el?(+el.value||0):0;}
  var sales={};PRODS.forEach(function(c){sales[c]=SALES_YEARS.map(function(y){return cell(c,y);});});
  S.csSales={};PRODS.forEach(function(c){S.csSales[c]={};SALES_YEARS.forEach(function(y,i){S.csSales[c][y]=sales[c][i];});});  // remember for re-render
  if(!PRODS.some(function(c){return sales[c].some(function(v){return v>0;});})){resultEl.innerHTML='<p class="hint" style="color:var(--red)">Enter at least one positive sales value.</p>';return;}
  var sales26={MS:sales.MS[0],PN:sales.PN[0],HI:sales.HI[0]};   // 2026 anchors for display compatibility
  readInputs();   // make sure constraints/note reflect current config
  var ns=Math.max(1,S.nStoch||20);
  F.setSeed(S.lastRunSeed!=null?S.lastRunSeed:S.seed);var BANK=buildShockBank(ns);   // same bank as the last frontier run (CRN consistency)
  var mc={MS:1,PN:1,HI:1},ml={MS:1,PN:1,HI:1};
  var det=buildScen(sales,mc,ml);
  var sIRRs=[],sNPVs=[],sDD=[],sMinRBC=[],stochScalarsList=[];
  for(var k=0;k<ns;k++){
    var _s=shockFromBank(BANK[k]);var cm=_s.cm,lm=_s.lm,nm=_s.nm;
    stochScalarsList.push({claims:Object.assign({},cm),lapse:Object.assign({},lm),nier:Object.assign({},nm),nierProc:Object.assign({},_s.nmProc)});
    if(S.slowMode){var sm=buildScen(sales,cm,lm,{combined:_s.nm,proc:_s.nmProc});sIRRs.push(sm.irr26);sNPVs.push(sm.npv26);sDD.push(ddFromCum(sm.cumDE26));sMinRBC.push(sm.minRBC);}
    else{var sm=stochMetrics(sales,cm,lm,nm);sIRRs.push(sm.irr);sNPVs.push(sm.npv);sDD.push(sm.dd);}
  }
  var dr=downsideRisk(sNPVs,sDD,det.npv26),risk=dr.risk;
  var fails=evalCons(det,S.slowMode?{irrs:sIRRs,minRBCs:sMinRBC}:{irrs:sIRRs});
  // Remove any prior custom scenario, then add this one with a distinctive id
  S.results=S.results.filter(function(r){return !r.isCustom;});
  var cid='C'+(S.results.length+1);
  var rec={id:cid,sales:sales26,salesTable:sales,portIRR:det.irr26,portNPV:det.npv26,wtdIRR:det.wtdIRR,risk:risk,portIRRAll:det.portIRR,portNPVAll:det.portNPV,irr26:det.irr26,npv26:det.npv26,de26:det.de26,cumDE26:det.cumDE26,minRBC:det.minRBC,de:det.de,cumDE:det.cumDE,atiBopCS:det.atiBopCS,maxDecline:det.maxDecline,tacChg:det.tacChg,scalars:det.scalars,stochIRRs:sIRRs,stochNPVs:sNPVs,stochMinRBC:S.slowMode?sMinRBC:null,stochScalars:stochScalarsList,failures:fails,feasible:fails.length===0,isFrontier:false,isCustom:true};
  rec.riskSD=dr.sd;rec.cte90=dr.cte90;rec.semidev=dr.semidev;rec.ddMed=dr.ddMed;rec.ddWorst=dr.ddWorst;rec.stochDD=sDD;
  S.results.push(rec);
  markFrontier(S.results);populateSelectors();
  // Select the custom scenario everywhere
  setSelection(cid,'det');
  // Refresh the frontier views
  renderStats();drawChart();renderScenTable();
  // Inline result summary
  var p10=sIRRs.length?pctile(sIRRs,10):null;
  var st=rec.feasible?'<span style="color:#1c7a3d;font-weight:700">✓ FEASIBLE</span>':'<span style="color:#b3261e;font-weight:700">✗ INFEASIBLE — '+fails.length+' constraint'+(fails.length>1?'s':'')+' failed</span>';
  var fr=rec.isFrontier?' &nbsp;·&nbsp; <span style="color:var(--teal);font-weight:700">⬤ On the efficient frontier</span>':'';
  var h='<div style="padding:12px 16px;border-radius:8px;margin-bottom:10px;'+(rec.feasible?'background:#e6f5ea':'background:#fdeaea')+'">'+st+fr+'</div>';
  h+='<div style="display:flex;gap:18px;flex-wrap:wrap;font-size:13px;margin-bottom:8px">';
  h+='<div><span style="color:var(--muted)">2026 PVDE</span><br><strong style="font-family:var(--mono);font-size:15px">$'+fmt(rec.npv26,1)+'M</strong></div>';
  h+='<div><span style="color:var(--muted)">2026 IRR</span><br><strong style="font-family:var(--mono);font-size:15px">'+pct(rec.irr26,2)+'</strong></div>';
  h+='<div><span style="color:var(--muted)">Target IRR</span><br><strong style="font-family:var(--mono);font-size:15px">'+pct(rec.wtdIRR,2)+'</strong></div>';
  h+='<div><span style="color:var(--muted)">Downside vs plan</span><br><strong style="font-family:var(--mono);font-size:15px">$'+fmt(rec.risk,1)+'M</strong></div>'+'<div><span style="color:var(--muted)">Worst drawdown</span><br><strong style="font-family:var(--mono);font-size:15px">$'+fmt(rec.ddWorst,1)+'M</strong></div>';
  h+='<div><span style="color:var(--muted)">P10 IRR</span><br><strong style="font-family:var(--mono);font-size:15px">'+pct(p10,2)+'</strong></div>';
  h+='<div><span style="color:var(--muted)">Min RBC</span><br><strong style="font-family:var(--mono);font-size:15px">'+rx(rec.minRBC)+'</strong></div>';
  h+='</div>';
  if(fails.length){h+='<div style="font-size:12px;color:var(--red)"><strong>Failed:</strong> '+fails.map(function(f){return f.label;}).join(' &nbsp;·&nbsp; ')+'</div>';}
  h+='<p class="hint" style="margin-top:8px">Full constraint evidence is on the Constraint Evidence tab (this scenario is now selected there too).</p>';
  resultEl.innerHTML=h;
}
function clearCustomScenario(){
  S.results=S.results.filter(function(r){return !r.isCustom;});
  markFrontier(S.results);populateSelectors();
  if(String(S.sel.scen).charAt(0)==='C')setSelection('base','det');
  renderStats();drawChart();renderScenTable();
  var el=document.getElementById('cs_result');if(el)el.innerHTML='';
}

/* ---- Surplus Note ---- */
function readSurplusNote(){
  function g(id){var el=document.getElementById(id);return el?(+el.value||0):0;}
  var on=(document.getElementById('sn_on')||{}).checked||false;
  var startEl=document.getElementById('sn_start');
  S.surplusNote={
    on:on,
    amount:g('sn_amount'),
    tenor:Math.round(g('sn_tenor')),
    rate:g('sn_rate')/100,
    fees:g('sn_fees')/100,
    nierSN:g('sn_nier')/100,
    startDate:startEl?startEl.value:'2026-06-30'
  };
  refreshSurplusNoteUI();
}
function refreshSurplusNoteUI(){
  var sn=S.surplusNote;
  var fields=document.getElementById('sn_fields');
  if(fields){fields.style.opacity=sn.on?'1':'0.5';fields.style.pointerEvents=sn.on?'auto':'none';}
  // End date
  var start=EFENG.parseNoteDate(sn.startDate);
  var endEl=document.getElementById('sn_end');
  if(endEl&&start){var end=EFENG.noteEndDate(start,sn.tenor);endEl.value=end?(end.year+'-'+String(end.month).padStart(2,'0')+'-'+sn.startDate.slice(8)):'';}
  // Cash flow preview
  var prev=document.getElementById('sn_preview');
  if(prev)prev.style.display=sn.on?'block':'none';
  if(sn.on){
    var ann=EFENG.surplusNoteAnnual(sn);
    var ys=[];for(var y=2026;y<=2055;y++){if(Math.abs(ann[y]||0)>0.001)ys.push(y);}
    if(ys.length){
      var h='<thead><tr><th>Year</th>'+ys.map(function(y){return'<th>'+y+'</th>';}).join('')+'</tr></thead><tbody>';
      h+='<tr><td>Net to TAC $M</td>'+ys.map(function(y){var v=ann[y]||0;return'<td style="font-family:var(--mono);color:'+(v<0?'var(--red)':'var(--teal)')+'">'+fmt(v,1)+'</td>';}).join('')+'</tr>';
      var cum=0;
      h+='<tr><td style="color:var(--muted)">Cumulative</td>'+ys.map(function(y){cum+=ann[y]||0;return'<td style="font-family:var(--mono);color:var(--muted)">'+fmt(cum,1)+'</td>';}).join('')+'</tr>';
      var tbl=document.getElementById('sn_cfTbl');if(tbl)tbl.innerHTML=h+'</tbody>';
    }
  }
}

/* ---- readInputs ---- */
function readInputs(){
  function g(id){return+(document.getElementById(id)||{value:0}).value||0;}
  S.bounds={MS:[g('b_MS_lo'),g('b_MS_hi')],PN:[g('b_PN_lo'),g('b_PN_hi')],HI:[g('b_HI_lo'),g('b_HI_hi')]};
  S.hurdles={MS:g('h_MS')/100,PN:g('h_PN')/100,HI:g('h_HI')/100};
  S.nScen=Math.max(8,Math.round(g('nScen')));S.nStoch=Math.max(50,Math.round(g('nStoch')));   // floor 50: keeps the C4 IRR-tail estimate stable
  var _seed=Math.round(g('seedInput'));S.seed=(isFinite(_seed)&&_seed!==0)?_seed:F.STOCH_SEED;   // RNG seed: same seed -> identical frontier
  S.cons={rbcFloor:g('c_rbc'),tacChgFloor:g('c_tacchg')/100,irr3on:(document.getElementById('c_irr3on')||{}).checked,irrA:g('c_irra')/100,irrB:g('c_irrb')/100,deYr:Math.round(g('c_deyr')),cumDeYr:Math.round(g('c_cumdeyr')),cumDEFloor:g('c_cumfloor'),de1Floor:g('c_de1floor'),rbcTailX:g('c_rbctailx')/100,rbcTailY:g('c_rbctaily')/100};
  S.slowMode=(document.getElementById('runModeSlow')||{}).checked||false;   // Slow mode adds the per-draw trough-RBC tail constraint
  readSurplusNote();
  PRODS.forEach(function(c){S.claimsSD[c]=+(document.getElementById('cs_'+c)||{value:4}).value/100||0;S.claimsProcSD[c]=+(document.getElementById('cs_proc_'+c)||{value:3}).value/100||0;S.lapseSD[c]=+(document.getElementById('ls_'+c)||{value:6.5}).value/100||0;S.lapseProcSD[c]=+(document.getElementById('ls_proc_'+c)||{value:3}).value/100||0;S.procCorr[c]=Math.max(0,Math.min(0.95,+(document.getElementById('rho_'+c)||{value:0}).value||0));});
  // Preneed-only NIER (investment-yield) shock σ, entered in basis points -> rate units. PN claims σ above IS the mortality σ (drives the coupled claims+decrement shock); PN lapse σ / ρ are unused.
  S.nierSD.PN=Math.max(0,+(document.getElementById('ni_PN')||{value:35}).value)/10000||0;S.nierProcSD.PN=Math.max(0,+(document.getElementById('ni_proc_PN')||{value:15}).value)/10000||0;
  var P=S.params.assum;P.tax=g('a_tax')/100;P.disc=g('a_disc')/100;P.inflation=g('a_infl')/100;P.inflStart=Math.round(g('a_inflyr'));
  document.querySelectorAll('.assum-inp').forEach(function(inp){var p=inp.dataset.prod,k=inp.dataset.kind,i=+inp.dataset.idx,v=+inp.value||0;if(P.perProduct&&P.perProduct[p]&&P.perProduct[p][k])P.perProduct[p][k][i]=((k==='NIER'||k==='NIER_EV')?v/100:v);});
  // origSales from per-year table
  PRODS.forEach(function(c){SALES_YEARS.forEach(function(y){var el=document.getElementById('os_'+c+'_'+y);if(el)S.origSales[c][y]=+el.value||S.origSales[c][y];});});
  // forward sales growth (decimals), 2027-2035; 2026 anchor is never grown
  PRODS.forEach(function(c){if(!S.growth[c])S.growth[c]={};SALES_YEARS.forEach(function(y){if(y<2027)return;var el=document.getElementById('gr_'+c+'_'+y);if(el){var v=+el.value;if(isFinite(v))S.growth[c][y]=v/100;}});});
  updateConsSummary();
}
function updateConsSummary(){
  var c=S.cons,on=(document.getElementById('c_irr3on')||{}).checked;
  document.getElementById('consSummary').innerHTML='C1 RBC≥'+rx(c.rbcFloor||3)+'&nbsp; C2 ΔTAC/BOP≥'+pct(c.tacChgFloor||-.15)+'&nbsp; C3 2026 IRR vs target: '+(on?'on':'off')+'&nbsp; C4 P(2026 IRR<'+pct(c.irrA||.08)+')≤'+pct(c.irrB||.10)+'&nbsp; C5 2026 DE>0 yr '+(c.deYr||5)+'&nbsp; C6 2026 CumDE>0 yr '+(c.cumDeYr||12)+'&nbsp; C7 CumDE floor $'+fmt(c.cumDEFloor||0,0)+'M'+'&nbsp; C8 Yr-1 DE≥$'+fmt(c.de1Floor!=null?c.de1Floor:-150,0)+'M'+'&nbsp; C9 RBC tail P(min RBC<'+rx(c.rbcTailX!=null?c.rbcTailX:3.5)+')≤'+pct(c.rbcTailY!=null?c.rbcTailY:.10)+(S.slowMode?'':' (Slow)');
}

/* ---- buildUI ---- */
function buildUI(){
  var P=S.params.assum,ys=P.years||[2025,2026,2027,2028,2029,2030];
  function mkAt(tid,kind,isNIER,onlyProd){
    var prods=onlyProd?[onlyProd]:['Medicare Supplement','Preneed','Hospital Indemnity'];
    var h='<thead><tr><th>Product</th>'+ys.map(function(y){return'<th>'+y+'</th>';}).join('')+'</tr></thead><tbody>';
    prods.forEach(function(p){
      var sh=p==='Medicare Supplement'?'Med Supp':p==='Hospital Indemnity'?'Hosp Ind':p;
      h+='<tr><td>'+sh+'</td>';
      ys.forEach(function(y,i){var arr=(P.perProduct[p]||{})[kind]||[],v=arr[i]||0,d=isNIER?+(v*100).toFixed(3):+v.toFixed(2);h+='<td><input class="assum-inp" type="number" data-prod="'+p+'" data-kind="'+kind+'" data-idx="'+i+'" value="'+d+'" step="'+(isNIER?'.001':'1')+'" onchange="readInputs();computeBaseline()"></td>';});
      h+='</tr>';
    });
    document.getElementById(tid).innerHTML=h+'</tbody>';
    // Paste handler
    document.getElementById(tid).addEventListener('paste',function(e){handleAssumPaste(e,tid,kind,isNIER);});
  }
  mkAt('nierTbl','NIER',true);mkAt('nierEvTbl','NIER_EV',true,'Preneed');mkAt('acqTbl','Acquisition Expense',false);mkAt('maintTbl','Maintenance Expense',false);
  // Stochastic table — per-product σ defaults from the Risk Calibration section (research-backed)
  // systematic (persistent) + process (annual) σ defaults — see Risk Calibration sections
  var CSDEF={MS:4,PN:3.5,HI:5.5},CPDEF={MS:3,PN:2,HI:4},LSDEF={MS:6.5,PN:4.5,HI:7},LPDEF={MS:3,PN:2,HI:4};
  var SI='style="width:48px;font-family:var(--mono);font-size:12px;padding:3px 4px;border:1px solid var(--line);border-radius:4px;text-align:right"';
  var stoch='';PRODS.forEach(function(c){
    if(c==='PN'){
      // Preneed: claims σ IS the mortality σ — one coupled shock drives claims, decrement
      // AND reserve release together. Term columns are coupled (not independent inputs).
      stoch+='<tr><td>Preneed<br><span style="font-size:9px;color:var(--muted)">(mortality)</span></td>';
      stoch+='<td><input type="number" id="cs_PN" value="'+CSDEF.PN+'" step="0.5" '+SI+'></td>';
      stoch+='<td><input type="number" id="cs_proc_PN" value="'+CPDEF.PN+'" step="0.5" '+SI+'></td>';
      stoch+='<td colspan="2" style="font-size:9px;color:var(--muted);text-align:center;line-height:1.35">claims, decrement &amp;<br>reserve release coupled<br>to this mortality shock</td></tr>';
    }else{stoch+='<tr><td>'+({MS:'Med Supp',HI:'Hosp Ind'})[c]+'</td>';
      stoch+='<td><input type="number" id="cs_'+c+'" value="'+CSDEF[c]+'" step="0.5" '+SI+'></td>';
      stoch+='<td><input type="number" id="cs_proc_'+c+'" value="'+CPDEF[c]+'" step="0.5" '+SI+'></td>';
      stoch+='<td><input type="number" id="ls_'+c+'" value="'+LSDEF[c]+'" step="0.5" '+SI+'></td>';
      stoch+='<td><input type="number" id="ls_proc_'+c+'" value="'+LPDEF[c]+'" step="0.5" '+SI+'></td></tr>';
    }
  });
  document.getElementById('stochTbl').innerHTML=stoch;
  document.querySelectorAll('.assum-inp').forEach(function(el){el.addEventListener('change',function(){computeBaseline();});});
}
function refreshOrigSalesUI(){
  var h='<thead><tr><th>Product</th>'+SALES_YEARS.map(function(y){return'<th>'+y+'</th>';}).join('')+'</tr></thead><tbody>';
  var shortName={MS:'Med Supp',PN:'Preneed',HI:'Hosp Ind'};
  PRODS.forEach(function(c){h+='<tr><td>'+shortName[c]+'</td>'+SALES_YEARS.map(function(y){return'<td><input type="number" id="os_'+c+'_'+y+'" value="'+fmt(S.origSales[c][y]||0,1)+'" step="1" style="width:68px;font-size:11px;padding:2px 4px;font-family:var(--mono);border:1px solid var(--line);border-radius:4px;text-align:right"></td>';}).join('')+'</tr>';});
  document.getElementById('origSalesTbl').innerHTML=h+'</tbody>';
  var _pEl=document.getElementById('origSalesTbl');
  if(_pEl)_pEl.addEventListener('paste',function(e){e.preventDefault();var text=e.clipboardData.getData('text');var rows=text.trim().split(/\r?\n/);var allInps=_pEl.querySelectorAll('input[type=number]');var startEl=e.target;var startIdx=Array.from(allInps).indexOf(startEl);if(startIdx<0)startIdx=0;var nCols=SALES_YEARS.length,ri=Math.floor(startIdx/nCols),ci=startIdx%nCols;rows.forEach(function(row,rowOff){row.split(/\t/).forEach(function(cell,colOff){var v=parseFloat(cell.replace(/,/g,''));if(isNaN(v))return;var r=ri+rowOff,c=ci+colOff;if(r<PRODS.length&&c<nCols){var inp=allInps[r*nCols+c];if(inp){inp.value=v;inp.dispatchEvent(new Event('change'));}}});});});
}
// Custom-scenario per-year sales grid (3 products × SALES_YEARS). Supports Excel paste
// (click a cell, Ctrl+V a 3×10 block). Values are read verbatim by testCustomScenario.
function refreshCsSalesUI(){
  var tbl=document.getElementById('csSalesTbl');if(!tbl)return;
  var def={MS:300,PN:175,HI:20};
  var h='<thead><tr><th style="text-align:left;padding:3px 8px 3px 0">Product ($M)</th>'+SALES_YEARS.map(function(y){return'<th style="padding:3px 6px">'+y+'</th>';}).join('')+'</tr></thead><tbody>';
  var shortName={MS:'Med Supp',PN:'Preneed',HI:'Hosp Ind'};
  PRODS.forEach(function(c){h+='<tr><td style="padding:2px 8px 2px 0;white-space:nowrap">'+shortName[c]+'</td>'+SALES_YEARS.map(function(y){var v=(S.csSales&&S.csSales[c]&&S.csSales[c][y]!=null)?S.csSales[c][y]:def[c];return'<td><input type="number" id="csc_'+c+'_'+y+'" value="'+v+'" step="1" style="width:62px;font-size:11px;padding:2px 4px;font-family:var(--mono);border:1px solid var(--line);border-radius:4px;text-align:right"></td>';}).join('')+'</tr>';});
  tbl.innerHTML=h+'</tbody>';
  if(!tbl._pasteBound){tbl._pasteBound=true;tbl.addEventListener('paste',function(e){e.preventDefault();var text=e.clipboardData.getData('text');var rows=text.trim().split(/\r?\n/);var allInps=tbl.querySelectorAll('input[type=number]');var startIdx=Array.from(allInps).indexOf(e.target);if(startIdx<0)startIdx=0;var nCols=SALES_YEARS.length,ri=Math.floor(startIdx/nCols),ci=startIdx%nCols;rows.forEach(function(row,rowOff){row.split(/\t/).forEach(function(cell,colOff){var v=parseFloat(cell.replace(/,/g,''));if(isNaN(v))return;var r=ri+rowOff,c=ci+colOff;if(r<PRODS.length&&c<nCols){var inp=allInps[r*nCols+c];if(inp)inp.value=v;}});});});}
}
function handleAssumPaste(e,tid,kind,isNIER){
  e.preventDefault();
  var text=e.clipboardData.getData('text');
  var rows=text.trim().split(/\r?\n/);
  var firstInput=e.target.closest('td')&&e.target.closest('td').querySelector('input');
  if(!firstInput)return;
  var allInputs=document.querySelectorAll('#'+tid+' input.assum-inp');
  var inputs=[]; allInputs.forEach(function(inp){inputs.push(inp);});
  var startIdx=inputs.indexOf(firstInput);
  var cellCount=6; // 6 year columns
  var ri=Math.floor(startIdx/cellCount),ci=startIdx%cellCount;
  rows.forEach(function(row,rowOff){
    var cells=row.split(/\t/);
    cells.forEach(function(cell,colOff){
      var v=parseFloat(cell.replace(/,/g,''));
      if(isNaN(v))return;
      var r=ri+rowOff,c=ci+colOff;
      if(r<3&&c<cellCount){
        var inp=inputs[r*cellCount+c];
        if(inp){inp.value=isNIER?v:v;inp.dispatchEvent(new Event('change'));}
      }
    });
  });
  computeBaseline();
}

/* ---- CumDE baseline table ---- */
function renderCumDEBaseline(){
  var el=document.getElementById('cumDEBslTbl');if(!el||!S.baseline)return;
  var ys=[2026,2027,2028,2029,2030,2031,2032,2033,2034,2035,2036,2037];
  // 2026-issue-only baseline cumulative DE (truly new business; pre-2026 in-force excluded)
  var cum=0,bDE={};
  ys.forEach(function(y){cum+=PRODS.reduce(function(s,c){return s+((S.baseline.vnb26[c].annual.DE[y])||0);},0);bDE[y]=cum;});
  var fl=S.cons.cumDEFloor||0;
  // Headline figure: 2026-issue cumulative PVDE across all 3 products
  var npv26=S.baseline.npv26;
  var h='<table style="font-size:11px;min-width:600px"><thead><tr><th>Year</th>'+ys.map(function(y){return'<th>'+y+'</th>';}).join('')+'</tr></thead><tbody>';
  h+='<tr><td>2026-issue cumDE $M (undiscounted)</td>'+ys.map(function(y){var v=bDE[y],hi=v<fl;return'<td style="'+(hi?'color:var(--red);font-weight:700':'')+'">'+fmt(v,1)+'</td>';}).join('')+'</tr>';
  h+='<tr><td style="color:var(--muted)">Floor</td>'+ys.map(function(){return'<td style="color:var(--muted)">'+fmt(fl,1)+'</td>';}).join('')+'</tr>';
  el.innerHTML='<div class="hscroll">'+h+'</tbody></table></div>';
}

/* ---- Frontier (V3 style with stochastic cloud) ---- */
function getAxisVal(id){var el=document.getElementById(id);return el&&el.value!==''?+el.value:undefined;}
function resetAxisLimits(){['ax-xmin','ax-xmax','ax-ymin','ax-ymax'].forEach(function(id){var el=document.getElementById(id);if(el)el.value='';});updateChart();}
function getDatasets(){
  var res=S.results;
  var shCloud=document.getElementById('ck-cloud')&&document.getElementById('ck-cloud').checked;
  var shDet=document.getElementById('ck-det')&&document.getElementById('ck-det').checked;
  var shFront=document.getElementById('ck-frontier')&&document.getElementById('ck-frontier').checked;
  var feasOnly=document.getElementById('ck-feasonly')&&document.getElementById('ck-feasonly').checked;
  var cloud=[],det=[],front=[],custom=[];
  res.forEach(function(r){
    if(!isFinite(r.portNPV)||!isFinite(r.risk))return;
    if(feasOnly&&!r.feasible&&!r.isCustom)return;  // hide infeasible scenarios entirely when toggled (always keep custom)
    if(r.isCustom){custom.push({x:r.risk,y:r.portNPV,id:r.id,sales:r.sales,irr:r.portIRR,wtdIRR:r.wtdIRR,risk:r.risk,dd:r.ddWorst,feasible:r.feasible,frontier:r.isFrontier});return;}
    if(shCloud&&r.stochNPVs)r.stochNPVs.forEach(function(s){if(isFinite(s))cloud.push({x:r.risk,y:s});});
    if(shDet)det.push({x:r.risk,y:r.portNPV,id:r.id,sales:r.sales,irr:r.portIRR,wtdIRR:r.wtdIRR,risk:r.risk,dd:r.ddWorst,feasible:r.feasible,frontier:r.isFrontier});
    if(shFront&&r.isFrontier)front.push({x:r.risk,y:r.portNPV,id:r.id});
  });
  front.sort(function(a,b){return a.x-b.x;});
  return [
    {label:'Stochastic cloud',data:cloud,type:'scatter',backgroundColor:'rgba(59,130,246,0.06)',pointRadius:2,pointHoverRadius:0,order:3},
    {label:'All scenarios',data:det,type:'scatter',backgroundColor:function(ctx){var d=ctx.raw;if(!d)return'rgba(154,180,192,.7)';return d.frontier?'rgba(10,112,128,.9)':d.feasible?'rgba(154,180,192,.7)':'rgba(181,51,35,.5)';},pointRadius:function(ctx){var d=ctx.raw;return d&&d.frontier?6:4;},pointHoverRadius:8,order:2},
    {label:'Efficient frontier',data:front,type:'scatter',backgroundColor:'#0a7080',borderColor:'#0a7080',pointRadius:7,pointHoverRadius:9,showLine:true,borderWidth:2,tension:0.1,order:1},
    {label:'Custom scenario',data:custom,type:'scatter',backgroundColor:'#C4881A',borderColor:'#8a5e10',pointStyle:'star',pointRadius:12,pointHoverRadius:15,borderWidth:2,order:0}
  ];
}
function drawChart(){
  var cv=document.getElementById('frontier-chart');if(!cv)return;
  if(S.chart){S.chart.destroy();S.chart=null;}
  S.chart=new Chart(cv,{
    type:'scatter',data:{datasets:getDatasets()},
    options:{animation:false,responsive:true,maintainAspectRatio:false,
      plugins:{legend:{position:'bottom',labels:{font:{size:11},boxWidth:10,padding:14}},
        tooltip:{callbacks:{label:function(ctx){var d=ctx.raw;if(!d.id)return' PVDE: '+fmt(d.y,1);return[' Scenario #'+d.id,' PVDE: $'+fmt(d.y,1)+'M | Downside vs plan: $'+fmt(d.x,1)+'M',' Worst drawdown: $'+fmt(d.dd,1)+'M',' IRR: '+pct(d.irr,2)+' | Target: '+pct(d.wtdIRR,2),' MS: $'+fmt(d.sales&&d.sales.MS,0)+'M PN: $'+fmt(d.sales&&d.sales.PN,0)+'M HI: $'+fmt(d.sales&&d.sales.HI,1)+'M'];}}}
      },
      scales:{
        x:{min:getAxisVal('ax-xmin'),max:getAxisVal('ax-xmax'),title:{display:true,text:'Downside risk vs plan ($M) — value at risk in worst 10% (right = more risk)',font:{size:11},color:'#6b7a91'},ticks:{font:{size:10},callback:function(v){return v.toFixed(1);}}},
        y:{min:getAxisVal('ax-ymin'),max:getAxisVal('ax-ymax'),title:{display:true,text:'Deterministic PVDE ($M)',font:{size:11},color:'#6b7a91'},ticks:{font:{size:10},callback:function(v){return v.toFixed(0);}}}}
    }
  });
}
function updateChart(){if(S.chart){S.chart.data.datasets=getDatasets();var xu=getAxisVal('ax-xmax');S.chart.options.scales.x.min=getAxisVal('ax-xmin');S.chart.options.scales.x.max=xu;S.chart.options.scales.y.min=getAxisVal('ax-ymin');S.chart.options.scales.y.max=getAxisVal('ax-ymax');S.chart.update('none');}else drawChart();}
function renderStats(){
  var res=S.results,bl=S.baseline;
  var el=document.getElementById('statsStrip');
  if(!bl){el.innerHTML='<div class="stat-box"><span class="stat-lbl">status</span><span class="stat-val" style="font-size:14px">run the frontier first</span></div>';return;}
  var fr=res.filter(function(r){return r.isFrontier&&isFinite(r.portNPV);});
  var feas=res.filter(function(r){return r.feasible;});
  var totSims=res.reduce(function(s,r){return s+(r.stochNPVs?r.stochNPVs.length:0);},0);
  var totalVNB=PRODS.reduce(function(s,c){return s+(bl.vnbs[c].r.npvDE||0);},0);
  var tIRRs=res.filter(function(r){return isFinite(r.wtdIRR);}).map(function(r){return r.wtdIRR;});
  var minTIRR=tIRRs.length?Math.min.apply(null,tIRRs):NaN;
  var maxTIRR=tIRRs.length?Math.max.apply(null,tIRRs):NaN;
  var frRisks=fr.map(function(r){return r.risk;});
  var frNPVs=fr.map(function(r){return r.portNPV;});
  var html='';
  if(res.length){
    html+=sb('Scenarios run',res.length+(totSims?' | '+totSims+' sims':''));
    html+=sb('Feasible',feas.length+' / '+res.length+' ('+(res.length?Math.round(feas.length/res.length*100)+'%':'—')+')');
    html+=sb('Frontier points',fr.length);
    html+=sb('Target IRR range',isFinite(minTIRR)?pct(minTIRR,1)+' – '+pct(maxTIRR,1):'—','2026 wtd hurdles');
    html+=sb('Frontier PVDE',frNPVs.length?'$'+fmt(Math.min.apply(null,frNPVs),1)+' – $'+fmt(Math.max.apply(null,frNPVs),1)+'M':'—','2026 issues');
    html+=sb('Frontier downside',frRisks.length?'$'+fmt(Math.min.apply(null,frRisks),1)+' – $'+fmt(Math.max.apply(null,frRisks),1)+'M':'—','worst-10% vs plan');
    var frDD=fr.map(function(r){return r.ddWorst;}).filter(function(x){return x!=null&&isFinite(x);});
    html+=sb('Frontier worst drawdown',frDD.length?'$'+fmt(Math.min.apply(null,frDD),1)+' – $'+fmt(Math.max.apply(null,frDD),1)+'M':'—','worst-decile cum DE');
  } else {
    html+=sb('Baseline IRR',pct(bl.portIRR,2));
    html+=sb('Baseline min RBC',rx(bl.minRBC),'2026–2030');
  }
  html+=sb('Total baseline VNB','$'+fmt(totalVNB,1)+'M',fmt(bl.vnbs.MS.r.npvDE,1)+'/'+fmt(bl.vnbs.PN.r.npvDE,1)+'/'+fmt(bl.vnbs.HI.r.npvDE,1)+' MS/PN/HI');
  html+=sb('Baseline PVDE','$'+fmt(bl.npv26,1)+'M','2026 issues, all 3 products');
  html+=sb('Baseline min RBC',rx(bl.minRBC),'2026–2030');
  el.innerHTML=html;
  renderReco();
}
function renderReco(){
  var el=document.getElementById('reco-banner'); if(!el)return;
  if(!S.results||!S.results.length){el.style.display='none';return;}
  el.style.display='block';
  var feas=S.results.filter(function(r){return !r.isCustom&&r.feasible&&isFinite(r.portNPV);});
  if(!feas.length){
    el.className='reco-banner empty';
    el.innerHTML='<div class="rb-eyebrow">No feasible mix</div><div style="font-size:14px;font-weight:600;color:var(--ink)">No sampled scenario clears every constraint.</div><div class="rb-note">Open <em>What-if \u2014 constraint shadow prices</em> below to see which rule is binding and how much feasible return relaxing it would unlock.</div>';
    return;
  }
  var pool=feas.filter(function(r){return r.isFrontier;}); if(!pool.length)pool=feas;
  // Balanced recommendation: lean to upside (PVDE) with a mild downside penalty, and keep an
  // RBC safety margin above the floor \u2014 i.e. take on return-generating risk, but not so much
  // that we crowd the capital threshold. (A pure min-risk pick would leave return on the table.)
  var floor=(S.cons&&S.cons.rbcFloor)||3.0;
  var safe=pool.filter(function(r){return isFinite(r.minRBC)&&r.minRBC>=floor+0.5;});
  var cand=safe.length?safe:pool;
  var score=function(r){return r.portNPV-0.5*r.risk;};   // upside-leaning, modest downside penalty
  var best=cand.reduce(function(a,b){return score(b)>score(a)?b:a;});
  var marginNote=safe.length?'keeps RBC at least 0.5\u00d7 above the '+rx(floor)+' floor':'closest to the RBC floor among feasible mixes \u2014 no plan clears the floor with margin';
  var robustTag=best.robust?' <span class="chip" style="background:#0B7A8C;color:#fff">robust</span>':'';
  var dnStr='$'+fmt(best.risk,1)+'M';
  el.className='reco-banner';
  el.innerHTML='<div class="rb-eyebrow">Recommended 2026 mix \u00b7 balanced \u2014 upside-leaning, within an RBC safety margin'+(best.isFrontier?' \u00b7 on the efficient frontier':'')+'</div>'+
    '<div class="rb-mix">MS $'+fmt(best.sales.MS,0)+'M &nbsp;\u00b7&nbsp; PN $'+fmt(best.sales.PN,0)+'M &nbsp;\u00b7&nbsp; HI $'+fmt(best.sales.HI,0)+'M'+robustTag+'</div>'+
    '<div class="rb-metrics">'+
      '<div class="rb-metric"><div class="k">2026 PVDE (return)</div><div class="v">$'+fmt(best.portNPV,1)+'M</div></div>'+
      '<div class="rb-metric"><div class="k">Portfolio IRR</div><div class="v">'+pct(best.portIRR,1)+'</div></div>'+
      '<div class="rb-metric"><div class="k">Downside vs plan</div><div class="v">'+dnStr+'</div></div>'+
      '<div class="rb-metric"><div class="k">Worst drawdown</div><div class="v">$'+fmt(best.ddWorst,1)+'M</div></div>'+
      '<div class="rb-metric"><div class="k">Min RBC 26\u201330</div><div class="v">'+rx(best.minRBC)+'</div></div>'+
    '</div>'+
    '<div class="rb-note">Chosen for strong upside while it '+marginNote+'. Of '+feas.length+' feasible scenario'+(feas.length!==1?'s':'')+', this mix leans into return rather than minimizing downside. Compare alternatives in the table; test durability with <em>Frontier robustness</em>.</div>';
}
function renderScenTable(){
  var filt=(document.querySelector('input[name="scen-filter"]:checked')||{value:'all'}).value;
  var rows=S.results.slice();
  if(filt==='frontier')rows=rows.filter(function(r){return r.isFrontier;});
  else if(filt==='feasible')rows=rows.filter(function(r){return r.feasible;});
  else if(filt==='infeasible')rows=rows.filter(function(r){return !r.feasible;});
  // Sort by ID number (deterministic run order); custom scenarios (string id 'C..') go last
  rows.sort(function(a,b){var ac=String(a.id).charAt(0)==='C',bc=String(b.id).charAt(0)==='C';if(ac&&!bc)return 1;if(bc&&!ac)return -1;return (parseInt(a.id,10)||0)-(parseInt(b.id,10)||0);});
  document.getElementById('tbl-caption').textContent=rows.length+' scenario'+(rows.length!==1?'s':'');
  var h='<table class="scen-tbl"><thead><tr><th class="lc">ID</th><th>Status</th><th>MS $M</th><th>PN $M</th><th>HI $M</th><th>PVDE $M</th><th>Downside vs plan</th><th>Worst DD</th><th>IRR</th><th>Wtd Target IRR</th><th>Min RBC</th><th title="Observed share of stochastic draws with trough RBC below the C9 threshold (Slow mode only)">P(RBC&lt;'+rx(S.cons.rbcTailX)+')</th><th>P10 IRR</th><th>Failures</th></tr></thead><tbody>';
  rows.forEach(function(r){
    var st=r.isCustom?'<span class="chip" style="background:#C4881A;color:#fff">★ custom</span> '+(r.feasible?'<span class="chip ok">feasible</span>':'<span class="chip bad">infeasible</span>'):(r.isFrontier?'<span class="chip fr">frontier</span>':r.feasible?'<span class="chip ok">feasible</span>':'<span class="chip bad">infeasible</span>');
    if(r.robust&&r.isFrontier)st+=' <span class="chip" style="background:#0B7A8C;color:#fff">robust</span>';
    var p10=r.stochIRRs&&r.stochIRRs.length?pctile(r.stochIRRs,10):null;
    var rbcProb=(r.stochMinRBC&&r.stochMinRBC.length)?(r.stochMinRBC.filter(function(x){return x<S.cons.rbcTailX;}).length/r.stochMinRBC.length):null;
    var fails=r.failures.map(function(f){return'<span class="chip bad" style="font-size:10px">'+f.code+'</span>';}).join(' ');
    var rowStyle=r.isCustom?' style="background:#fdf6e8"':(r.isFrontier?' class="fr-row"':'');
    h+='<tr'+rowStyle+'><td style="font-family:var(--mono)'+(r.isCustom?';font-weight:700;color:#8a5e10':'')+'">'+r.id+'</td><td>'+st+'</td><td>'+fmt(r.sales.MS,0)+'</td><td>'+fmt(r.sales.PN,0)+'</td><td>'+fmt(r.sales.HI,1)+'</td><td>'+fmt(r.portNPV,1)+'</td><td>'+fmt(r.risk,1)+'</td><td>'+fmt(r.ddWorst,1)+'</td><td>'+pct(r.portIRR,2)+'</td><td>'+pct(r.wtdIRR,2)+'</td><td>'+rx(r.minRBC)+'</td><td'+(rbcProb!=null&&rbcProb>S.cons.rbcTailY?' style="color:var(--red);font-weight:700"':'')+'>'+(rbcProb!=null?pct(rbcProb,1):'—')+'</td><td>'+pct(p10,2)+'</td><td style="text-align:left">'+fails+'</td></tr>';
  });
  document.getElementById('scen-tbl-wrap').innerHTML=h+'</tbody></table>';
}

/* ---- Step 4: What-if constraint shadow prices ----
   Re-evaluates feasibility under perturbed constraint thresholds using each scenario's
   already-stored metrics (no re-simulation, no engine calls). The marginal value of a
   constraint is the change in the best attainable feasible PVDE (and feasible count). */
function evalFeasUnder(cons){
  var save=S.cons;S.cons=cons;
  var nFeas=0,best=null;
  S.results.forEach(function(r){
    if(r.isCustom)return;
    var fails=evalCons(r,{irrs:r.stochIRRs,minRBCs:r.stochMinRBC});
    if(fails.length===0){nFeas++;if(isFinite(r.portNPV)&&(best===null||r.portNPV>best))best=r.portNPV;}
  });
  S.cons=save;
  return {nFeas:nFeas,bestPVDE:best};
}
function computeShadowPrices(){
  var el=document.getElementById('shadow-result');
  if(!S.results.length){el.innerHTML='<p class="hint">Run the frontier first.</p>';return;}
  readInputs();
  var base=evalFeasUnder(Object.assign({},S.cons));
  function pvdeStr(v){return v==null?'—':'$'+fmt(v,1)+'M';}
  function delta(now){if(now==null)return '—';if(base.bestPVDE==null)return '+$'+fmt(now,1)+'M (from none)';return (now-base.bestPVDE>=0?'+':'')+'$'+fmt(now-base.bestPVDE,1)+'M';}
  function row(label,fromTxt,toTxt,res){
    var dF=res.nFeas-base.nFeas;
    var hot=(dF>0)||(res.bestPVDE!=null&&(base.bestPVDE==null||res.bestPVDE>base.bestPVDE+1e-9));
    return '<tr'+(hot?' style="background:#eef7f3"':'')+'><td style="text-align:left;padding:5px 8px">'+label+'</td>'+
      '<td style="padding:5px 8px;font-family:var(--mono)">'+fromTxt+' → '+toTxt+'</td>'+
      '<td style="padding:5px 8px;font-family:var(--mono);text-align:right">'+res.nFeas+' ('+(dF>=0?'+':'')+dF+')</td>'+
      '<td style="padding:5px 8px;font-family:var(--mono);text-align:right">'+pvdeStr(res.bestPVDE)+'</td>'+
      '<td style="padding:5px 8px;font-family:var(--mono);text-align:right;font-weight:700;color:'+(hot?'#0B7A8C':'#6b7a91')+'">'+delta(res.bestPVDE)+'</td></tr>';
  }
  function relax(field,delta2,label,fromTxt,toTxt){var c=Object.assign({},S.cons);c[field]=c[field]+delta2;return row(label,fromTxt,toTxt,evalFeasUnder(c));}
  var c3=Object.assign({},S.cons);c3.irr3on=false;
  var html='<div class="hscroll"><table style="font-size:12px;border-collapse:collapse;min-width:max-content;width:auto">'+
    '<thead><tr style="color:var(--muted);text-transform:uppercase;font-size:10px"><th style="text-align:left;padding:5px 8px">Relax constraint</th><th style="padding:5px 8px;text-align:left">Threshold</th><th style="padding:5px 8px;text-align:right">Feasible (Δ)</th><th style="padding:5px 8px;text-align:right">Best feasible PVDE</th><th style="padding:5px 8px;text-align:right">Δ vs base</th></tr></thead><tbody>';
  html+='<tr style="border-bottom:2px solid var(--line)"><td style="text-align:left;padding:5px 8px;font-weight:700">Current (no relaxation)</td><td style="padding:5px 8px">—</td><td style="padding:5px 8px;font-family:var(--mono);text-align:right;font-weight:700">'+base.nFeas+'</td><td style="padding:5px 8px;font-family:var(--mono);text-align:right;font-weight:700">'+pvdeStr(base.bestPVDE)+'</td><td style="padding:5px 8px;text-align:right">—</td></tr>';
  html+=relax('rbcFloor',-0.25,'C1 — RBC floor lower',rx(S.cons.rbcFloor),rx(S.cons.rbcFloor-0.25));
  html+=relax('tacChgFloor',-0.05,'C2 — ΔTAC floor lower',pct(S.cons.tacChgFloor),pct(S.cons.tacChgFloor-0.05));
  html+=row('C3 — IRR-vs-target off','on','off',evalFeasUnder(c3));
  html+=relax('irrB',+0.05,'C4 — IRR-tail tolerance looser',pct(S.cons.irrB),pct(S.cons.irrB+0.05));
  html+=relax('irrA',-0.01,'C4 — IRR floor lower',pct(S.cons.irrA),pct(S.cons.irrA-0.01));
  html+=relax('deYr',+1,'C5 — DE-positive year +1','yr '+S.cons.deYr,'yr '+(S.cons.deYr+1));
  html+=relax('cumDeYr',+1,'C6 — CumDE-positive year +1','yr '+S.cons.cumDeYr,'yr '+(S.cons.cumDeYr+1));
  html+=relax('cumDEFloor',-20,'C7 — CumDE floor lower','$'+fmt(S.cons.cumDEFloor,0)+'M','$'+fmt(S.cons.cumDEFloor-20,0)+'M');
  html+=relax('de1Floor',-30,'C8 — Year-1 DE floor lower','$'+fmt(S.cons.de1Floor,0)+'M','$'+fmt(S.cons.de1Floor-30,0)+'M');
  if(S.results.some(function(r){return r.stochMinRBC&&r.stochMinRBC.length;})){   // RBC-tail rows only meaningful after a Slow run
    html+=relax('rbcTailX',-0.25,'C9 — RBC tail floor lower',rx(S.cons.rbcTailX),rx(S.cons.rbcTailX-0.25));
    html+=relax('rbcTailY',+0.05,'C9 — RBC tail tolerance looser',pct(S.cons.rbcTailY),pct(S.cons.rbcTailY+0.05));
  }
  html+='</tbody></table></div>';
  html+='<p class="hint" style="margin-top:8px">Highlighted rows unlock additional feasible return. "Δ vs base" is the change in the best feasible PVDE (the highest-return scenario that passes every constraint). Each row relaxes one constraint only; effects are not additive.</p>';
  el.innerHTML=html;
}

/* ---- Step 5: Frontier robustness ----
   Re-ranks the efficient frontier under harsher downside views derived from each scenario's
   stored draws (no re-simulation). A scenario is "robust" if it stays non-dominated under
   every view. Sets r.robust and re-renders the table with a robust badge. */
function testRobustness(){
  var el=document.getElementById('robust-result');
  if(!S.results.length){el.innerHTML='<p class="hint">Run the frontier first.</p>';return;}
  var feasN=S.results.filter(function(r){return !r.isCustom&&r.feasible;}).length;
  if(!feasN){el.innerHTML='<p class="hint">No feasible scenarios under the current constraints — relax a constraint (see What-if above) and re-run before testing robustness.</p>';S.results.forEach(function(r){r.robust=false;});renderScenTable();return;}
  var views=[
    {name:'Base (CTE-90)',fn:function(r){return r.risk;}},
    {name:'Deeper tail (CTE-95)',fn:function(r){return r.stochNPVs?cteShortfall(r.stochNPVs,r.npv26,5):r.risk;}},
    {name:'Amplified dispersion ×1.5',fn:function(r){return r.stochNPVs?cteShortfallScaled(r.stochNPVs,r.npv26,10,1.5):r.risk;}},
    {name:'Worst case',fn:function(r){return r.stochNPVs?(r.npv26-Math.min.apply(null,r.stochNPVs.filter(function(x){return isFinite(x);}))):r.risk;}}
  ];
  var sets=views.map(function(v){return frontierSetBy(v.fn);});
  // robust = on the frontier under every view
  var robustIds=[];
  S.results.forEach(function(r){r.robust=false;});
  Object.keys(sets[0]).forEach(function(id){
    if(sets.every(function(s){return s[id];})){robustIds.push(id);var rr=S.results.find(function(x){return String(x.id)===String(id);});if(rr)rr.robust=true;}
  });
  var html='<div class="hscroll"><table style="font-size:12px;border-collapse:collapse;min-width:max-content;width:auto"><thead><tr style="color:var(--muted);text-transform:uppercase;font-size:10px"><th style="text-align:left;padding:5px 8px">Downside view</th><th style="padding:5px 8px;text-align:right">Frontier points</th></tr></thead><tbody>';
  views.forEach(function(v,i){html+='<tr><td style="text-align:left;padding:5px 8px">'+v.name+'</td><td style="padding:5px 8px;text-align:right;font-family:var(--mono)">'+Object.keys(sets[i]).length+'</td></tr>';});
  html+='</tbody></table></div>';
  html+='<p style="margin-top:8px;font-size:13px"><strong>'+robustIds.length+'</strong> scenario'+(robustIds.length!==1?'s':'')+' stay non-dominated under <em>all</em> downside views'+(robustIds.length?': '+robustIds.map(function(x){return '#'+x;}).join(', '):'')+'. These are flagged <span class="chip" style="background:#0B7A8C;color:#fff">robust</span> in the table below.</p>';
  html+='<p class="hint">A scenario that is on the frontier at CTE-90 but drops off under a deeper tail, amplified dispersion, or worst case is sensitive to how downside is measured — its position depends on optimistic risk assumptions.</p>';
  el.innerHTML=html;
  renderScenTable();
}

/* ---- VNB tab ---- */
/* ---- Shared scenario+sensitivity selection (persists across all tabs) ---- */
function currentScen(){return S.sel.scen==='base'?null:S.results.find(function(r){return String(r.id)===String(S.sel.scen);});}
function pushSelectionToDropdowns(){
  // Push S.sel.scen to every scenario dropdown
  ['vnbScenSel','rbcScenSel','evScenSel','dbgScenSel'].forEach(function(id){
    var el=document.getElementById(id);if(el&&el.value!==String(S.sel.scen))el.value=String(S.sel.scen);
  });
  var scen=currentScen();
  // Rebuild + push sensitivity to every sensitivity dropdown
  ['vnbSensSel','rbcSensSel','evSensSel','dbgSensSel'].forEach(function(id){syncSensSel(id,scen);});
}
function setSelection(scen,sens){
  if(scen!==undefined&&scen!==null)S.sel.scen=String(scen);
  if(sens!==undefined&&sens!==null)S.sel.sens=String(sens);
  // If the scenario changed, validate the sensitivity is still in range
  var s=currentScen();
  if(!s||S.sel.sens==='det'||!s.stochScalars||+S.sel.sens>=s.stochScalars.length)S.sel.sens=S.sel.sens==='det'?'det':(s&&s.stochScalars&&s.stochScalars.length?S.sel.sens:'det');
  pushSelectionToDropdowns();
  // Re-render whichever scenario-aware tab is active
  var active=document.querySelector('.tab.active');
  if(active){var id=active.id;
    if(id==='tab-vnb')renderVNB();
    else if(id==='tab-rbc')renderRBC();
    else if(id==='tab-evidence')renderEvidence();
    else if(id==='tab-debug')renderDebug();
  }
}

/* ---- Sensitivity dropdown helper (shared by VNB / RBC tabs) ---- */
function syncSensSel(selId,scen){
  var el=document.getElementById(selId);if(!el)return 'det';
  var cur=S.sel.sens||'det';   // drive from shared state, not the element
  if(scen&&scen.stochScalars&&scen.stochScalars.length){
    var opts='<option value="det">Deterministic (no shocks)</option>'+scen.stochScalars.map(function(sc,i){return'<option value="'+i+'"'+(String(i)===cur?' selected':'')+'>Run '+(i+1)+' — IRR '+pct(scen.stochIRRs[i],2)+'</option>';}).join('');
    el.innerHTML=opts; el.disabled=false; el.value=cur;
  } else {
    el.innerHTML='<option value="det">Deterministic (no shocks)</option>'; el.value='det'; el.disabled=true; cur='det';
  }
  return el.value||'det';
}
function sensScalars(scen,sensId){
  var claims={MS:1,PN:1,HI:1},lapse={MS:1,PN:1,HI:1},nier=null;
  if(scen&&sensId!=='det'&&scen.stochScalars&&scen.stochScalars[+sensId]){
    var sc=scen.stochScalars[+sensId];claims=sc.claims;lapse=sc.lapse;
    // back-book NIER routed into RBC for the selected stochastic run (combined=sys+proc on new biz; proc on pre-2026)
    if(sc.nier||sc.nierProc)nier={combined:sc.nier||{},proc:sc.nierProc||{}};
  }
  return {claims:claims,lapse:lapse,nier:nier};
}
/* ---- sales LEVELS ($M) for a selection (not scalars) ----
   Scenario: the growth-compounded forward projection (updSales from mkScalars).
   Baseline (scen=null): the workbook per-year anchors. Indexed by SALES_YEARS. */
function salesLevels(scen){
  var out={};
  if(scen){
    var sc=mkScalars(scenSales(scen),{MS:1,PN:1,HI:1},{MS:1,PN:1,HI:1});
    PRODS.forEach(function(c){out[c]=SALES_YEARS.map(function(y,i){return sc.updSales[PNAME[c]][i];});});
  }else{
    PRODS.forEach(function(c){out[c]=SALES_YEARS.map(function(y){return S.origSales[c][y];});});
  }
  return out;
}
function salesLevelTable(scen){
  var lv=salesLevels(scen),shortName={MS:'Med Supp',PN:'Preneed',HI:'Hosp Ind'};
  var h='<table class="atbl"><thead><tr><th>Sales ($M/yr)</th>'+SALES_YEARS.map(function(y){return'<th>'+y+'</th>';}).join('')+'</tr></thead><tbody>';
  PRODS.forEach(function(c){h+='<tr><td>'+shortName[c]+'</td>'+lv[c].map(function(v){return'<td>'+fmt(v,1)+'</td>';}).join('')+'</tr>';});
  return h+'</tbody></table>';
}
function renderVNB(){
  if(!S.baseline)return;
  var c=S.vnbProd,basis=S.vnbBasis,P=S.params.assum;
  var sid=S.sel.scen;
  var scen=currentScen();
  var sensId=syncSensSel('vnbSensSel',scen);
  var vnb,res;
  if(sid==='base'||basis==='orig'||!scen){vnb=S.baseline.vnbs[c].v;res=S.baseline.vnbs[c].r;}
  else{var ss=sensScalars(scen,sensId);var d=buildScen(scenSales(scen),ss.claims,ss.lapse,ss.nier);vnb=d.recNB[c];res=EFENG.vnbResults(vnb,P.disc);}
  var statsEl=document.getElementById('vnbStats');
  statsEl.innerHTML='<div class="vnb-stat"><span class="k">IRR</span><span class="v">'+pct(res.irr,2)+'</span></div><div class="vnb-stat"><span class="k">PV Dist. Earnings</span><span class="v">'+fmt(res.npvDE,1)+' <small style="font-size:13px;color:#9fc6cc">$M</small></span></div><div class="vnb-stat"><span class="k">PV Premium</span><span class="v">'+fmt(res.npvPremium,0)+' <small style="font-size:13px;color:#9fc6cc">$M</small></span></div><div class="vnb-stat"><span class="k">Product / Basis</span><span class="v" style="font-size:14px">'+({MS:'Med Supp',PN:'Preneed',HI:'Hosp Ind'})[c]+' / '+(basis==='orig'?'Orig':'Recalc')+'</span></div>';
  var vsEl=document.getElementById('vnbSales');
  if(vsEl){
    var lab=scen?('Selected scenario #'+scen.id+' — projected sales levels ($M): 2026 anchor compounded by the growth schedule.'):'Baseline — workbook sales anchors ($M).';
    vsEl.innerHTML='<div class="hint" style="margin-bottom:5px">'+lab+'</div><div class="hscroll">'+salesLevelTable(scen)+'</div>';
  }
  var rows=[['Premium','Premium'],['Investment income','NII'],['Total revenue','TotRev'],['Claims','Claims'],['Other benefits','OthBen'],['Total benefits','TotBen'],['Commissions','Comm'],['Premium tax','PremTax'],['Acquisition','Acq'],['Maintenance','Maint'],['Total expenses','TotExp'],['Pre-tax income','PTI'],['Tax','Tax'],['After-tax income','ATI'],['Change in TS','ChgTS'],['Distributable earnings','DE']];
  var yrs=[]; for(var y=2026;y<=2055;y++)yrs.push(y);
  var h='<thead><tr><th>Line ($M)</th>'+yrs.map(function(y){return'<th>'+y+'</th>';}).join('')+'</tr></thead><tbody>';
  rows.forEach(function(r){var rl=['TotRev','TotBen','TotExp','PTI','ATI','DE'].indexOf(r[1])>=0;h+='<tr'+(rl?' class="rule"':'')+'><td>'+r[0]+'</td>'+yrs.map(function(y){return'<td>'+fmt((vnb.annual[r[1]]||{})[y],1)+'</td>';}).join('')+'</tr>';});
  document.getElementById('vnbTbl').innerHTML=h+'</tbody>';
}

/* ---- RBC tab ---- */
function renderRBC(){
  if(!S.baseline)return;
  var basis=S.rbcBasis,ys=[2025,2026,2027,2028,2029,2030];
  var sid=S.sel.scen;
  var scen=currentScen();
  var sensId=syncSensSel('rbcSensSel',scen);
  var sc=basis==='orig'||sid==='base'||!scen?S.baseline.surplusCalc:(function(){var ss=sensScalars(scen,sensId);var d=buildScen(scenSales(scen),ss.claims,ss.lapse,ss.nier);return d.surplus;})();
  var minRBC=Math.min.apply(null,[2026,2027,2028,2029,2030].map(function(y){return sc[y]?sc[y].ratio:Infinity;}));
  var minYr=[2026,2027,2028,2029,2030].reduce(function(a,y){return sc[y]&&sc[y].ratio<(sc[a]?sc[a].ratio:Infinity)?y:a;},2026);
  function rsb(k,v){return'<div class="stat-box"><span class="stat-lbl">'+k+'</span><span class="stat-val">'+v+'</span></div>';}
  document.getElementById('rbcShot').innerHTML=rsb('Min RBC 2026–2030',rx(minRBC))+rsb('Binding year',String(minYr))+rsb('2025 anchor',rx(sc[2025]?sc[2025].ratio:null))+rsb('Basis',basis==='orig'?'Baseline':'Scenario');
  var TK=EFENG.TSC_KEYS;
  var h='<thead><tr><th>($M)</th>'+ys.map(function(y){return'<th'+(y>=2026&&y<=2030?' style="background:#fffae8"':'')+'>'+y+'</th>';}).join('')+'</tr></thead><tbody>';
  ['Medicare Supplement','PreNeed','Hospital Indemnity'].forEach(function(p){h+='<tr class="hsec"><td colspan="'+(ys.length+1)+'"><span class="pintitle">'+p+'</span></td></tr>';TK.forEach(function(k){h+='<tr><td style="padding-left:14px">'+k+'</td>'+ys.map(function(y){var d=sc[y];return'<td>'+fmt(d?((d.prod[p]||{})[k]||0):null,3)+'</td>';}).join('')+'</tr>';});});
  h+='<tr class="hsec"><td colspan="'+(ys.length+1)+'"><span class="pintitle">All Other</span></td></tr>';TK.forEach(function(k){h+='<tr><td style="padding-left:14px">'+k+'</td>'+ys.map(function(y){var d=sc[y];return'<td>'+fmt(d?d.allOther[k]:null,3)+'</td>';}).join('')+'</tr>';});
  h+='<tr class="hsec"><td colspan="'+(ys.length+1)+'"><span class="pintitle">All Product (combined)</span></td></tr>';TK.forEach(function(k){h+='<tr><td style="padding-left:14px">'+k+'</td>'+ys.map(function(y){var d=sc[y];return'<td>'+fmt(d?d.tot[k]:null,3)+'</td>';}).join('')+'</tr>';});
  h+='<tr class="sub"><td style="padding-left:14px">Total pre-covariance</td>'+ys.map(function(y){var d=sc[y];return'<td>'+fmt(d?TK.reduce(function(s,k){return s+(d.tot[k]||0);},0):null,3)+'</td>';}).join('')+'</tr>';
  h+='<tr class="rule"><td>Post-covariance</td>'+ys.map(function(y){var d=sc[y];return'<td>'+fmt(d?d.postCov:null,3)+'</td>';}).join('')+'</tr>';
  h+='<tr><td>Required capital (PostCov × 1.03)</td>'+ys.map(function(y){var d=sc[y];return'<td>'+fmt(d?d.reqCap:null,3)+'</td>';}).join('')+'</tr>';
  h+='<tr><td>TAC</td>'+ys.map(function(y){var d=sc[y];return'<td>'+fmt(d?d.tac:null,2)+'</td>';}).join('')+'</tr>';
  h+='<tr class="rule"><td><strong>RBC Ratio</strong></td>'+ys.map(function(y){var d=sc[y],r=d?d.ratio:null,hi=y>=2026&&y<=2030;return'<td'+(hi?' style="background:#fffae8;font-weight:700"':'')+'>'+rx(r)+'</td>';}).join('')+'</tr>';
  document.getElementById('rbcTbl').innerHTML=h+'</tbody>';
}

/* ---- Constraint Evidence tab ---- */
function renderEvidence(){
  var body=document.getElementById('evidenceBody');if(!body||!S.baseline)return;
  var sid=S.sel.scen;
  var scen=currentScen();
  var sensId=syncSensSel('evSensSel',scen);
  if(!scen){body.innerHTML='<p class="hint">Select a run scenario (after running the frontier) to see its constraint evidence. The baseline has no scenario sales applied.</p>';return;}
  var ss=sensScalars(scen,sensId);
  var m=buildScen(scenSales(scen),ss.claims,ss.lapse,ss.nier);
  // Stochastic IRRs for C4 (use the scenario's stored stochastic 2026-issue IRRs)
  var stochIRRs=scen.stochIRRs||[];
  var c=S.cons;
  function card(num,title,pass,rows,note,extra){
    var badge=pass===null?'<span style="background:#eef1f4;color:#6b7a91;font-weight:700;padding:2px 10px;border-radius:20px;font-size:12px">— not run</span>':pass?'<span style="background:#e6f5ea;color:#1c7a3d;font-weight:700;padding:2px 10px;border-radius:20px;font-size:12px">✓ PASS</span>':'<span style="background:#fdeaea;color:#b3261e;font-weight:700;padding:2px 10px;border-radius:20px;font-size:12px">✗ FAIL</span>';
    var h='<div class="card" style="margin-bottom:14px"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><h3 style="font-size:14px;font-weight:650;margin:0">'+num+' — '+title+'</h3>'+badge+'</div>';
    h+='<table style="font-size:12px;border-collapse:collapse">'+rows+'</table>';
    if(extra)h+=extra;
    if(note)h+='<p class="hint" style="margin-top:8px">'+note+'</p>';
    return h+'</div>';
  }
  function row(k,v,hl){return'<tr><td style="padding:3px 10px 3px 0;color:var(--muted);white-space:nowrap">'+k+'</td><td style="padding:3px 0;font-family:var(--mono)'+(hl?';font-weight:700;color:'+(hl==='bad'?'var(--red)':'var(--teal)'):'')+'">'+v+'</td></tr>';}
  // Year-by-year table: years = array, rows = [{label, vals:[..], fmt:fn, bad:fn}]
  function yearTable(years,specs){
    var h='<div class="hscroll" style="margin-top:6px"><table style="font-size:11.5px;border-collapse:collapse;min-width:max-content"><thead><tr><th style="text-align:left;padding:4px 8px 4px 0;color:var(--muted);font-weight:600">Year</th>'+years.map(function(y){return'<th style="padding:4px 8px;text-align:right;color:var(--muted);font-weight:600">'+y+'</th>';}).join('')+'</tr></thead><tbody>';
    specs.forEach(function(sp){
      h+='<tr><td style="padding:3px 8px 3px 0;white-space:nowrap">'+sp.label+'</td>'+years.map(function(y,i){
        var v=sp.vals[i];var bad=sp.bad?sp.bad(v,y):false;
        return'<td style="padding:3px 8px;text-align:right;font-family:var(--mono)'+(bad?';color:var(--red);font-weight:700':'')+'">'+(sp.fmt?sp.fmt(v):v)+'</td>';
      }).join('')+'</tr>';
    });
    return h+'</tbody></table></div>';
  }
  var html='';

  // C1 — Min RBC (all years) — shown as RBC ratio by year
  var minRBC=m.minRBC, c1pass=minRBC>=c.rbcFloor;
  var c1yrs=[2026,2027,2028,2029,2030];
  var c1tbl=yearTable(c1yrs,[
    {label:'RBC ratio',vals:c1yrs.map(function(y){return m.surplus[y]?m.surplus[y].ratio:null;}),fmt:function(v){return rx(v);},bad:function(v){return v!=null&&v<c.rbcFloor;}},
    {label:'TAC ($M)',vals:c1yrs.map(function(y){return m.surplus[y]?m.surplus[y].tac:null;}),fmt:function(v){return fmt(v,1);}},
    {label:'Req. capital ($M)',vals:c1yrs.map(function(y){return m.surplus[y]?m.surplus[y].reqCap:null;}),fmt:function(v){return fmt(v,1);}}
  ]);
  html+=card('C1','Minimum RBC ratio (2026–2030, full book)',c1pass,
    row('Floor','≥ '+rx(c.rbcFloor))+row('Min RBC over window',rx(minRBC),c1pass?'good':'bad'),
    'Required capital = post-covariance × 1.03. Uses the full book / all issue years.',c1tbl);

  // C2 — change in TAC / BOP TAC — shown by year
  var c2yrs=[2026,2027,2028,2029,2030,2031,2032,2033,2034,2035];
  var minTac=Math.min.apply(null,c2yrs.map(function(y){return m.tacChg[y]!=null?m.tacChg[y]:Infinity;}));
  var minTacYr=c2yrs.reduce(function(a,y){return (m.tacChg[y]!=null&&m.tacChg[y]<(m.tacChg[a]!=null?m.tacChg[a]:Infinity))?y:a;},c2yrs[0]);
  var c2pass=minTac>=c.tacChgFloor;
  var c2tbl=yearTable(c2yrs,[
    {label:'ΔTAC / BOP TAC',vals:c2yrs.map(function(y){return m.tacChg[y];}),fmt:function(v){return pct(v,1);},bad:function(v){return v!=null&&v<c.tacChgFloor;}},
    {label:'TAC ($M)',vals:c2yrs.map(function(y){return m.surplus[y]?m.surplus[y].tac:null;}),fmt:function(v){return fmt(v,1);}}
  ]);
  html+=card('C2','Change in TAC / BOP TAC (full book)',c2pass,
    row('Floor','≥ '+pct(c.tacChgFloor))+row('Worst year',minTacYr+' at '+pct(minTac),c2pass?'good':'bad'),
    '(TAC[y] − TAC[y−1]) / TAC[y−1], each year. Replaces the former ATI/BOP-C&S test and the old TAC-decline limit.',c2tbl);

  // C3 — 2026-issue IRR vs target
  var irr26=m.irr26, tgt=m.wtdIRR, c3pass=!(c.irr3on&&irr26!=null&&irr26<tgt);
  html+=card('C3','2026-issue IRR vs sales-weighted target',c3pass,
    row('2026-issue IRR',irr26!=null?pct(irr26,2):'undefined',c3pass?'good':'bad')+row('Target (2026 wtd hurdle)',pct(tgt,2))+row('Enforced',c.irr3on?'yes':'no')+row('Sales mix','MS '+fmt(scen.sales.MS,0)+' / PN '+fmt(scen.sales.PN,0)+' / HI '+fmt(scen.sales.HI,1)),
    'IRR of the 2026 issue-year DE stream (all 3 products), excluding pre-2026 in-force, vs the hurdle weighted by the 2026 sales mix.');

  // C4 — 2026-issue IRR tail
  var below=stochIRRs.filter(function(x){return x!=null&&x<c.irrA;}).length;
  var prob=stochIRRs.length?below/stochIRRs.length:0;
  var c4pass=!(stochIRRs.length&&prob>c.irrB);
  html+=card('C4','2026-issue IRR tail risk',c4pass,
    row('Threshold a','IRR < '+pct(c.irrA))+row('Max probability b','< '+pct(c.irrB))+row('Observed P(IRR<a)',pct(prob)+' ('+below+' / '+stochIRRs.length+' runs)',c4pass?'good':'bad')+row('Stochastic runs',String(stochIRRs.length)),
    stochIRRs.length?'Across the scenario\'s stochastic claim/lapse draws.':'No stochastic runs available for this scenario (run with stochastic count > 0).');

  // C5 — 2026-issue DE positive by year — show the DE stream by year
  var dy=2025+c.deYr, deV=m.de26[dy]||0, c5pass=deV>0;
  var dePos=m.de26PosYr;
  var c5yrs=[];for(var yy=2026;yy<=2040;yy++)c5yrs.push(yy);
  var c5tbl=yearTable(c5yrs,[
    {label:'2026-issue DE ($M)',vals:c5yrs.map(function(y){return m.de26[y]||0;}),fmt:function(v){return fmt(v,1);},bad:function(v,y){return y===dy&&v<=0;}}
  ]);
  html+=card('C5','2026-issue DE positive by year',c5pass,
    row('Target year','yr '+c.deYr+' (calendar '+dy+')')+row('2026-issue DE that year',fmt(deV,2)+' $M',c5pass?'good':'bad')+row('First year DE turns positive',dePos?String(dePos):'never in horizon'),
    '2026 issue-year distributable earnings (all 3 products summed), pre-2026 in-force excluded. Target year highlighted if negative.',c5tbl);

  // C6 — 2026-issue cumulative DE positive by year — show cumulative stream by year
  var cy=2025+c.cumDeYr, cumV=m.cumDE26[cy]||0, c6pass=cumV>0;
  var cumPos=m.cumDE26PosYr;
  var c6yrs=[];for(var yy=2026;yy<=2040;yy++)c6yrs.push(yy);
  var c6tbl=yearTable(c6yrs,[
    {label:'2026-issue cumulative DE ($M)',vals:c6yrs.map(function(y){return m.cumDE26[y]||0;}),fmt:function(v){return fmt(v,1);},bad:function(v,y){return y===cy&&v<=0;}}
  ]);
  html+=card('C6','2026-issue cumulative DE positive by year',c6pass,
    row('Target year','yr '+c.cumDeYr+' (calendar '+cy+')')+row('2026-issue cumDE that year',fmt(cumV,2)+' $M',c6pass?'good':'bad')+row('First year cumDE turns positive',cumPos?String(cumPos):'never in horizon'),
    'Cumulative 2026 issue-year DE (all 3 products), pre-2026 in-force excluded. Target year highlighted if negative.',c6tbl);

  // CumDE floor — 2026 issues
  var cumVals=Object.keys(m.cumDE26).map(function(y){return m.cumDE26[y];});
  var minCum=Math.min.apply(null,cumVals);
  var minCumYr=Object.keys(m.cumDE26).reduce(function(a,y){return m.cumDE26[y]<m.cumDE26[a]?y:a;},Object.keys(m.cumDE26)[0]);
  var cfpass=!(c.cumDEFloor!=null&&minCum<c.cumDEFloor);
  html+=card('C7','CumDE floor — maximum 2026-issue capital drawdown',cfpass,
    row('Floor','≥ '+fmt(c.cumDEFloor,0)+' $M')+row('Deepest cumDE',fmt(minCum,1)+' $M in '+minCumYr,cfpass?'good':'bad'),
    'The most negative the 2026-issue cumulative DE reaches before turning cash-positive — the peak capital at risk on the 2026 cohort.');

  // Year-1 DE floor — 2026-issue first-year acquisition strain
  var de1V=m.de26[2026]||0, d1pass=!(c.de1Floor!=null&&de1V<c.de1Floor);
  var d1yrs=[];for(var yy=2026;yy<=2030;yy++)d1yrs.push(yy);
  var d1tbl=yearTable(d1yrs,[
    {label:'2026-issue DE ($M)',vals:d1yrs.map(function(y){return m.de26[y]||0;}),fmt:function(v){return fmt(v,1);},bad:function(v,y){return y===2026&&c.de1Floor!=null&&v<c.de1Floor;}}
  ]);
  html+=card('C8','Year-1 (2026) distributable-earnings floor',d1pass,
    row('Floor','≥ $'+fmt(c.de1Floor,0)+'M')+row('2026 (year-1) DE',fmt(de1V,1)+' $M',d1pass?'good':'bad')+row('Headroom vs floor',fmt(de1V-(c.de1Floor||0),1)+' $M',d1pass?'good':'bad'),
    'First-year (2026) distributable earnings on the 2026 issue cohort (all 3 products summed; pre-2026 in-force excluded). Caps how deep the first-year new-business acquisition strain can run — a capital-budget proxy on single-year aggressiveness. 2026 is highlighted if it breaches the floor.',d1tbl);

  // RBC tail — trough RBC ratio across stochastic draws (Slow mode only)
  var rbcArr=scen.stochMinRBC, rtPass=true;
  if(rbcArr&&rbcArr.length){
    var rtBelow=rbcArr.filter(function(r){return r!=null&&r<c.rbcTailX;}).length, rtProb=rtBelow/rbcArr.length;
    rtPass=!(rtProb>c.rbcTailY);
    html+=card('C9','Trough RBC ratio tail risk',rtPass,
      row('Threshold x','min RBC < '+rx(c.rbcTailX))+row('Max probability y','< '+pct(c.rbcTailY))+row('Observed P(min RBC<x)',pct(rtProb)+' ('+rtBelow+' / '+rbcArr.length+' runs)',rtPass?'good':'bad')+row('Worst-draw trough RBC',rx(Math.min.apply(null,rbcArr))),
      'Across the scenario’s stochastic draws, the share whose trough (minimum 2026–2030) RBC ratio falls below the floor. Full-book, note-adjusted — the stochastic counterpart to C1.');
  } else {
    html+=card('C9','Trough RBC ratio tail risk',null,
      row('Threshold x','min RBC < '+rx(c.rbcTailX))+row('Max probability y','< '+pct(c.rbcTailY)),
      'Run in <strong>Slow mode</strong> (Configuration tab) to evaluate this — it recomputes full RBC on every stochastic draw (~4–5 min at 100×100).');
  }

  // Summary banner
  var allPass=[c1pass,c2pass,c3pass,c4pass,c5pass,c6pass,cfpass,d1pass,rtPass];
  var nFail=allPass.filter(function(x){return !x;}).length;
  var banner='<div style="padding:12px 16px;border-radius:8px;margin-bottom:16px;font-weight:650;'+(nFail===0?'background:#e6f5ea;color:#1c7a3d':'background:#fdeaea;color:#b3261e')+'">'+(nFail===0?'✓ Scenario #'+scen.id+' is FEASIBLE — all constraints satisfied':'✗ Scenario #'+scen.id+' is INFEASIBLE — '+nFail+' constraint'+(nFail>1?'s':'')+' failed')+'</div>';

  body.innerHTML=banner+html;
}

/* ---- Debug tab ---- */
function renderDebug(){
  if(!S.baseline)return;
  var sid=S.sel.scen,isBase=sid==='base';
  var scen=currentScen();
  var sensId=syncSensSel('dbgSensSel',scen);
  var useClaims={MS:1,PN:1,HI:1},useLapse={MS:1,PN:1,HI:1},useNier=null;
  if(scen&&sensId!=='det'&&scen.stochScalars&&scen.stochScalars[+sensId]){var sc2=scen.stochScalars[+sensId];useClaims=sc2.claims;useLapse=sc2.lapse;if(sc2.nier||sc2.nierProc)useNier={combined:sc2.nier||{},proc:sc2.nierProc||{}};}
  var P=S.params.assum,det=isBase?null:buildScen(scenSales(scen),useClaims,useLapse,useNier);
  function sec(t,bodyFn){return'<div class="dbg-sec"><div class="dbg-hdr" onclick="this.nextElementSibling.classList.toggle(\'open\')">'+t+' <span>▾</span></div><div class="dbg-body open"><div class="hscroll">'+bodyFn()+'</div></div></div>';}
  var html='';
  /* 1: Scalars - per year for sales, claims, lapse and (PN) the NIER shift */
  html+=sec('1 — Sales Levels &amp; Scalars',function(){
    var lv=salesLevels(scen);   // scen=null for baseline -> workbook anchors
    function scAt(v,y){return (v==null)?1:(typeof v==='number'?v:(v[y]!=null?v[y]:1));}  // resolve number|per-year-map
    var h='<p class="hint" style="margin-bottom:10px">Per product, by year: forward sales <strong>level</strong> ($M), the sales <strong>scalar</strong> (updated/original), and the <strong>claims</strong> & <strong>lapse</strong> multipliers (per-year on a shock run; 1.0 deterministic — for Preneed they are equal, the single coupled mortality shock). <strong>NIER shift</strong> is the additive earned-rate shock in bps (Preneed only; its back-book difference flows into the RBC calc).'+(isBase?' Baseline shown: levels = workbook anchors, all scalars = 1.0.':'')+'</p>';
    h+='<table><thead><tr><th>Product / Line</th>'+SALES_YEARS.map(function(y){return'<th>'+y+'</th>';}).join('')+'</tr></thead><tbody>';
    PRODS.forEach(function(c){
      var claimsV=isBase?1:det.scalars.claims[PNAME[c]], lapseV=isBase?1:det.scalars.lapse[PNAME[c]];
      var nierV=(useNier&&useNier.combined&&useNier.combined[c])||null;
      h+='<tr class="sub"><td colspan="'+(SALES_YEARS.length+1)+'"><span class="pintitle">'+PNAME[c]+'</span></td></tr>';
      h+='<tr><td style="padding-left:12px">Sales level ($M)</td>'+lv[c].map(function(v){return'<td>'+fmt(v,1)+'</td>';}).join('')+'</tr>';
      h+='<tr class="inc-row"><td style="padding-left:12px">Sales scalar</td>'+SALES_YEARS.map(function(y){return'<td>'+fmt(isBase?1:EFENG.salesScalar(det.scalars,c,String(y)),4)+'</td>';}).join('')+'</tr>';
      h+='<tr><td style="padding-left:12px">Claims scalar</td>'+SALES_YEARS.map(function(y){return'<td>'+fmt(scAt(claimsV,y),4)+'</td>';}).join('')+'</tr>';
      h+='<tr><td style="padding-left:12px">Lapse scalar</td>'+SALES_YEARS.map(function(y){return'<td>'+fmt(scAt(lapseV,y),4)+'</td>';}).join('')+'</tr>';
      h+='<tr class="inc-row"><td style="padding-left:12px">NIER shift (bps)</td>'+SALES_YEARS.map(function(y){return'<td>'+(nierV?fmt(scAt(nierV,y)*10000,1):'—')+'</td>';}).join('')+'</tr>';
    });
    return h+'</tbody></table>';
  });
  /* 2: In-force + lives issued */
  html+=sec('2 — In-Force &amp; Lives Issued Trace',function(){
    var ys=[2026,2027,2028,2029,2030,2031,2032,2033,2034,2035,2036,2037,2038,2039,2040];
    var h='<table><thead><tr><th>Product / Line / Year</th>'+ys.map(function(y){return'<th>'+y+'</th>';}).join('')+'</tr></thead><tbody>';
    PRODS.forEach(function(c){
      var oL=S.origLIF[c];
      var rL=det?det.recLIF[c]:null;
      var oI=EFENG.evMonthly(S.ev,c,'LivesIssued');
      var rI=det?EFENG.evMonthly(EFENG.recalcEV(S.ev,det.scalars),c,'LivesIssued'):null;
      h+='<tr class="sub"><td colspan="'+(ys.length+1)+'"><span class="pintitle">'+PNAME[c]+'</span></td></tr>';
      h+='<tr><td style="padding-left:12px">Original in-force</td>'+ys.map(function(y){return'<td>'+fmt(oL[12*(y-2025)],0)+'</td>';}).join('')+'</tr>';
      if(rL)h+='<tr><td style="padding-left:12px">Recalc in-force</td>'+ys.map(function(y){return'<td>'+fmt(rL[12*(y-2025)],0)+'</td>';}).join('')+'</tr>';
      if(rL)h+='<tr class="inc-row"><td style="padding-left:12px">Ratio (recalc/orig)</td>'+ys.map(function(y){var p=12*(y-2025),o=oL[p]||0,r=rL[p]||0;return'<td>'+(Math.abs(o)>1e-9?fmt(r/o,4):'—')+'</td>';}).join('')+'</tr>';
      h+='<tr><td style="padding-left:12px">Original lives issued</td>'+ys.map(function(y){var ann=0;for(var m=(y-2025)*12-11;m<=(y-2025)*12;m++)ann+=(m>=0?oI[m]||0:0);return'<td>'+fmt(ann,0)+'</td>';}).join('')+'</tr>';
      if(rI){
        var oIann=ys.map(function(y){var a=0;for(var m=(y-2025)*12-11;m<=(y-2025)*12;m++)a+=(m>=0?oI[m]||0:0);return a;});
        var rIann=ys.map(function(y){var a=0;for(var m=(y-2025)*12-11;m<=(y-2025)*12;m++)a+=(m>=0?rI[m]||0:0);return a;});
        h+='<tr><td style="padding-left:12px">Recalc lives issued</td>'+ys.map(function(y,i){return'<td>'+fmt(rIann[i],0)+'</td>';}).join('')+'</tr>';
        h+='<tr class="inc-row"><td style="padding-left:12px">Ratio issued (recalc/orig)</td>'+ys.map(function(y,i){var o=oIann[i]||0,r2=rIann[i]||0;return'<td>'+(Math.abs(o)>1e-9?fmt(r2/o,4):'—')+'</td>';}).join('')+'</tr>';
      }
    });
    return h+'</tbody></table>';
  });
  /* 3: Income comparison - toggle by product AND issue-year cohort (incl pre-2026 back book) */
  var dbgProd=window._dbgProd||'MS';
  var dbgIY=window._dbgIY||'2026';
  html+=sec('3 — Income Comparison',function(){
    var ys=[2026,2027,2028,2029,2030,2031,2032,2033,2034,2035,2036,2037,2038,2039,2040];
    var pseg='<div style="display:flex;gap:6px;margin-bottom:8px">'+PRODS.map(function(c){return'<button class="btn '+(dbgProd===c?'':'ghost')+' sm" onclick="window._dbgProd=\''+c+'\';renderDebug()">'+(({MS:'Med Supp',PN:'Preneed',HI:'Hosp Ind'})[c])+'</button>';}).join('')+'</div>';
    var iyList=['<2026','2026','2027','2028','2029','2030','2031','2032','2033','2034','2035','all'];
    var iyLab=function(iy){return iy==='all'?'All new biz':(iy==='<2026'?'Pre-2026':iy);};
    var iyseg='<div style="display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap">'+iyList.map(function(iy){return'<button class="btn '+(dbgIY===iy?'':'ghost')+' sm" onclick="window._dbgIY=\''+iy+'\';renderDebug()">'+iyLab(iy)+'</button>';}).join('')+'</div>';
    var nierC=(useNier&&useNier.combined&&useNier.combined[dbgProd])||null;
    var nierP=(useNier&&useNier.proc&&useNier.proc[dbgProd])||null;
    var baseOpts,scenOpts;
    if(dbgIY==='all'){baseOpts={nMonths:360};scenOpts={nMonths:360,nierShift:nierC};}
    else if(dbgIY==='<2026'){baseOpts={nMonths:360,allBook:true,iy:'<2026'};scenOpts={nMonths:360,allBook:true,iy:'<2026',nierShift:nierP};
      if(dbgProd==='PN'){baseOpts.nierKind='NIER_EV';scenOpts.nierKind='NIER_EV';}}   // PN back book values NII on the EV NIER (matches evFullBook)
    else{baseOpts={nMonths:360,iy:dbgIY};scenOpts={nMonths:360,iy:dbgIY,nierShift:nierC};}
    var oV=EFENG.buildVNB(S.ev,dbgProd,{assum:P},baseOpts);
    var rV=det?EFENG.buildVNB(EFENG.recalcEV(S.ev,det.scalars),dbgProd,{assum:P},scenOpts):null;
    var rows=[['Premium','Premium'],['NII','NII'],['Claims','Claims'],['Other Benefits','OthBen'],['Pre-tax income','PTI'],['After-tax income','ATI'],['Change in TS','ChgTS'],['Distributable Earnings','DE']];
    var lbl=dbgIY==='all'?'all new-business cohorts (2026-2035)':(dbgIY==='<2026'?'the pre-2026 back book (existing in-force)':dbgIY+'-issue cohort');
    var h=pseg+iyseg+'<p class="hint" style="margin-bottom:8px">Showing <strong>'+lbl+'</strong> — original (baseline) vs updated (selected scenario/run), and the ratio, by calendar year.</p><table><thead><tr><th>Line ($M) / Year</th>'+ys.map(function(y){return'<th>'+y+'</th>';}).join('')+'</tr></thead><tbody>';
    rows.forEach(function(r){
      h+='<tr class="sub"><td colspan="'+(ys.length+1)+'"><span class="pintitle">'+r[0]+'</span></td></tr>';
      h+='<tr><td style="padding-left:12px">Original</td>'+ys.map(function(y){var o=(oV.annual[r[1]]||{})[y];return'<td>'+fmt(o,1)+'</td>';}).join('')+'</tr>';
      h+='<tr><td style="padding-left:12px">Updated</td>'+ys.map(function(y){var rv=rV?(rV.annual[r[1]]||{})[y]:null;return'<td>'+(rv!=null?fmt(rv,1):'—')+'</td>';}).join('')+'</tr>';
      h+='<tr class="inc-row"><td style="padding-left:12px">Ratio (upd/orig)</td>'+ys.map(function(y){var o=(oV.annual[r[1]]||{})[y]||0,rv=rV?((rV.annual[r[1]]||{})[y]||0):null;return'<td>'+(rv!=null&&Math.abs(o)>1e-9?fmt(rv/o,4):'—')+'</td>';}).join('')+'</tr>';
    });
    return h+'</tbody></table>';
  });
  /* 4: Charge walk - toggle 2026-2030; per-product baseline vs scenario, symmetric */
  var dbgYear=window._dbgYear||2026;
  html+=sec('4 — RBC Charge Walk &amp; Comparison',function(){
    var yrBtns='<div style="display:flex;gap:6px;margin-bottom:10px">'+[2026,2027,2028,2029,2030].map(function(y){return'<button class="btn '+(dbgYear===y?'':'ghost')+' sm" onclick="window._dbgYear='+y+';renderDebug()">'+y+'</button>';}).join('')+'</div>';
    var y=dbgYear,orig=S.baseline.surplusCalc[y];
    if(!orig)return yrBtns+'<p class="hint">No data for this year.</p>';
    var recSc=det?det.surplus[y]:null;
    var pnames=Object.keys(orig.prod);
    var shortP=function(p){return p.replace('Medicare Supplement','Med Supp').replace('Hospital Indemnity','Hosp Ind').replace('PreNeed','Preneed');};
    var note='<p class="hint" style="margin-bottom:8px">'+(recSc?'Per-product NAIC charges, <strong>baseline vs the selected scenario</strong>. All Other is frozen across scenarios; Δ = scenario − baseline on the combined total.':'Baseline only — select a run scenario (top of tab) to see the per-product scenario columns and Δ.')+'</p>';
    var dCol=function(d){return'<td style="color:'+(Math.abs(d)<1e-9?'var(--muted)':(d>0?'var(--red)':'var(--green)'))+'">'+fmt(d,3)+'</td>';};
    var h=yrBtns+note+'<table><thead><tr><th>TSC</th>';
    pnames.forEach(function(p){h+='<th>'+shortP(p)+' Base</th>'+(recSc?'<th>'+shortP(p)+' Scen</th>':'');});
    h+='<th>All Other</th><th>Total Base</th>'+(recSc?'<th>Total Scen</th><th>Δ Total</th>':'')+'</tr></thead><tbody>';
    EFENG.TSC_KEYS.forEach(function(k){
      h+='<tr><td>'+k+'</td>';
      pnames.forEach(function(p){h+='<td>'+fmt((orig.prod[p]||{})[k],3)+'</td>'+(recSc?'<td>'+fmt((recSc.prod[p]||{})[k],3)+'</td>':'');});
      h+='<td>'+fmt(orig.allOther[k],3)+'</td><td>'+fmt(orig.tot[k],3)+'</td>';
      if(recSc)h+='<td>'+fmt(recSc.tot[k],3)+'</td>'+dCol((recSc.tot[k]||0)-(orig.tot[k]||0));
      h+='</tr>';
    });
    var prodCells=pnames.length*(recSc?2:1)+1;   // product columns + All Other, blanked on summary rows
    var blanks=function(n){var s='';for(var i=0;i<n;i++)s+='<td></td>';return s;};
    h+='<tr class="rule"><td>Post-cov</td>'+blanks(prodCells)+'<td>'+fmt(orig.postCov,3)+'</td>'+(recSc?'<td>'+fmt(recSc.postCov,3)+'</td>'+dCol(recSc.postCov-orig.postCov):'')+'</tr>';
    h+='<tr><td>Req capital</td>'+blanks(prodCells)+'<td>'+fmt(orig.reqCap,3)+'</td>'+(recSc?'<td>'+fmt(recSc.reqCap,3)+'</td>'+dCol(recSc.reqCap-orig.reqCap):'')+'</tr>';
    h+='<tr><td>TAC</td>'+blanks(prodCells)+'<td>'+fmt(orig.tac,2)+'</td>'+(recSc?'<td>'+fmt(recSc.tac,2)+'</td><td style="color:'+(recSc.incDelta>=0?'var(--green)':'var(--red)')+'">'+fmt(recSc.incDelta,2)+' (inc Δ)</td>':'')+'</tr>';
    h+='<tr class="rule"><td>RBC Ratio</td>'+blanks(prodCells)+'<td>'+rx(orig.ratio)+'</td>'+(recSc?'<td>'+rx(recSc.ratio)+'</td>'+dCol(recSc.ratio-orig.ratio):'')+'</tr>';
    return h+'</tbody></table>';
  });
  /* 5: Constraints with full descriptions */
  html+=sec('5 — Constraint Status',function(){
    if(isBase)return'<p class="hint">Select a run scenario to see constraint evaluation.</p>';
    var CONS_FULL=[
      ['RBC_FLOOR','C1: Min RBC ratio — min(RBC 2026–2030) ≥ '+rx(S.cons.rbcFloor)+' (all issue years)'],
      ['TAC_CHG','C2: Change in TAC / BOP TAC — annual (TAC−priorTAC)/priorTAC ≥ '+pct(S.cons.tacChgFloor)],
      ['IRR_TARGET','C3: 2026-issue IRR ≥ sales-weighted hurdle (MS '+pct(S.hurdles.MS)+', PN '+pct(S.hurdles.PN)+', HI '+pct(S.hurdles.HI)+'), 2026 weights'],
      ['IRR_TAIL','C4: 2026-issue IRR tail risk — P(IRR < '+pct(S.cons.irrA)+') ≤ '+pct(S.cons.irrB)+' across stochastic runs'],
      ['DE_BY_YEAR','C5: 2026-issue DE (all 3 products) positive by year '+S.cons.deYr+' (calendar year '+(2025+S.cons.deYr)+')'],
      ['CUMDE_BY_YEAR','C6: 2026-issue cumulative DE (all 3 products) positive by year '+S.cons.cumDeYr+' (calendar year '+(2025+S.cons.cumDeYr)+')'],
      ['CUMDE_FLOOR','C7: CumDE floor — min 2026-issue cumulative DE ≥ $'+fmt(S.cons.cumDEFloor,0)+'M'],
      ['DE1_FLOOR','C8: Year-1 DE floor — 2026 (first-year) DE ≥ $'+fmt(S.cons.de1Floor,0)+'M'],
      ['RBC_TAIL','C9: Trough-RBC tail — P(trough RBC < '+rx(S.cons.rbcTailX)+') ≤ '+pct(S.cons.rbcTailY)+' across stochastic runs (Slow mode)']
    ];
    var failMap={};(scen.failures||[]).forEach(function(f){failMap[f.code]=f;});
    var h='<table><thead><tr><th style="min-width:400px">Constraint</th><th>Result</th><th>Detail</th></tr></thead><tbody>';
    CONS_FULL.forEach(function(pair){var f=failMap[pair[0]];h+='<tr><td style="font-size:12px">'+pair[1]+'</td><td>'+(f?'<span class="chip bad">FAIL</span>':'<span class="chip ok">PASS</span>')+'</td><td style="font-family:var(--mono);font-size:11px">'+(f?f.detail:'—')+'</td></tr>';});
    h+='<tr class="rule"><td colspan="3"><strong>'+(Object.keys(failMap).length===0?'✓ All constraints satisfied':'✗ '+Object.keys(failMap).length+' failed')+'</strong></td></tr>';
    return h+'</tbody></table>'+(scen.stochIRRs&&scen.stochIRRs.length?'<p class="hint" style="margin-top:8px">Stochastic runs: '+scen.stochIRRs.length+' — IRR mean '+pct(scen.stochIRRs.reduce(function(a,b){return a+b;},0)/scen.stochIRRs.length,2)+', σ '+pct(stddev(scen.stochIRRs),2)+', P10 '+pct(pctile(scen.stochIRRs,10),2)+', P90 '+pct(pctile(scen.stochIRRs,90),2)+'</p>':'');
  });
  document.getElementById('dbgContent').innerHTML=html;
}

/* ---- Compare tab: two scenarios side by side ---- */
// Normalize a selection ('base' or a result id) into a flat metrics object. Baseline lacks the
// stochastic-risk metrics (returns null for those). RBC-by-year is recomputed deterministically
// via buildScen (it isn't stored on the result object); min RBC uses the stored run value.
function metricsFor(sel){
  if(sel==='base'||sel==null){
    var b=S.baseline;if(!b)return null;
    var rbcB={};[2026,2027,2028,2029,2030].forEach(function(y){rbcB[y]=b.surplusCalc[y]?b.surplusCalc[y].ratio:null;});
    return {label:'Baseline',sales:{MS:S.origSales.MS[2026],PN:S.origSales.PN[2026],HI:S.origSales.HI[2026]},
      npv26:b.npv26,irr26:b.irr26,portNPVAll:b.portNPV,portIRRAll:b.portIRR,wtdIRR:null,
      risk:null,ddWorst:null,riskSD:null,cte90:null,p10:null,p90:null,
      minRBC:b.minRBC,rbc:rbcB,minTacChg:null,de1:null,dePos:null,cumMin:null,cumPos:null,
      feasible:null,isFrontier:null,failCodes:null};
  }
  var r=S.results.find(function(x){return String(x.id)===String(sel);});if(!r)return null;
  var d=buildScen(r.salesTable||r.sales,{MS:1,PN:1,HI:1},{MS:1,PN:1,HI:1});
  var rbc={};[2026,2027,2028,2029,2030].forEach(function(y){rbc[y]=d.surplus[y]?d.surplus[y].ratio:null;});
  var minTac=r.tacChg?Math.min.apply(null,Object.keys(r.tacChg).map(function(y){return r.tacChg[y];})):null;
  var de1=r.de26?(r.de26[2026]||0):null,dePos=null,cumPos=null;
  if(r.de26)for(var y1=2026;y1<=2055;y1++){if(r.de26[y1]>0){dePos=y1;break;}}
  if(r.cumDE26)for(var y2=2026;y2<=2055;y2++){if(r.cumDE26[y2]>0){cumPos=y2;break;}}
  var cumVals=r.cumDE26?Object.keys(r.cumDE26).map(function(y){return r.cumDE26[y];}):[];
  var cumMin=cumVals.length?Math.min.apply(null,cumVals):null;
  var sI=r.stochIRRs||[];
  return {label:(r.isCustom?'★ Custom '+r.id:'#'+r.id),sales:r.sales,
    npv26:r.npv26,irr26:r.irr26,portNPVAll:r.portNPVAll,portIRRAll:r.portIRRAll,wtdIRR:r.wtdIRR,
    risk:r.risk,ddWorst:r.ddWorst,riskSD:r.riskSD,cte90:r.cte90,
    p10:sI.length?pctile(sI,10):null,p90:sI.length?pctile(sI,90):null,
    minRBC:r.minRBC,rbc:rbc,minTacChg:minTac,de1:de1,dePos:dePos,cumMin:cumMin,cumPos:cumPos,
    feasible:r.feasible,isFrontier:r.isFrontier,failCodes:(r.failures||[]).map(function(f){return f.code;})};
}
function renderCompare(){
  var el=document.getElementById('cmp-result');if(!el)return;
  if(!S.baseline){el.innerHTML='<p class="hint">Run the frontier first to populate scenarios, then pick two to compare.</p>';return;}
  var A=metricsFor(S.cmp.a),B=metricsFor(S.cmp.b);
  if(!A||!B){el.innerHTML='<p class="hint">A selected scenario no longer exists — re-run or pick again.</p>';return;}
  function cell(x,u,dec){return (x==null||!isFinite(x))?'—':(u==='$'?'$'+fmt(x,dec)+'M':u==='%'?pct(x,dec):u==='x'?rx(x):fmt(x,dec));}
  function dcell(a,b,u,dec){if(a==null||!isFinite(a)||b==null||!isFinite(b))return'';var d=b-a,s=d>=0?'+':'';return u==='%'?(s+fmt(d*100,dec)+' pp'):u==='x'?(s+fmt(d,3)+'×'):u==='$'?(s+'$'+fmt(d,dec)+'M'):(s+fmt(d,dec));}
  function rowRaw(label,a,b,u,dec){return'<tr><td>'+label+'</td><td>'+cell(a,u,dec)+'</td><td>'+cell(b,u,dec)+'</td><td style="color:var(--muted)">'+dcell(a,b,u,dec)+'</td></tr>';}
  function txt(label,a,b){return'<tr><td>'+label+'</td><td>'+a+'</td><td>'+b+'</td><td></td></tr>';}
  function sub(t){return'<tr class="sub"><td colspan="4">'+t+'</td></tr>';}
  function stat(v){return v==null?'—':(v?'<span class="chip ok">yes</span>':'<span class="chip bad">no</span>');}
  function fails(c){return c==null?'—':(c.length?c.join(', '):'<span class="chip ok">none</span>');}
  function tot(m){return m.sales?(m.sales.MS+m.sales.PN+m.sales.HI):null;}
  var h='<div class="hscroll"><table class="atbl" style="width:100%;table-layout:fixed"><colgroup><col style="width:34%"><col style="width:22%"><col style="width:22%"><col style="width:22%"></colgroup><thead><tr><th>Metric</th><th>'+A.label+'</th><th>'+B.label+'</th><th>Δ (B − A)</th></tr></thead><tbody>';
  h+=sub('Sales — 2026 anchor ($M)');
  h+=rowRaw('Med Supp',A.sales&&A.sales.MS,B.sales&&B.sales.MS,'$',1);
  h+=rowRaw('Preneed',A.sales&&A.sales.PN,B.sales&&B.sales.PN,'$',1);
  h+=rowRaw('Hosp Ind',A.sales&&A.sales.HI,B.sales&&B.sales.HI,'$',1);
  h+=rowRaw('Total',tot(A),tot(B),'$',1);
  h+=sub('Return');
  h+=rowRaw('2026 PVDE',A.npv26,B.npv26,'$',1);
  h+=rowRaw('2026 IRR',A.irr26,B.irr26,'%',2);
  h+=rowRaw('Full-book PVDE',A.portNPVAll,B.portNPVAll,'$',1);
  h+=rowRaw('Full-book IRR',A.portIRRAll,B.portIRRAll,'%',2);
  h+=rowRaw('Wtd target IRR',A.wtdIRR,B.wtdIRR,'%',2);
  h+=sub('Risk — 2026-issue, stochastic');
  h+=rowRaw('Downside vs plan (CTE-90)',A.risk,B.risk,'$',1);
  h+=rowRaw('Worst drawdown',A.ddWorst,B.ddWorst,'$',1);
  h+=rowRaw('Std dev of PVDE',A.riskSD,B.riskSD,'$',1);
  h+=rowRaw('CTE-90 avg PVDE',A.cte90,B.cte90,'$',1);
  h+=rowRaw('P10 IRR',A.p10,B.p10,'%',2);
  h+=rowRaw('P90 IRR',A.p90,B.p90,'%',2);
  h+=sub('Capital / RBC');
  h+=rowRaw('Min RBC 2026–30',A.minRBC,B.minRBC,'x');
  [2026,2027,2028,2029,2030].forEach(function(y){h+=rowRaw('RBC '+y,A.rbc[y],B.rbc[y],'x');});
  h+=rowRaw('Min ΔTAC / BOP',A.minTacChg,B.minTacChg,'%',1);
  h+=sub('Distributable earnings — 2026 issue');
  h+=rowRaw('Year-1 (2026) DE',A.de1,B.de1,'$',1);
  h+=rowRaw('Deepest cumulative DE',A.cumMin,B.cumMin,'$',1);
  h+=txt('First DE &gt; 0',A.dePos||'—',B.dePos||'—');
  h+=txt('First cumDE &gt; 0',A.cumPos||'—',B.cumPos||'—');
  h+=sub('Status');
  h+=txt('Feasible',stat(A.feasible),stat(B.feasible));
  h+=txt('On efficient frontier',stat(A.isFrontier),stat(B.isFrontier));
  h+=txt('Failed constraints',fails(A.failCodes),fails(B.failCodes));
  h+='</tbody></table></div>';
  el.innerHTML=h;
}

/* ---- selectors / file loading ---- */
function populateSelectors(){
  var opts='<option value="base">Baseline</option>'+S.results.map(function(r){return'<option value="'+r.id+'">'+(r.isCustom?'★ Custom':'#'+r.id)+' MS'+fmt(r.sales.MS,0)+'/PN'+fmt(r.sales.PN,0)+'/HI'+fmt(r.sales.HI,1)+(r.isFrontier?' ⬤':r.feasible?'':'✗')+'</option>';}).join('');
  ['vnbScenSel','rbcScenSel','dbgScenSel','evScenSel'].forEach(function(id){var el=document.getElementById(id);if(el)el.innerHTML=opts;});
  // Compare-tab dropdowns: same option set; default A=first result, B=second (fallback baseline).
  ['cmpSelA','cmpSelB'].forEach(function(id){var el=document.getElementById(id);if(el)el.innerHTML=opts;});
  var ids=S.results.map(function(r){return String(r.id);});
  if(S.cmp.a!=='base'&&ids.indexOf(String(S.cmp.a))<0)S.cmp.a=ids[0]||'base';
  if(S.cmp.b!=='base'&&ids.indexOf(String(S.cmp.b))<0)S.cmp.b=ids[1]||ids[0]||'base';
  if(S.cmp.a==='base'&&S.cmp.b==='base'&&ids.length){S.cmp.a=ids[0];S.cmp.b=ids[1]||ids[0];}
  var ea=document.getElementById('cmpSelA');if(ea)ea.value=String(S.cmp.a);
  var eb=document.getElementById('cmpSelB');if(eb)eb.value=String(S.cmp.b);
  var act=document.querySelector('.tab.active');if(act&&act.id==='tab-compare')renderCompare();
  // Reset shared selection to baseline after a fresh run, then sync all dropdowns
  if(!S.results.find(function(r){return String(r.id)===String(S.sel.scen);}))S.sel={scen:'base',sens:'det'};
  pushSelectionToDropdowns();
}
function fileLoad(id,key){document.getElementById(id).addEventListener('change',function(e){var f=e.target.files[0];if(!f)return;var r=new FileReader();r.onload=function(){try{if(key==='ev'){S.ev=EFENG.loadEV(r.result);document.getElementById('srcEV').textContent=f.name+' ('+S.ev.rows.length+' rows)';}if(key==='ts'){S.ts=EFENG.loadTS(r.result);document.getElementById('srcTS').textContent=f.name;}if(key==='surplus'){S.surplus=EFENG.loadSurplus(r.result);document.getElementById('srcSurp').textContent=f.name;}computeBaseline();}catch(err){alert('Parse error: '+err.message);}};r.readAsText(f);});}

/* ---- tab wiring ---- */
function showTab(t){
  document.querySelectorAll('#nav button').forEach(function(b){b.classList.toggle('active',b.dataset.tab===t);});
  document.querySelectorAll('.tab').forEach(function(s){s.classList.toggle('active',s.id==='tab-'+t);});
  if(t==='frontier'){renderStats();drawChart();renderScenTable();}
  if(t==='compare')renderCompare();
  if(t==='vnb')renderVNB();
  if(t==='rbc')renderRBC();
  if(t==='evidence')renderEvidence();
  if(t==='debug')renderDebug();
}
function bindAll(){
document.getElementById('nav').addEventListener('click',function(e){if(e.target.tagName==='BUTTON'&&e.target.dataset.tab)showTab(e.target.dataset.tab);});
// Screen Wake Locks are auto-released when the page is hidden; re-acquire on return if a run is still going.
document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible'&&S._running&&!S._wakeLock)acquireWakeLock();});
document.getElementById('runBtn').addEventListener('click',function(){readInputs();computeBaseline();runFrontier();});
(function(){
  refreshCsSalesUI();
  var t=document.getElementById('csTestBtn');if(t)t.addEventListener('click',testCustomScenario);
  var c=document.getElementById('csClearBtn');if(c)c.addEventListener('click',clearCustomScenario);
  var rs=document.getElementById('randSeedBtn');if(rs)rs.addEventListener('click',function(){
    var s=Math.floor(Math.random()*2147483647)+1;var el=document.getElementById('seedInput');if(el)el.value=s;S.seed=s;
  });
})();
// Tab: segment buttons
['vnbProdSeg','vnbBasisSeg'].forEach(function(id){var el=document.getElementById(id);if(el)el.addEventListener('click',function(e){if(e.target.tagName!=='BUTTON')return;e.target.parentElement.querySelectorAll('button').forEach(function(b){b.classList.remove('active');});e.target.classList.add('active');var d=e.target.dataset;if(d.p)S.vnbProd=d.p;if(d.b)S.vnbBasis=d.b;renderVNB();});});
(function(){
  // All scenario dropdowns update the SHARED selection (persists across tabs)
  ['vnbScenSel','rbcScenSel','evScenSel','dbgScenSel'].forEach(function(id){
    var el=document.getElementById(id);
    if(el)el.addEventListener('change',function(){setSelection(el.value,undefined);});
  });
  // All sensitivity dropdowns update the SHARED sensitivity
  ['vnbSensSel','rbcSensSel','evSensSel','dbgSensSel'].forEach(function(id){
    var el=document.getElementById(id);
    if(el)el.addEventListener('change',function(){setSelection(undefined,el.value);});
  });
})();
(function(){var el=document.getElementById('rbcBasisSeg');if(el)el.addEventListener('click',function(e){if(e.target.tagName!=='BUTTON')return;e.target.parentElement.querySelectorAll('button').forEach(function(b){b.classList.remove('active');});e.target.classList.add('active');S.rbcBasis=e.target.dataset.b;renderRBC();});})();

(function(){
  ['sn_on','sn_amount','sn_tenor','sn_rate','sn_fees','sn_start'].forEach(function(id){
    var el=document.getElementById(id);
    if(el)el.addEventListener('change',function(){readSurplusNote();computeBaseline();updateConsSummary();});
  });
})();



(function(){
  // Compare-tab dropdowns drive the side-by-side view.
  ['cmpSelA','cmpSelB'].forEach(function(id){var el=document.getElementById(id);if(el)el.addEventListener('change',function(){if(id==='cmpSelA')S.cmp.a=el.value;else S.cmp.b=el.value;renderCompare();});});
})();
(function(){var el=document.getElementById('dbgRefresh');if(el)el.addEventListener('click',renderDebug);})();
document.querySelectorAll('#tab-config input,#tab-config select').forEach(function(el){if(el.id&&el.id.startsWith('c_'))el.addEventListener('change',updateConsSummary);});
fileLoad('fEV','ev');fileLoad('fTS','ts');fileLoad('fSurp','surplus');
window.downloadEVTemplate=downloadEVTemplate;
window.downloadTSTemplate=downloadTSTemplate;
window.downloadSurplusTemplate=downloadSurplusTemplate;
window.downloadScenCSV=downloadScenCSV;
window.exportScalars=exportScalars;
window.updateChart=updateChart;
window.resetAxisLimits=resetAxisLimits;
window.renderScenTable=renderScenTable;
window.renderDebug=renderDebug;
window.computeShadowPrices=computeShadowPrices;
window.testRobustness=testRobustness;
}
document.addEventListener('DOMContentLoaded',function(){
  bindAll();
  init().catch(function(e){var el=document.getElementById('hdrMeta');if(el)el.textContent='init error: '+e.message;console.error(e);});
});
})();
