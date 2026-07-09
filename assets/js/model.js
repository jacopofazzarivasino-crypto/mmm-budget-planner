/* =========================================================================
 * model.js — Media Mix Model maths, ported to the browser.
 * Pure functions, no DOM. Exposed on window.MMM.
 *
 * Steady-state planning view: with spend held constant, the normalised
 * geometric adstock settles to the spend level, so a channel's contribution
 * is just the Hill response of its weekly spend.
 * ========================================================================= */
(function (global) {
  "use strict";

  // Hill saturation response: beta * s^a / (gamma^a + s^a)
  function hill(s, p) {
    s = Math.max(+s, 1e-9);
    const sa = Math.pow(s, p.alpha);
    return (p.beta * sa) / (Math.pow(p.gamma, p.alpha) + sa);
  }

  // Marginal return d(contribution)/d(spend), forward difference.
  function marginal(s, p, eps) {
    eps = eps || 1e-3;
    return (hill(s + eps, p) - hill(s, p)) / eps;
  }

  function totalContrib(alloc, params) {
    let t = 0;
    for (let i = 0; i < alloc.length; i++) t += hill(alloc[i], params[i]);
    return t;
  }

  // Euclidean projection onto { x >= 0, sum(x) = B }  (Duchi et al. 2008)
  function projSimplex(v, B) {
    const n = v.length;
    const u = v.slice().sort(function (a, b) { return b - a; });
    let css = 0, theta = 0;
    for (let j = 0; j < n; j++) {
      css += u[j];
      const t = (css - B) / (j + 1);
      if (u[j] - t > 0) theta = t;
    }
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.max(v[i] - theta, 0);
    return out;
  }

  /* Deterministic PRNG (mulberry32). The optimiser's random restarts must be
   * reproducible: identical inputs -> identical allocation, marginal returns
   * and breakeven, run after run. This aligns the JS edition with the Python
   * edition, which already fixes seed=0 in its random generator. */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Dirichlet(1,..,1) sample via normalised exponentials — uniform on simplex.
  function dirichlet(n, rand) {
    const g = new Array(n);
    let s = 0;
    for (let i = 0; i < n; i++) { const x = -Math.log(1 - rand()); g[i] = x; s += x; }
    for (let i = 0; i < n; i++) g[i] /= s;
    return g;
  }

  /* Maximise total Hill contribution s.t. total spend == budget.
   * Monotone-safe multi-start projected-gradient ascent. The Hill response is
   * non-concave for alpha > 1, so a single start hits local optima. */
  function optimise(params, budget, opts) {
    opts = opts || {};
    const restarts = opts.restarts || 60;
    const iters = opts.iters || 300;
    const current = opts.current || null;
    const rand = mulberry32(opts.seed != null ? opts.seed : 0);
    const n = params.length;
    if (budget <= 0) return new Array(n).fill(0);

    let best = null, bestv = -Infinity;
    function keep(s) {
      const v = totalContrib(s, params);
      if (v > bestv) { bestv = v; best = s.slice(); }
    }

    const starts = [];
    if (current) {
      const sum = current.reduce(function (a, b) { return a + b; }, 0) || 1;
      starts.push(current.map(function (x) { return (x * budget) / sum; }));
    }
    starts.push(new Array(n).fill(budget / n));
    for (let i = 0; i < n; i++) { const a = new Array(n).fill(0); a[i] = budget; starts.push(a); }
    while (starts.length < restarts) starts.push(dirichlet(n, rand).map(function (x) { return x * budget; }));

    for (let si = 0; si < starts.length; si++) {
      let s = projSimplex(starts[si], budget);
      keep(s);
      let eta = Math.max(budget, 40) / 8;
      for (let it = 0; it < iters; it++) {
        const grad = new Array(n);
        for (let i = 0; i < n; i++) grad[i] = marginal(s[i], params[i]);
        const step = new Array(n);
        for (let i = 0; i < n; i++) step[i] = s[i] + eta * grad[i];
        s = projSimplex(step, budget);
        keep(s);
        if (it % 80 === 79) eta *= 0.5;
      }
    }
    return best;
  }

  /* Optimal incremental revenue and worst-case marginal return across a sweep
   * of total budgets, plus the breakeven budget where marginal euro hits 1.
   * opts.maxBudget extends the sweep so the current operating point always
   * sits inside the plotted domain. */
  function computeScenario(params, opts) {
    opts = opts || {};
    const restarts = opts.restarts || 14;
    const iters = opts.iters || 110;
    const maxB = Math.max(240, +opts.maxBudget || 0);
    const step = Math.max(15, Math.ceil(maxB / 16 / 15) * 15);
    const budgets = [];
    for (let B = step; B <= maxB + 1e-9; B += step) budgets.push(B);

    const rev = [], marg = [];
    for (let k = 0; k < budgets.length; k++) {
      const a = optimise(params, budgets[k], { restarts: restarts, iters: iters });
      rev.push(totalContrib(a, params));
      let m = -Infinity;
      for (let i = 0; i < params.length; i++) m = Math.max(m, marginal(a[i], params[i]));
      marg.push(m);
    }

    /* Breakeven search at a FIXED 15 €k resolution, independent of how wide
     * the chart domain is. The coarse pass may use the (possibly larger)
     * chart step for speed, but the crossing is then refined back to 15 €k
     * so the reported breakeven never gets coarser as the range grows. */
    const RES = 15;
    function worstMarg(B) {
      const a = optimise(params, B, { restarts: restarts, iters: iters });
      let m = -Infinity;
      for (let i = 0; i < params.length; i++) m = Math.max(m, marginal(a[i], params[i]));
      return m;
    }
    let breakeven = null;
    const sweepEnd = Math.max(420, Math.round(maxB * 1.75));
    for (let B = step; B <= sweepEnd; B += step) {
      if (worstMarg(B) < 1.0) {
        breakeven = B;
        for (let Bf = B - step + RES; Bf < B; Bf += RES) {   // refine within the coarse cell
          if (worstMarg(Bf) < 1.0) { breakeven = Bf; break; }
        }
        break;
      }
    }
    return { budgets: budgets, rev: rev, marg: marg, breakeven: breakeven };
  }

  global.MMM = {
    hill: hill,
    marginal: marginal,
    totalContrib: totalContrib,
    projSimplex: projSimplex,
    optimise: optimise,
    computeScenario: computeScenario
  };
})(window);
