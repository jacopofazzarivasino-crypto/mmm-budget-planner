/* =========================================================================
 * app.js — state, rendering and interaction for the MMM Budget Planner.
 * ========================================================================= */
(function () {
  "use strict";
  const M = window.MMM, C = window.Charts;

  const DEFAULTS = [
    { key: "tv",      name: "TV",           color: "#4C7EF3", beta: 320, gamma: 60, alpha: 1.5, theta: 0.65, spend: 50.0 },
    { key: "search",  name: "Paid Search",  color: "#17A08C", beta: 140, gamma: 10, alpha: 1.0, theta: 0.05, spend: 14.0 },
    { key: "social",  name: "Paid Social",  color: "#7C5CE6", beta: 200, gamma: 30, alpha: 1.3, theta: 0.30, spend: 27.0 },
    { key: "video",   name: "Online Video", color: "#CC7433", beta: 170, gamma: 38, alpha: 1.4, theta: 0.45, spend: 21.0 },
    { key: "display", name: "Display",      color: "#2E9BC4", beta: 90,  gamma: 22, alpha: 1.1, theta: 0.20, spend: 9.0 }
  ];
  const DEFAULT_BASELINE = 300.0;
  const SLIDER_MAX = 250.0;
  const LS_KEY = "mmm-planner-v2";

  // ---- state -----------------------------------------------------------
  let state = loadState();

  function freshState() {
    return {
      channels: DEFAULTS.map(function (d) {
        return { key: d.key, name: d.name, color: d.color, beta: d.beta, gamma: d.gamma, alpha: d.alpha, theta: d.theta };
      }),
      spends: DEFAULTS.reduce(function (o, d) { o[d.key] = d.spend; return o; }, {}),
      baseline: DEFAULT_BASELINE,
      optBudget: Math.round(DEFAULTS.reduce(function (a, d) { return a + d.spend; }, 0)),
      customKpis: ["mroas", "opt_uplift", "headroom", "misalloc"],
      customMetrics: []
    };
  }
  function loadState() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return freshState();
      const s = JSON.parse(raw);
      if (!s.channels || !s.channels.length) return freshState();
      if (!Array.isArray(s.customKpis)) s.customKpis = freshState().customKpis;
      if (!Array.isArray(s.customMetrics)) s.customMetrics = [];
      // migrate the old saturated palette to the refined one (by channel key),
      // leaving any user-customised colors untouched
      const OLD = { "#6C8CFF": 1, "#34D6A0": 1, "#B98AF0": 1, "#F0B84A": 1, "#4FCBD6": 1,
                    "#2BB47E": 1, "#A86BD0": 1, "#C99A2E": 1, "#3FA9B0": 1,
                    "#5E8EE6": 1, "#2FBBA0": 1, "#9D8BF2": 1, "#E0925E": 1, "#58C0DA": 1 };
      s.channels.forEach(function (c) {
        if (c.color && OLD[c.color.toUpperCase()]) {
          const d = DEFAULTS.find(function (x) { return x.key === c.key; });
          if (d) c.color = d.color;
        }
      });
      return s;
    } catch (e) { return freshState(); }
  }
  function saveState() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) {}
  }

  // ---- dom refs --------------------------------------------------------
  const $ = function (sel) { return document.querySelector(sel); };
  const curvesHost = $("#curves");
  const slidersHost = $("#sliders");
  const tableHost = $("#contribTable");
  const paramRows = $("#paramRows");

  const curves = new C.ResponseCurves(curvesHost, { onDrag: onCurveDrag });
  const revChart = new C.ScenarioChart($("#revChart"), { tooltip: $("#revTip"), vbW: 960, vbH: 330 });
  const margChart = new C.ScenarioChart($("#margChart"), { tooltip: $("#margTip"), vbW: 960, vbH: 330 });

  let scenarioData = null;
  let scenarioTimer = null;

  // heavy KPI context (needs the optimiser) — refreshed on a debounce
  let heavyCtx = { optRevenue: null, breakeven: null };
  let heavyTimer = null;

  // ---- compute ---------------------------------------------------------
  function computeRows() {
    const rows = [];
    state.channels.forEach(function (c) {
      const s = +state.spends[c.key] || 0;
      const y = M.hill(s, c);
      rows.push({
        key: c.key, name: c.name, color: c.color, spend: s,
        contrib: y, roas: s > 0 ? y / s : 0, marg: M.marginal(s, c)
      });
    });
    return rows;
  }

  // ---- KPI animated counters ------------------------------------------
  const kpiCur = { revenue: 0, media: 0, baseline: 0, roas: 0 };
  function writeKPI() {
    $("#kpiRevenue").textContent = "€" + Math.round(kpiCur.revenue).toLocaleString() + "k";
    $("#kpiMedia").textContent = "€" + Math.round(kpiCur.media).toLocaleString() + "k";
    $("#kpiBaseline").textContent = "€" + Math.round(kpiCur.baseline).toLocaleString() + "k";
    $("#kpiRoas").textContent = kpiCur.roas.toFixed(2) + "×";
  }
  function kickKPI() {
    // When the tab is hidden, rAF is paused — snap synchronously so the page is
    // never stuck showing zeros if it loaded in a background tab.
    if (document.hidden) {
      const t = window._kpiTargets;
      for (const k in t) kpiCur[k] = t[k];
      writeKPI();
    } else {
      requestAnimationFrame(animateKPI);
    }
  }
  function animateKPI() {
    const targets = window._kpiTargets;
    let alive = false;
    for (const k in targets) {
      const d = targets[k] - kpiCur[k];
      if (Math.abs(d) > 0.01) { kpiCur[k] += d * 0.22; alive = true; }
      else kpiCur[k] = targets[k];
    }
    writeKPI();
    if (alive) requestAnimationFrame(animateKPI);
  }

  // ---- render light (spend changed) -----------------------------------
  function renderLight() {
    const rows = computeRows();
    const media = rows.reduce(function (a, r) { return a + r.contrib; }, 0);
    const totSpend = rows.reduce(function (a, r) { return a + r.spend; }, 0);
    const baseline = +state.baseline || 0;
    const revenue = baseline + media;
    const roas = totSpend ? media / totSpend : 0;
    const pct = revenue ? (100 * media) / revenue : 0;

    window._kpiTargets = { revenue: revenue, media: media, baseline: baseline, roas: roas };
    kickKPI();
    $("#kpiMediaSub").textContent = Math.round(pct) + "% of revenue";
    $("#kpiRoasSub").textContent = "€" + Math.round(totSpend).toLocaleString() + "k total spend";

    // curve points
    rows.forEach(function (r) { curves.setPoint(r.key, r.spend, r.contrib, r.roas, r.marg); });

    // table
    renderTable(rows, media);

    // scenario marker — re-sweep if spend moved past the plotted domain
    if (scenarioData) {
      if (scenarioData.maxBudget && totSpend > scenarioData.maxBudget) scheduleScenario();
      revChart.setMarker(totSpend, media);
      margChart.setMarker(totSpend, null);
    }

    // collapsed-chart summary chips
    const revSum = $("#revSum");
    if (revSum) revSum.textContent = "now: €" + Math.round(totSpend) + "k spend → €" + Math.round(media) + "k media revenue";
    const margSum = $("#margSum");
    if (margSum) {
      const best = rows.reduce(function (a, r) { return Math.max(a, r.marg); }, 0);
      margSum.textContent = "best next euro returns €" + best.toFixed(2);
    }

    // custom analytics (light KPIs instantly; heavy ones on a debounce)
    renderCustomKpis();
    scheduleHeavy();
    saveState();
  }

  function renderTable(rows, media) {
    const maxc = Math.max.apply(null, rows.map(function (r) { return r.contrib; })) || 1;
    let html = "";
    rows.forEach(function (r) {
      const share = media ? (r.contrib / media) * 100 : 0;
      const cls = r.marg >= 1 ? "pos" : "neg";
      html +=
        '<tr><td class="ch"><span class="dot" style="background:' + r.color + '"></span>' + r.name + "</td>" +
        "<td>" + r.spend.toFixed(1) + "</td>" +
        "<td>" + r.contrib.toFixed(1) + "</td>" +
        "<td>" + r.roas.toFixed(2) + "×</td>" +
        '<td class="' + cls + '">' + r.marg.toFixed(2) + "</td>" +
        '<td><span class="bartrack"><span class="barfill" style="width:' +
        Math.max(4, (100 * r.contrib) / maxc).toFixed(0) + "%;background:" + r.color + '"></span></span>' +
        '<span class="sharepct">' + share.toFixed(0) + "%</span></td></tr>";
    });
    tableHost.innerHTML =
      "<thead><tr><th>Channel</th><th>Spend €k</th><th>Contribution €k</th><th>ROAS</th>" +
      "<th>Marg €/€</th><th>Share of media</th></tr></thead><tbody>" + html + "</tbody>";
  }

  // ---- custom KPI library ---------------------------------------------
  // Build the context every KPI computes against.
  function buildCtx() {
    const rows = computeRows();
    const media = rows.reduce(function (a, r) { return a + r.contrib; }, 0);
    const totSpend = rows.reduce(function (a, r) { return a + r.spend; }, 0);
    const baseline = +state.baseline || 0;
    const revenue = baseline + media;
    let sumBeta = 0, spendWMarg = 0, bestMarg = -Infinity, bestMargName = "—", topShare = -1, topChannel = "—";
    state.channels.forEach(function (c) { sumBeta += +c.beta; });
    rows.forEach(function (r) {
      const cfg = state.channels.find(function (c) { return c.key === r.key; }) || {};
      r.sShare = totSpend ? r.spend / totSpend : 0;
      r.cShare = media ? r.contrib / media : 0;
      r.beta = +cfg.beta; r.gamma = +cfg.gamma || 1; r.alpha = +cfg.alpha; r.theta = +cfg.theta;
      r.share = r.sShare; r.cshare = r.cShare; r.revenue = r.contrib;
      r.saturation = r.spend / (r.spend + (r.gamma || 1));
      spendWMarg += r.marg * (r.sShare);
      if (r.marg > bestMarg) { bestMarg = r.marg; bestMargName = r.name; }
      if (r.sShare > topShare) { topShare = r.sShare; topChannel = r.name; }
    });
    return {
      rows: rows, n: rows.length, media: media, totSpend: totSpend, baseline: baseline,
      revenue: revenue, roas: totSpend ? media / totSpend : 0, pct: revenue ? (100 * media) / revenue : 0,
      sumBeta: sumBeta, spendWMarg: totSpend ? spendWMarg : 0,
      bestMarg: bestMarg === -Infinity ? 0 : bestMarg, bestMargName: bestMargName,
      topChannel: topChannel,
      optRevenue: heavyCtx.optRevenue, breakeven: heavyCtx.breakeven
    };
  }

  // ---- user-defined formula metrics -----------------------------------
  let userKpis = {};

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fmtUnit(v, unit, dec) {
    v = +v;
    if (unit === "€k") { const d = dec == null ? 0 : dec; return "€" + v.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }) + "k"; }
    if (unit === "%") { const d = dec == null ? 0 : dec; return v.toFixed(d) + "%"; }
    if (unit === "×") { const d = dec == null ? 2 : dec; return v.toFixed(d) + "×"; }
    const d = dec == null ? 2 : dec;
    return v.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
  }

  // Non-strict Function so `with` is allowed — lets users write bare variable
  // names (media, roas, tv.spend, sum('spend')) instead of scope.media etc.
  function compileFormula(formula) {
    return new Function("s", "with (s) { return (" + formula + "); }");
  }

  // The variable scope every user formula is evaluated against.
  function buildScope(ctx) {
    const rows = ctx.rows;
    function sel(s) { return typeof s === "function" ? s : function (c) { return c[s]; }; }
    function num(x) { x = +x; return isFinite(x) ? x : 0; }
    const scope = {
      media: ctx.media, totSpend: ctx.totSpend, spend: ctx.totSpend, baseline: ctx.baseline,
      revenue: ctx.revenue, roas: ctx.roas, mediaPct: ctx.pct, pct: ctx.pct,
      sumBeta: ctx.sumBeta, headroom: Math.max(0, ctx.sumBeta - ctx.media),
      bestMarg: ctx.bestMarg, breakeven: ctx.breakeven, optRevenue: ctx.optRevenue,
      channels: rows, n: rows.length,
      sum: function (s) { const f = sel(s); return rows.reduce(function (a, c) { return a + num(f(c)); }, 0); },
      avg: function (s) { const f = sel(s); return rows.length ? rows.reduce(function (a, c) { return a + num(f(c)); }, 0) / rows.length : 0; },
      max: function (s) { const f = sel(s); return rows.reduce(function (a, c) { return Math.max(a, num(f(c))); }, -Infinity); },
      min: function (s) { const f = sel(s); return rows.reduce(function (a, c) { return Math.min(a, num(f(c))); }, Infinity); },
      count: function (s) { const f = sel(s); return rows.filter(function (c) { return !!f(c); }).length; }
    };
    rows.forEach(function (r) { if (!(r.key in scope)) scope[r.key] = r; });
    return scope;
  }

  function makeUserKpi(def) {
    const fn = compileFormula(def.formula); // throws on syntax error
    return {
      id: def.id, name: def.name, cat: "Custom", heavy: false, user: true, formula: def.formula,
      desc: def.formula,
      compute: function (ctx) {
        try { const v = fn(buildScope(ctx)); return typeof v === "number" && isFinite(v) ? v : null; }
        catch (e) { return null; }
      },
      fmt: function (v) { return fmtUnit(v, def.unit, def.decimals); },
      sub: function () { return "custom · " + (def.unit || "number"); },
      tone: function () { return ""; }
    };
  }

  function rebuildUserKpis() {
    userKpis = {};
    (state.customMetrics || []).forEach(function (def) {
      try { userKpis[def.id] = makeUserKpi(def); } catch (e) { /* skip invalid */ }
    });
  }
  function getKpi(id) { return window.KPI_BY_ID[id] || userKpis[id]; }

  function renderCustomKpis() {
    const host = $("#customKpis");
    const empty = $("#customEmpty");
    const ids = state.customKpis || [];
    if (!ids.length) { host.innerHTML = ""; empty.hidden = false; return; }
    empty.hidden = true;
    const ctx = buildCtx();
    let html = "";
    ids.forEach(function (id) {
      const k = getKpi(id);
      if (!k) return;
      let v = null, txt = "—", sub = "", tone = "";
      try {
        v = k.compute(ctx);
        if (v == null || (typeof v === "number" && !isFinite(v))) { txt = "—"; sub = k.sub ? k.sub(v, ctx) : ""; }
        else { txt = k.fmt(v, ctx); sub = k.sub ? k.sub(v, ctx) : ""; tone = k.tone ? k.tone(v, ctx) : ""; }
      } catch (e) { txt = "—"; }
      const pending = k.heavy && heavyCtx.optRevenue == null && (id === "opt_uplift");
      html +=
        '<div class="kpi custom kpi--' + (tone || "neutral") + '" data-id="' + id + '">' +
        '<button class="kpi-x" data-remove="' + id + '" title="Remove">×</button>' +
        '<div class="klabel">' + escapeHtml(k.name) + '<span class="kpi-cat">' + k.cat + "</span></div>" +
        '<div class="kval">' + (pending ? "…" : txt) + "</div>" +
        '<div class="ksub">' + sub + "</div></div>";
    });
    host.innerHTML = html;
    host.querySelectorAll("[data-remove]").forEach(function (b) {
      b.addEventListener("click", function () { removeKpi(b.dataset.remove); });
    });
  }

  function addKpi(id) {
    if (state.customKpis.indexOf(id) >= 0) return;
    state.customKpis.push(id);
    renderCustomKpis(); refreshLibState(); saveState();
    const k = getKpi(id);
    if (k && k.heavy) scheduleHeavy();
  }
  function removeKpi(id) {
    state.customKpis = state.customKpis.filter(function (x) { return x !== id; });
    renderCustomKpis(); refreshLibState(); saveState();
  }

  function buildLibrary() {
    const grid = $("#libGrid");
    const all = window.KPI_LIBRARY.concat(Object.keys(userKpis).map(function (k) { return userKpis[k]; }));
    const cats = {};
    const order = [];
    all.forEach(function (k) {
      if (!cats[k.cat]) { cats[k.cat] = []; order.push(k.cat); }
      cats[k.cat].push(k);
    });
    let html = "";
    order.forEach(function (cat) {
      html += '<div class="lib-cat">' + cat + "</div>";
      cats[cat].forEach(function (k) {
        const search = (k.name + " " + k.desc + " " + k.cat).toLowerCase();
        const descHtml = k.user
          ? '<code class="lib-formula">' + escapeHtml(k.formula) + "</code>"
          : escapeHtml(k.desc);
        const tag = k.user ? '<span class="lib-tag user">custom</span>'
          : (k.heavy ? '<span class="lib-tag">optimiser</span>' : "");
        const del = k.user ? '<button class="lib-del" data-del="' + k.id + '" title="Delete metric" aria-label="Delete metric">' +
          '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg></button>' : "";
        html +=
          '<div class="lib-item" data-id="' + k.id + '" data-search="' + escapeHtml(search) + '">' +
          '<div class="lib-item-main"><div class="lib-item-name">' + escapeHtml(k.name) + tag + "</div>" +
          '<div class="lib-item-desc">' + descHtml + "</div></div>" +
          del + '<button class="lib-add" data-add="' + k.id + '"></button></div>';
      });
    });
    grid.innerHTML = html;
    grid.querySelectorAll("[data-add]").forEach(function (b) {
      b.addEventListener("click", function () {
        const id = b.dataset.add;
        if (state.customKpis.indexOf(id) >= 0) removeKpi(id); else addKpi(id);
      });
    });
    grid.querySelectorAll("[data-del]").forEach(function (b) {
      b.addEventListener("click", function () { deleteUserMetric(b.dataset.del); });
    });
    refreshLibState();
  }

  function deleteUserMetric(id) {
    state.customMetrics = state.customMetrics.filter(function (m) { return m.id !== id; });
    state.customKpis = state.customKpis.filter(function (x) { return x !== id; });
    rebuildUserKpis();
    buildLibrary(); renderCustomKpis(); saveState();
  }
  function refreshLibState() {
    $("#libGrid").querySelectorAll(".lib-item").forEach(function (it) {
      const on = state.customKpis.indexOf(it.dataset.id) >= 0;
      it.classList.toggle("added", on);
      const b = it.querySelector(".lib-add");
      b.textContent = on ? "✓ Added" : "＋ Add";
    });
  }

  // ---- formula builder UI ---------------------------------------------
  function decVal() {
    const raw = $("#mDec").value;
    return raw === "" || raw == null ? null : Math.max(0, Math.min(4, parseInt(raw, 10) || 0));
  }
  function previewFormula() {
    const f = $("#mFormula").value.trim();
    const el = $("#mPreview");
    if (!f) { el.textContent = ""; el.className = "builder-preview"; return null; }
    try {
      const fn = compileFormula(f);
      const v = fn(buildScope(buildCtx()));
      if (typeof v !== "number" || !isFinite(v)) { el.textContent = "= not a number"; el.className = "builder-preview err"; return null; }
      el.textContent = "= " + fmtUnit(v, $("#mUnit").value, decVal());
      el.className = "builder-preview ok";
      return v;
    } catch (e) {
      el.textContent = "⚠ " + e.message;
      el.className = "builder-preview err";
      return null;
    }
  }
  function addUserMetric() {
    const name = $("#mName").value.trim();
    const formula = $("#mFormula").value.trim();
    const el = $("#mPreview");
    if (!name) { el.textContent = "⚠ give the metric a name"; el.className = "builder-preview err"; $("#mName").focus(); return; }
    if (!formula) { el.textContent = "⚠ enter a formula"; el.className = "builder-preview err"; $("#mFormula").focus(); return; }
    try {
      const fn = compileFormula(formula);
      const v = fn(buildScope(buildCtx()));
      if (typeof v !== "number" || !isFinite(v)) { el.textContent = "= not a number — check the formula"; el.className = "builder-preview err"; return; }
    } catch (e) { el.textContent = "⚠ " + e.message; el.className = "builder-preview err"; return; }

    const id = "u_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    state.customMetrics.push({ id: id, name: name, formula: formula, unit: $("#mUnit").value, decimals: decVal() });
    if (state.customKpis.indexOf(id) < 0) state.customKpis.push(id);
    rebuildUserKpis(); buildLibrary(); renderCustomKpis(); saveState();

    $("#mName").value = ""; $("#mFormula").value = ""; $("#mDec").value = "";
    el.textContent = "✓ added “" + name + "”"; el.className = "builder-preview ok";
  }
  function renderVarsHelp() {
    const keys = state.channels.map(function (c) { return c.key; }).join(", ");
    $("#mVars").innerHTML =
      '<div class="vars-block"><b>Totals</b> <code>media</code> <code>totSpend</code> <code>baseline</code> ' +
      '<code>revenue</code> <code>roas</code> <code>pct</code> <code>sumBeta</code> <code>headroom</code> ' +
      '<code>bestMarg</code> <code>breakeven</code> <code>optRevenue</code> <code>n</code></div>' +
      '<div class="vars-block"><b>Per channel</b> <code>' + escapeHtml(keys) + '</code> — each has ' +
      '<code>.spend</code> <code>.contrib</code> <code>.roas</code> <code>.marg</code> <code>.beta</code> ' +
      '<code>.gamma</code> <code>.alpha</code> <code>.theta</code> <code>.share</code> <code>.saturation</code></div>' +
      '<div class="vars-block"><b>Helpers</b> <code>sum(c =&gt; c.spend)</code> <code>avg(\'roas\')</code> ' +
      '<code>max(\'marg\')</code> <code>min(\'roas\')</code> <code>count(c =&gt; c.marg &lt; 1)</code> · plus <code>Math.*</code></div>' +
      '<div class="vars-block vars-egs"><b>Examples</b> ' +
      '<code>media / totSpend</code> · <code>100 * tv.contrib / media</code> · ' +
      '<code>sum(c =&gt; c.spend * c.roas) / totSpend</code> · <code>count(c =&gt; c.marg &lt; 1)</code></div>';
  }

  function filterLibrary(q) {
    const grid = $("#libGrid");
    let cat = null, catVisible = 0;
    function flush() { if (cat) cat.style.display = catVisible ? "" : "none"; }
    Array.prototype.forEach.call(grid.children, function (node) {
      if (node.classList.contains("lib-cat")) { flush(); cat = node; catVisible = 0; return; }
      const show = !q || node.dataset.search.indexOf(q) >= 0;
      node.style.display = show ? "" : "none";
      if (show) catVisible++;
    });
    flush();
  }

  // Debounced optimiser-backed context for heavy KPIs.
  function scheduleHeavy() {
    if (heavyTimer) clearTimeout(heavyTimer);
    heavyTimer = setTimeout(computeHeavy, 90);
  }
  function computeHeavy() {
    const rows = computeRows();
    const totSpend = rows.reduce(function (a, r) { return a + r.spend; }, 0);
    const current = state.channels.map(function (c) { return +state.spends[c.key]; });
    const alloc = M.optimise(state.channels, totSpend, { restarts: 18, iters: 120, current: current });
    heavyCtx.optRevenue = M.totalContrib(alloc, state.channels);
    heavyCtx.breakeven = scenarioData ? scenarioData.breakeven : heavyCtx.breakeven;
    renderCustomKpis();
  }

  // ---- render heavy (params changed) ----------------------------------
  function renderCurves() {
    curves.build(state.channels, state.spends);
  }

  function renderScenario() {
    const params = state.channels;
    const rows = computeRows();
    const media = rows.reduce(function (a, r) { return a + r.contrib; }, 0);
    const totSpend = rows.reduce(function (a, r) { return a + r.spend; }, 0);
    // extend the sweep so the current operating point sits inside the domain
    const maxBudget = Math.ceil(Math.max(240, totSpend * 1.25) / 15) * 15;
    scenarioData = M.computeScenario(params, { maxBudget: maxBudget });
    scenarioData.maxBudget = maxBudget;
    heavyCtx.breakeven = scenarioData.breakeven;
    renderCustomKpis();

    revChart.render({
      xs: scenarioData.budgets, ys: scenarioData.rev, color: "#4C7EF3",
      xLabel: "Total budget €k", yFmt: function (v) { return Math.round(v); },
      markerX: totSpend, markerY: media,
      tipFmt: function (x, y) { return "<b>€" + x + "k</b> budget<br>→ €" + Math.round(y) + "k revenue<br><i>click to apply</i>"; },
      onClick: function (B, rev) {
        state.optBudget = Math.round(B);
        $("#optBudget").value = state.optBudget;
        runOptimise();
        if (window.PRO && window.PRO.toast) {
          window.PRO.toast("Applied the optimal split for a €" + Math.round(B) + "k budget → €" + Math.round(rev) + "k media revenue", "ok");
        }
      }
    });
    margChart.render({
      xs: scenarioData.budgets, ys: scenarioData.marg, color: "#17A08C",
      xLabel: "Total budget €k", hline: 1.0, fill: false,
      markerX: totSpend, markerY: null,
      yFmt: function (v) { return v.toFixed(1); },
      tipFmt: function (x, y) { return "<b>€" + x + "k</b><br>→ " + y.toFixed(2) + " €/€"; }
    });

    const cap = $("#scenarioCaption");
    const clickHint = ' <span class="cap-hint">Click any point on the revenue curve to apply that budget optimally.</span>';
    if (scenarioData.breakeven) {
      cap.innerHTML = "Marginal revenue per euro falls to the €1 breakeven near a total budget of <b>€" +
        scenarioData.breakeven + "k</b>. Spending past that destroys value at current efficiencies." + clickHint;
    } else {
      cap.innerHTML = "Marginal revenue per euro stays above €1 across the plotted range." + clickHint;
    }
  }

  function scheduleScenario() {
    if (scenarioTimer) clearTimeout(scenarioTimer);
    $("#scenarioCaption").innerHTML = '<span class="computing">Recomputing the optimal frontier…</span>';
    scenarioTimer = setTimeout(renderScenario, 60);
  }

  // ---- sliders ---------------------------------------------------------
  function buildSliders() {
    slidersHost.innerHTML = "";
    state.channels.forEach(function (c) {
      const wrap = document.createElement("div");
      wrap.className = "slider-row";
      wrap.innerHTML =
        '<div class="slider-top"><label><span class="dot" style="background:' + c.color + '"></span>' +
        c.name + '</label><span class="slider-val" data-val="' + c.key + '"></span></div>' +
        '<input type="range" min="0" max="' + SLIDER_MAX + '" step="0.5" value="' + state.spends[c.key] +
        '" data-key="' + c.key + '" style="--c:' + c.color + '">' +
        '<div class="slider-meta">half-sat €' + (+c.gamma) + "k</div>";
      slidersHost.appendChild(wrap);
      const input = wrap.querySelector("input");
      input.addEventListener("input", function () {
        state.spends[c.key] = parseFloat(input.value);
        updateSliderFill(input);
        $('[data-val="' + c.key + '"]').textContent = "€" + state.spends[c.key].toFixed(1) + "k";
        renderLight();
      });
      updateSliderFill(input);
      $('[data-val="' + c.key + '"]').textContent = "€" + (+state.spends[c.key]).toFixed(1) + "k";
    });
  }
  function updateSliderFill(input) {
    const pct = (input.value / SLIDER_MAX) * 100;
    input.style.background =
      "linear-gradient(90deg, var(--c) " + pct + "%, var(--track) " + pct + "%)";
  }
  function syncSlider(key) {
    const input = slidersHost.querySelector('input[data-key="' + key + '"]');
    if (input) {
      input.value = state.spends[key];
      updateSliderFill(input);
      $('[data-val="' + key + '"]').textContent = "€" + (+state.spends[key]).toFixed(1) + "k";
    }
  }

  function onCurveDrag(key, spend) {
    spend = Math.max(0, Math.min(SLIDER_MAX, spend));
    state.spends[key] = spend;
    syncSlider(key);
    renderLight();
  }

  // ---- optimiser -------------------------------------------------------
  function runOptimise() {
    const params = state.channels;
    const B = parseFloat($("#optBudget").value) || 0;
    const current = params.map(function (c) { return +state.spends[c.key]; });
    const before = M.totalContrib(current, params);
    const alloc = M.optimise(params, B, { current: current });
    const after = M.totalContrib(alloc, params);

    // animate sliders to the optimal allocation
    const from = params.map(function (c) { return +state.spends[c.key]; });
    const t0 = performance.now();
    function step(now) {
      const t = Math.min(1, (now - t0) / 650);
      const e = 1 - Math.pow(1 - t, 3);
      params.forEach(function (c, i) {
        state.spends[c.key] = Math.round((from[i] + (alloc[i] - from[i]) * e) * 10) / 10;
        syncSlider(c.key);
      });
      renderLight();
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);

    const roas = after / Math.max(B, 1e-9);
    let msg = "Optimal split for <b>€" + Math.round(B).toLocaleString() + "k</b> → media revenue <b>€" +
      Math.round(after).toLocaleString() + "k</b> at blended ROAS <b>" + roas.toFixed(2) + "×</b>";
    if (before > 0) msg += ", <b>" + (100 * (after - before) / before >= 0 ? "+" : "") +
      Math.round((100 * (after - before) / before)) + "%</b> vs the previous allocation";
    const box = $("#optResult");
    box.innerHTML = msg + ".";
    box.classList.add("show");
  }

  // ---- parameters editor ----------------------------------------------
  function buildParamEditor() {
    paramRows.innerHTML = "";
    state.channels.forEach(function (c, i) {
      const row = document.createElement("div");
      row.className = "param-row";
      row.innerHTML =
        '<div class="param-name"><span class="dot" style="background:' + c.color + '"></span>' + c.name + "</div>" +
        field(i, "beta", c.beta, "1") + field(i, "gamma", c.gamma, "0.5") +
        field(i, "alpha", c.alpha, "0.05") + field(i, "theta", c.theta, "0.01");
      paramRows.appendChild(row);
    });
    paramRows.querySelectorAll("input").forEach(function (inp) {
      inp.addEventListener("change", function () {
        const i = +inp.dataset.i, k = inp.dataset.k;
        state.channels[i][k] = parseFloat(inp.value) || 0;
        renderCurves();
        renderLight();
        scheduleScenario();
        saveState();
      });
    });
  }
  function field(i, k, v, step) {
    return '<div class="param-field"><label>' + greek(k) + '</label>' +
      '<input type="number" step="' + step + '" value="' + v + '" data-i="' + i + '" data-k="' + k + '"></div>';
  }
  function greek(k) { return { beta: "β", gamma: "γ", alpha: "α", theta: "θ" }[k]; }

  // ---- import / export / reset ----------------------------------------
  function exportJSON() {
    const arr = state.channels.map(function (c) {
      return { key: c.key, name: c.name, color: c.color, beta: c.beta, gamma: c.gamma, alpha: c.alpha, theta: c.theta };
    });
    const blob = new Blob([JSON.stringify(arr, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "params.json"; a.click();
    URL.revokeObjectURL(url);
  }
  function applyJSON(text) {
    const arr = JSON.parse(text);
    const channels = arr.map(function (o) {
      return {
        key: o.key || o.name || "ch", name: o.name || o.key || "Channel", color: o.color || "#6C8CFF",
        beta: +o.beta, gamma: +o.gamma, alpha: +o.alpha, theta: +o.theta
      };
    });
    state.channels = channels;
    state.spends = {};
    arr.forEach(function (o, i) { state.spends[channels[i].key] = o.spend != null ? +o.spend : +o.gamma; });
    state.optBudget = Math.round(channels.reduce(function (a, c) { return a + state.spends[c.key]; }, 0));
    fullRender();
    saveState();
  }
  function resetAll() {
    state = freshState();
    fullRender();
    $("#optResult").classList.remove("show");
    saveState();
  }

  // ---- full render -----------------------------------------------------
  function fullRender() {
    rebuildUserKpis();
    buildSliders();
    buildParamEditor();
    buildLibrary();
    renderVarsHelp();
    renderCurves();
    $("#baseline").value = state.baseline;
    $("#optBudget").value = state.optBudget;
    renderLight();
    scheduleScenario();
    scheduleHeavy();
  }

  // ---- theme -----------------------------------------------------------
  function initTheme() {
    function currentTheme() {
      return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
    }
    function applyTheme(t) {
      document.documentElement.setAttribute("data-theme", t);
      try { localStorage.setItem("mmm-theme", t); } catch (e) {}
      window.dispatchEvent(new CustomEvent("themechange", { detail: { theme: t } }));
    }
    document.querySelectorAll("[data-theme-toggle]").forEach(function (b) {
      b.addEventListener("click", function () {
        applyTheme(currentTheme() === "light" ? "dark" : "light");
      });
    });
  }

  // ---- wire up ---------------------------------------------------------
  function init() {
    initTheme();
    $("#baseline").addEventListener("input", function () {
      state.baseline = parseFloat(this.value) || 0; renderLight();
    });
    $("#optBudget").addEventListener("input", function () { state.optBudget = parseFloat(this.value) || 0; });
    $("#optBtn").addEventListener("click", runOptimise);

    // KPI library
    $("#libToggle").addEventListener("click", function () {
      const lib = $("#kpiLibrary");
      const open = lib.hidden;
      lib.hidden = !open;
      this.textContent = open ? "Close library" : "＋ Add metrics";
      this.classList.toggle("active", open);
      if (open) { $("#libSearch").value = ""; filterLibrary(""); $("#libSearch").focus(); }
    });
    $("#libSearch").addEventListener("input", function () { filterLibrary(this.value.toLowerCase()); });

    // formula builder
    $("#mFormula").addEventListener("input", previewFormula);
    $("#mUnit").addEventListener("change", previewFormula);
    $("#mDec").addEventListener("input", previewFormula);
    $("#mFormula").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); addUserMetric(); } });
    $("#mAdd").addEventListener("click", addUserMetric);
    $("#mHelp").addEventListener("click", function () {
      const v = $("#mVars");
      v.hidden = !v.hidden;
      this.textContent = v.hidden ? "Available variables ▾" : "Available variables ▴";
    });
    $("#exportBtn").addEventListener("click", exportJSON);
    $("#resetBtn").addEventListener("click", resetAll);
    $("#applyJsonBtn").addEventListener("click", function () {
      const ta = $("#jsonInput");
      try { applyJSON(ta.value); $("#jsonError").textContent = ""; ta.value = ""; }
      catch (e) { $("#jsonError").textContent = "Parse error: " + e.message; }
    });
    const fileInput = $("#fileInput");
    $("#uploadBtn").addEventListener("click", function () { fileInput.click(); });
    fileInput.addEventListener("change", function () {
      const f = fileInput.files[0]; if (!f) return;
      const reader = new FileReader();
      reader.onload = function () {
        try { applyJSON(reader.result); $("#jsonError").textContent = ""; }
        catch (e) { $("#jsonError").textContent = "Parse error: " + e.message; }
      };
      reader.readAsText(f);
    });

    // smooth-scroll nav
    document.querySelectorAll("[data-scroll]").forEach(function (a) {
      a.addEventListener("click", function (e) {
        e.preventDefault();
        const t = document.querySelector(a.getAttribute("data-scroll"));
        if (t) t.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });

    // rebuild curves on resize (viewBox is fluid, but keep maxima sensible)
    let rz;
    window.addEventListener("resize", function () {
      clearTimeout(rz);
      rz = setTimeout(function () { renderCurves(); renderLight(); }, 200);
    });

    // when a backgrounded tab becomes visible, refresh so counters settle
    document.addEventListener("visibilitychange", function () { if (!document.hidden) renderLight(); });

    // reveal-on-scroll
    const io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) en.target.classList.add("in"); });
    }, { threshold: 0.08 });
    document.querySelectorAll(".reveal").forEach(function (n) { io.observe(n); });

    // nav reveal + scroll progress (the nav stays hidden over the landing hero)
    const nav = $("#nav");
    const bar = $("#scrollBar");
    const landing = $("#landing");
    const floatTheme = $("#floatingTheme");
    let ticking = false;
    function onScroll() {
      const y = window.scrollY || window.pageYOffset;
      const past = landing ? y > landing.offsetHeight * 0.6 : y > 240;
      nav.classList.toggle("show", past);
      if (floatTheme) floatTheme.classList.toggle("hide", past);
      const doc = document.documentElement;
      const max = doc.scrollHeight - doc.clientHeight;
      bar.style.width = (max > 0 ? (y / max) * 100 : 0) + "%";
      ticking = false;
    }
    window.addEventListener("scroll", function () {
      if (!ticking) { ticking = true; requestAnimationFrame(onScroll); }
    }, { passive: true });
    onScroll();

    fullRender();
  }

  // ---- external controller API (used by the CSV import engine) ---------
  window.MMM_APP = {
    sliderMax: SLIDER_MAX,
    getChannels: function () { return state.channels.map(function (c) { return Object.assign({}, c); }); },
    getSpends: function () { return Object.assign({}, state.spends); },
    getBaseline: function () { return +state.baseline; },
    getOptBudget: function () { return +state.optBudget; },
    setSpends: function (map) {
      state.channels.forEach(function (c) {
        if (map[c.key] != null && isFinite(map[c.key])) {
          state.spends[c.key] = Math.max(0, Math.min(SLIDER_MAX, +map[c.key]));
          syncSlider(c.key);
        }
      });
      renderLight();
    },
    setBaseline: function (v) {
      if (v == null || !isFinite(v)) return;
      state.baseline = Math.max(0, +v); $("#baseline").value = state.baseline; renderLight();
    },
    setOptBudget: function (v) {
      if (v == null || !isFinite(v)) return;
      state.optBudget = Math.max(0, Math.round(+v)); $("#optBudget").value = state.optBudget;
    },
    optimise: function () { runOptimise(); },
    applyParams: function (arr) {
      arr.forEach(function (p) {
        const c = state.channels.find(function (x) { return x.key === p.key; });
        if (!c) return;
        if (p.beta != null && isFinite(p.beta)) c.beta = +p.beta;
        if (p.gamma != null && isFinite(p.gamma)) c.gamma = +p.gamma;
        if (p.alpha != null && isFinite(p.alpha)) c.alpha = +p.alpha;
        if (p.theta != null && isFinite(p.theta)) c.theta = +p.theta;
      });
      buildParamEditor(); renderCurves(); renderLight(); scheduleScenario(); scheduleHeavy(); saveState();
    }
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
