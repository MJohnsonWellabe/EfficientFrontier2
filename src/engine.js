// engine.js — assembles the decomposed engine modules into a single EFENG namespace
// for Node (runner/, validate). The browser viewer loads vnb.js, ev-recalc.js and
// rbc-surplus.js as separate <script> tags, which populate window.EFENG identically.
'use strict';
var vnb = require('./vnb.js');
var evRecalc = require('./ev-recalc.js');
var rbcSurplus = require('./rbc-surplus.js');
var EFENG = {};
[vnb, evRecalc, rbcSurplus].forEach(function (m) { for (var k in m) EFENG[k] = m[k]; });
module.exports = EFENG;
