/* =========================================================================
 * kpis.js — a library of marketing KPIs derived from the MMM state.
 *
 * Each KPI is a small, self-contained definition:
 *   id       unique slug (stored in saved state)
 *   name     card label
 *   cat      category, for grouping in the picker
 *   desc     one-line explanation shown in the library
 *   heavy    true if it needs the optimiser (computed on a debounce)
 *   compute  (ctx) -> number | null      (null renders as "—")
 *   fmt      (v, ctx) -> string          display value
 *   sub      (v, ctx) -> string          small caption under the value
 *   tone     (v, ctx) -> "pos"|"neg"|"warn"|""   accent colour
 *
 * ctx is built once per render in app.js and carries everything below.
 * Adding a new KPI is literally one entry in this array.
 * ========================================================================= */
(function (global) {
  "use strict";

  const eur = function (v) { return "€" + Math.round(v).toLocaleString() + "k"; };
  const x2 = function (v) { return v.toFixed(2) + "×"; };
  const pc = function (v) { return Math.round(v) + "%"; };

  const LIB = [
    /* ---------------- Efficiency ---------------- */
    {
      id: "mroas", name: "Marginal ROAS", cat: "Efficiency", heavy: false,
      desc: "Incremental revenue from the last euro spent, spend-weighted across channels. Below 1× means the next euro loses money.",
      compute: function (c) { return c.totSpend > 0 ? c.spendWMarg : null; },
      fmt: x2, sub: function () { return "return on the last euro spent"; },
      tone: function (v) { return v >= 1 ? "pos" : "neg"; }
    },
    {
      id: "cpir", name: "Cost / incremental €", cat: "Efficiency", heavy: false,
      desc: "Euros of spend needed to generate one euro of media-driven revenue — the inverse of blended ROAS.",
      compute: function (c) { return c.media > 0 ? c.totSpend / c.media : null; },
      fmt: function (v) { return "€" + v.toFixed(2); }, sub: function () { return "spend per €1 of media revenue"; },
      tone: function (v) { return v <= 1 ? "pos" : "warn"; }
    },
    {
      id: "media_pct", name: "Media share of revenue", cat: "Efficiency", heavy: false,
      desc: "Percentage of total predicted revenue that is driven by paid media rather than baseline.",
      compute: function (c) { return c.pct; }, fmt: pc,
      sub: function () { return "vs organic baseline"; }, tone: function () { return ""; }
    },

    /* ---------------- Saturation ---------------- */
    {
      id: "ceiling_util", name: "Ceiling utilisation", cat: "Saturation", heavy: false,
      desc: "How much of the model's total response ceiling (Σβ) you are currently capturing. High values mean little room left.",
      compute: function (c) { return c.sumBeta > 0 ? (100 * c.media) / c.sumBeta : null; },
      fmt: pc, sub: function () { return "of total response ceiling"; },
      tone: function (v) { return v > 85 ? "warn" : ""; }
    },
    {
      id: "headroom", name: "Untapped capacity", cat: "Saturation", heavy: false,
      desc: "Remaining response still available before every channel hits its ceiling (Σβ − current media revenue).",
      compute: function (c) { return Math.max(0, c.sumBeta - c.media); },
      fmt: eur, sub: function () { return "response left on the table"; }, tone: function () { return ""; }
    },
    {
      id: "avg_sat", name: "Avg channel saturation", cat: "Saturation", heavy: false,
      desc: "Average of each channel's spend relative to its half-saturation point — how far up the S-curve you are operating.",
      compute: function (c) {
        let s = 0, k = 0;
        c.rows.forEach(function (r) { s += r.spend / (r.spend + r.gamma); k++; });
        return k ? (100 * s) / k : null;
      },
      fmt: pc, sub: function () { return "position on the response curve"; },
      tone: function (v) { return v > 70 ? "warn" : ""; }
    },

    /* ---------------- Allocation ---------------- */
    {
      id: "hhi", name: "Spend concentration", cat: "Allocation", heavy: false,
      desc: "Herfindahl index of the spend split (0 = perfectly spread, 1 = all in one channel). High values flag fragility.",
      compute: function (c) { let h = 0; c.rows.forEach(function (r) { h += r.sShare * r.sShare; }); return h; },
      fmt: function (v) { return v.toFixed(2); }, sub: function () { return "HHI · 0 spread → 1 concentrated"; },
      tone: function (v) { return v > 0.4 ? "warn" : ""; }
    },
    {
      id: "eff_channels", name: "Effective channels", cat: "Allocation", heavy: false,
      desc: "The diversification of your spend expressed as an equivalent number of equally-funded channels (1 / HHI).",
      compute: function (c) { let h = 0; c.rows.forEach(function (r) { h += r.sShare * r.sShare; }); return h > 0 ? 1 / h : null; },
      fmt: function (v) { return v.toFixed(1); }, sub: function (v, c) { return "of " + c.n + " funded"; },
      tone: function () { return ""; }
    },
    {
      id: "misalloc", name: "Allocation gap", cat: "Allocation", heavy: false,
      desc: "Mismatch between where the money goes and where the revenue comes from — half the total gap between spend share and contribution share.",
      compute: function (c) {
        let g = 0; c.rows.forEach(function (r) { g += Math.abs(r.sShare - r.cShare); }); return 50 * g;
      },
      fmt: pc, sub: function () { return "spend vs contribution mismatch"; },
      tone: function (v) { return v > 15 ? "warn" : "pos"; }
    },
    {
      id: "top_share", name: "Top channel share", cat: "Allocation", heavy: false,
      desc: "Share of total spend concentrated in your single largest channel.",
      compute: function (c) { let m = 0; c.rows.forEach(function (r) { m = Math.max(m, r.sShare); }); return 100 * m; },
      fmt: pc, sub: function (v, c) { return "in " + c.topChannel; }, tone: function (v) { return v > 50 ? "warn" : ""; }
    },

    /* ---------------- Growth ---------------- */
    {
      id: "best_marg", name: "Best marginal channel", cat: "Growth", heavy: false,
      desc: "The highest marginal return available right now — where your next euro is best spent.",
      compute: function (c) { return c.bestMarg; }, fmt: x2,
      sub: function (v, c) { return "next € → " + c.bestMargName; }, tone: function () { return "pos"; }
    },
    {
      id: "opt_uplift", name: "Reallocation upside", cat: "Growth", heavy: true,
      desc: "Revenue gain available by reallocating today's total budget optimally across channels, without spending a euro more.",
      compute: function (c) { return c.optRevenue != null && c.media > 0 ? (100 * (c.optRevenue - c.media)) / c.media : null; },
      fmt: function (v) { return (v >= 0 ? "+" : "") + Math.round(v) + "%"; },
      sub: function () { return "from optimal reallocation"; }, tone: function (v) { return v > 0.5 ? "pos" : ""; }
    },
    {
      id: "breakeven_budget", name: "Breakeven budget", cat: "Growth", heavy: true,
      desc: "Total budget at which the optimal marginal euro falls to €1. Spending beyond this destroys value at current efficiencies.",
      compute: function (c) { return c.breakeven != null ? c.breakeven : null; },
      fmt: function (v) { return eur(v); }, sub: function () { return "marginal € hits €1 here"; }, tone: function () { return ""; }
    },
    {
      id: "room_to_breakeven", name: "Room to breakeven", cat: "Growth", heavy: true,
      desc: "How much you could still scale total spend before the optimal marginal euro drops below €1.",
      compute: function (c) { return c.breakeven != null ? c.breakeven - c.totSpend : null; },
      fmt: function (v) { return (v >= 0 ? "+" : "") + eur(v); },
      sub: function () { return "scale-up headroom"; }, tone: function (v) { return v >= 0 ? "pos" : "neg"; }
    },

    /* ---------------- Risk ---------------- */
    {
      id: "baseline_dep", name: "Baseline dependency", cat: "Risk", heavy: false,
      desc: "Share of revenue that is organic and independent of media. Very high values mean media has little leverage.",
      compute: function (c) { return c.revenue > 0 ? (100 * c.baseline) / c.revenue : null; },
      fmt: pc, sub: function () { return "revenue not driven by media"; }, tone: function (v) { return v > 75 ? "warn" : ""; }
    },
    {
      id: "overspend", name: "Sub-breakeven spend", cat: "Risk", heavy: false,
      desc: "Total weekly spend sitting on channels whose marginal return is already below €1 — money working against you.",
      compute: function (c) { let s = 0; c.rows.forEach(function (r) { if (r.marg < 1) s += r.spend; }); return s; },
      fmt: eur, sub: function () { return "spend below €1 marginal"; }, tone: function (v) { return v > 0 ? "warn" : "pos"; }
    },
    {
      id: "overspend_count", name: "Over-invested channels", cat: "Risk", heavy: false,
      desc: "Number of channels currently spending past their €1 marginal-return point.",
      compute: function (c) { let n = 0; c.rows.forEach(function (r) { if (r.marg < 1) n++; }); return n; },
      fmt: function (v) { return String(v); }, sub: function (v, c) { return "of " + c.n + " channels"; },
      tone: function (v) { return v > 0 ? "warn" : "pos"; }
    }
  ];

  global.KPI_LIBRARY = LIB;
  global.KPI_BY_ID = LIB.reduce(function (o, k) { o[k.id] = k; return o; }, {});
})(window);
