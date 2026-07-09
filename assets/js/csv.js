/* =========================================================================
 * csv.js — drag-and-drop CSV import: analyse expenditures, load spend,
 * optimise, and (optionally) calibrate the response curves from history.
 *
 * Handles the three common shapes automatically and lets the user correct
 * the mapping:
 *   • wide time-series  (date, TV, Search, …, [Revenue])
 *   • channel snapshot  (channel, spend)   — single value per channel
 *   • long transactions (date, channel, amount)
 *
 * Talks to the planner through window.MMM_APP.
 * ========================================================================= */
(function () {
  "use strict";

  const SYN = {
    tv: ["tv", "television", "linear", "ctv", "connectedtv"],
    search: ["search", "sem", "ppc", "paidsearch", "google", "adwords", "bing", "sea"],
    social: ["social", "paidsocial", "facebook", "meta", "instagram", "ig", "fb", "tiktok", "linkedin", "twitter", "snapchat", "pinterest"],
    video: ["video", "onlinevideo", "youtube", "yt", "ott", "olv", "preroll"],
    display: ["display", "banner", "gdn", "programmatic", "prog", "dooh", "native"]
  };
  const REV_RE = /revenue|sales|conversion|conv\b|value|kpi|income|turnover|gmv/i;
  const DATE_RE = /date|week|month|period|day|time|wk|dt/i;
  const CHAN_RE = /channel|media|source|platform|campaign|tactic/i;
  const AMT_RE = /amount|spend|cost|budget|invest|value|eur|usd|gbp|\$|€|£/i;

  let S = null;      // working state
  let els = {};      // dom refs

  // ---- utilities ------------------------------------------------------
  function norm(s) { return String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]/g, ""); }

  function cleanNum(v) {
    if (v == null) return NaN;
    if (typeof v === "number") return v;
    let s = String(v).trim().replace(/[%\s]/g, "").replace(/[€$£]/g, "");
    if (!s) return NaN;
    // handle thousand/decimal separators: 1.234,56 (eu) vs 1,234.56 (us)
    const hasComma = s.indexOf(",") >= 0, hasDot = s.indexOf(".") >= 0;
    if (hasComma && hasDot) {
      if (s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g, "").replace(",", ".");
      else s = s.replace(/,/g, "");
    } else if (hasComma) {
      // comma only — decimal if one comma with <=2 trailing digits, else thousands
      const parts = s.split(",");
      if (parts.length === 2 && parts[1].length <= 2) s = parts[0] + "." + parts[1];
      else s = s.replace(/,/g, "");
    }
    const n = parseFloat(s);
    return isFinite(n) ? n : NaN;
  }

  function isDateLike(v) {
    if (v == null || v === "") return false;
    const s = String(v).trim();
    if (/^\d{4}[-/]\d{1,2}([-/]\d{1,2})?$/.test(s)) return true;   // 2024-01 or 2024-01-05
    if (/^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$/.test(s)) return true;     // 05/01/2024
    if (/^(w|wk|week)\s*\d+/i.test(s)) return true;                  // Week 3
    if (/^\d{4}\s*[-/]?\s*(w|wk)\s*\d+/i.test(s)) return true;       // 2024-W03
    return false;
  }

  function matchChannel(header, chans) {
    const h = norm(header);
    if (!h) return null;
    for (let i = 0; i < chans.length; i++) {
      const c = chans[i];
      const syn = SYN[c.key] || [];
      if (h === norm(c.name) || h === norm(c.key)) return c.key;
      for (let j = 0; j < syn.length; j++) if (h.indexOf(syn[j]) >= 0 || syn[j].indexOf(h) >= 0) return c.key;
      if (h.indexOf(norm(c.name)) >= 0) return c.key;
    }
    return null;
  }

  // ---- CSV parsing (RFC-ish state machine) ----------------------------
  function detectDelim(head) {
    const cands = [",", ";", "\t", "|"];
    let best = ",", n = -1;
    cands.forEach(function (d) { const c = head.split(d).length; if (c > n) { n = c; best = d; } });
    return best;
  }
  function parseCSV(text) {
    text = text.replace(/^﻿/, "");
    const firstNl = text.search(/\r?\n/);
    const delim = detectDelim(firstNl >= 0 ? text.slice(0, firstNl) : text);
    const rows = []; let row = [], field = "", inQ = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
        else field += ch;
      } else {
        if (ch === '"') inQ = true;
        else if (ch === delim) { row.push(field); field = ""; }
        else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
        else if (ch === "\r") { /* skip */ }
        else field += ch;
      }
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    // drop fully-empty rows
    const clean = rows.filter(function (r) { return r.some(function (c) { return String(c).trim() !== ""; }); });
    if (!clean.length) return null;
    const headers = clean[0].map(function (h, i) { return String(h).trim() || ("Column " + (i + 1)); });
    return { headers: headers, rows: clean.slice(1).map(function (r) { return r.map(function (c) { return String(c).trim(); }); }) };
  }

  // ---- column analysis + auto-detection -------------------------------
  function analyseColumns(parsed) {
    const cols = parsed.headers.map(function (h, i) {
      let num = 0, dat = 0, tot = 0;
      const vals = [];
      parsed.rows.forEach(function (r) {
        const v = r[i]; if (v == null || v === "") return;
        tot++; vals.push(v);
        if (isFinite(cleanNum(v))) num++;
        if (isDateLike(v)) dat++;
      });
      return { idx: i, header: h, numeric: tot > 0 && num / tot > 0.6, dateish: tot > 0 && dat / tot > 0.6, distinct: new Set(vals).size, tot: tot };
    });
    return cols;
  }

  function autoDetect(parsed, chans) {
    const cols = analyseColumns(parsed);
    const map = { format: "wide", scale: 1, agg: "mean", dateCol: -1, revCol: -1, chanCol: -1, amtCol: -1, colMap: {} };

    // date column
    const dc = cols.find(function (c) { return c.dateish || DATE_RE.test(c.header); });
    if (dc) map.dateCol = dc.idx;

    // long format? a text column that looks like channel names + a single amount column
    const textCols = cols.filter(function (c) { return !c.numeric && !c.dateish; });
    const numCols = cols.filter(function (c) { return c.numeric; });
    const chanLike = textCols.find(function (c) {
      if (CHAN_RE.test(c.header)) return true;
      // do most distinct values match known channels?
      let hit = 0, seen = 0;
      const seenVals = {};
      parsed.rows.forEach(function (r) { const v = r[c.idx]; if (v && !seenVals[v]) { seenVals[v] = 1; seen++; if (matchChannel(v, chans)) hit++; } });
      return seen > 0 && hit / seen >= 0.5 && seen <= 40;
    });
    if (chanLike && numCols.length >= 1) {
      map.format = "long";
      map.chanCol = chanLike.idx;
      const amt = numCols.find(function (c) { return AMT_RE.test(c.header); }) || numCols[0];
      map.amtCol = amt.idx;
    } else {
      map.format = "wide";
      // revenue column
      const rev = numCols.find(function (c) { return REV_RE.test(c.header); });
      if (rev) map.revCol = rev.idx;
      // channel columns = numeric, not date, not revenue
      numCols.forEach(function (c) {
        if (c.idx === map.revCol || c.idx === map.dateCol) return;
        const key = matchChannel(c.header, chans);
        map.colMap[c.idx] = key; // may be null (ignore/unmapped)
      });
    }

    // unit scale guess: bring typical spend into the model's €k range
    const sv = aggregate(buildPeriods(parsed, map, chans), "mean");
    const nums = Object.keys(sv).map(function (k) { return sv[k]; }).filter(function (x) { return x > 0; }).sort(function (a, b) { return a - b; });
    if (nums.length) {
      const med = nums[Math.floor(nums.length / 2)];
      if (med >= 500000) map.scale = 1e-6;
      else if (med >= 2000) map.scale = 1e-3;
    }
    return map;
  }

  // ---- build unified periods ------------------------------------------
  function buildPeriods(parsed, map, chans) {
    const periods = [];
    if (map.format === "long") {
      const byDate = {};
      const order = [];
      parsed.rows.forEach(function (r, i) {
        const dkey = map.dateCol >= 0 ? (r[map.dateCol] || "") : "all";
        const key = matchChannel(r[map.chanCol], chans);
        const amt = cleanNum(r[map.amtCol]);
        if (!byDate[dkey]) { byDate[dkey] = { date: map.dateCol >= 0 ? r[map.dateCol] : "", spends: {}, revenue: null }; order.push(dkey); }
        if (key && isFinite(amt)) byDate[dkey].spends[key] = (byDate[dkey].spends[key] || 0) + amt;
      });
      order.forEach(function (k) { periods.push(byDate[k]); });
    } else {
      parsed.rows.forEach(function (r) {
        const p = { date: map.dateCol >= 0 ? r[map.dateCol] : "", spends: {}, revenue: null };
        Object.keys(map.colMap).forEach(function (idx) {
          const key = map.colMap[idx]; if (!key) return;
          const v = cleanNum(r[idx]); if (isFinite(v)) p.spends[key] = (p.spends[key] || 0) + v;
        });
        if (map.revCol >= 0) { const rv = cleanNum(r[map.revCol]); if (isFinite(rv)) p.revenue = rv; }
        periods.push(p);
      });
    }
    return periods;
  }

  function aggregate(periods, agg) {
    const out = {}; const cnt = {};
    periods.forEach(function (p) {
      Object.keys(p.spends).forEach(function (k) { out[k] = (out[k] || 0) + p.spends[k]; cnt[k] = (cnt[k] || 0) + 1; });
    });
    if (agg === "latest") {
      const last = {};
      for (let i = periods.length - 1; i >= 0; i--) {
        Object.keys(periods[i].spends).forEach(function (k) { if (last[k] == null) last[k] = periods[i].spends[k]; });
      }
      return last;
    }
    if (agg === "mean") Object.keys(out).forEach(function (k) { out[k] = out[k] / (cnt[k] || 1); });
    return out; // total otherwise
  }

  function scaledVector(periods, map) {
    const v = aggregate(periods, map.agg);
    const out = {}; Object.keys(v).forEach(function (k) { out[k] = v[k] * map.scale; });
    return out;
  }

  // ---- model calibration (convex NNLS with fixed shapes) --------------
  // Holds alpha fixed and gamma at a data-driven heuristic, so revenue is
  // linear in {baseline, beta_i} -> convex non-negative least squares.
  function fitModel(periods, map, chans) {
    const rows = periods.filter(function (p) { return p.revenue != null && isFinite(p.revenue); });
    if (rows.length < 6) return { error: "Need at least 6 rows with a revenue value to calibrate (found " + rows.length + ")." };
    /* Identifiability screen. Spend that never varies carries no information:
     * the solver would silently absorb the channel into the baseline (beta -> 0),
     * which reads as "this channel produces nothing" when the honest statement is
     * "this channel cannot be distinguished from baseline with these data".
     * Such channels are excluded from the fit (params left untouched) and
     * reported; weakly-varying channels are fitted but flagged. */
    const keys = [], excluded = [], weak = [];
    chans.forEach(function (c) {
      const vals = rows.map(function (p) { return (p.spends[c.key] || 0) * map.scale; });
      const mx = Math.max.apply(null, vals);
      if (mx <= 0) return; // never spent — nothing to calibrate, silently skipped
      const mean = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
      const sd = Math.sqrt(vals.reduce(function (a, v) { return a + (v - mean) * (v - mean); }, 0) / vals.length);
      const cv = mean > 0 ? sd / mean : 0;
      if (cv < 0.02) { excluded.push({ key: c.key, name: c.name, cv: cv }); return; }
      if (cv < 0.15) weak.push({ key: c.key, name: c.name, cv: cv });
      keys.push(c.key);
    });
    if (!keys.length) {
      return { error: "No identifiable channels: every mapped channel has (near-)constant spend across the history, so none can be distinguished from the baseline." };
    }

    const y = rows.map(function (p) { return p.revenue * map.scale; });
    const ymax = Math.max.apply(null, y) || 1;
    const yn = y.map(function (v) { return v / ymax; });
    const alphaOf = {}, medOf = {};
    chans.forEach(function (c) { alphaOf[c.key] = +c.alpha || 1; });

    function featureMatrix(gscale) {
      // gamma_i = median positive spend * gscale
      keys.forEach(function (k) {
        const vals = rows.map(function (p) { return (p.spends[k] || 0) * map.scale; }).filter(function (x) { return x > 0; }).sort(function (a, b) { return a - b; });
        medOf[k] = (vals.length ? vals[Math.floor(vals.length / 2)] : 1) * gscale || 1;
      });
      return rows.map(function (p) {
        return keys.map(function (k) {
          const s = Math.max((p.spends[k] || 0) * map.scale, 1e-9);
          const a = alphaOf[k], g = medOf[k];
          return Math.pow(s, a) / (Math.pow(g, a) + Math.pow(s, a));
        });
      });
    }

    const ymin = Math.min.apply(null, yn);
    const basePrior = 0.5 * ymin;   // plausible "organic floor": media never hits zero in the data
    function solveNNLS(X) {
      // params: [b0, beta_1..beta_n] >= 0, minimise ||b0 + X beta - yn||^2 + mu(b0 - prior)^2
      // Baseline and always-on media are collinear; a mild prior pins the constant to a
      // plausible baseline while the betas stay free to fit the revenue variation.
      const n = keys.length, T = X.length, mu = 0.15, ridge = 0.0025;
      let b0 = basePrior, beta = keys.map(function () { return 0.25; });
      let lr = 0.4;
      for (let it = 0; it < 4000; it++) {
        let gb0 = 0; const gb = new Array(n).fill(0);
        for (let t = 0; t < T; t++) {
          let pred = b0; for (let i = 0; i < n; i++) pred += beta[i] * X[t][i];
          const e = pred - yn[t];
          gb0 += e; for (let i = 0; i < n; i++) gb[i] += e * X[t][i];
        }
        b0 = Math.max(0, b0 - lr * (gb0 / T + mu * (b0 - basePrior)));
        // tiny ridge spreads attribution across collinear channels (avoids exact zeros)
        for (let i = 0; i < n; i++) beta[i] = Math.max(0, beta[i] - lr * (gb[i] / T + ridge * beta[i]));
        if (it % 1000 === 999) lr *= 0.6;
      }
      // R^2
      let ss = 0, st = 0; const ym = yn.reduce(function (a, b) { return a + b; }, 0) / T;
      for (let t = 0; t < T; t++) {
        let pred = b0; for (let i = 0; i < n; i++) pred += beta[i] * X[t][i];
        ss += (pred - yn[t]) * (pred - yn[t]); st += (yn[t] - ym) * (yn[t] - ym);
      }
      return { b0: b0, beta: beta, r2: st > 0 ? 1 - ss / st : 0 };
    }

    let best = null;
    [0.6, 1, 1.6, 2.4].forEach(function (gs) {
      const X = featureMatrix(gs);
      const g = {}; keys.forEach(function (k) { g[k] = medOf[k]; });
      const sol = solveNNLS(X);
      if (!best || sol.r2 > best.r2) best = { sol: sol, gamma: g, gscale: gs };
    });

    const params = keys.map(function (k, i) {
      return { key: k, beta: best.sol.beta[i] * ymax, gamma: best.gamma[k], alpha: alphaOf[k] };
    });
    return { params: params, baseline: best.sol.b0 * ymax, r2: best.sol.r2, n: rows.length,
             keys: keys, excluded: excluded, weak: weak };
  }

  // ---- rendering ------------------------------------------------------
  function el(tag, cls, html) { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; }
  function fmtK(v) { return "€" + Math.round(v).toLocaleString() + "k"; }

  function colSelect(selected, includeIgnore, chans) {
    let o = includeIgnore ? '<option value="">— ignore —</option>' : "";
    chans.forEach(function (c) { o += '<option value="' + c.key + '"' + (c.key === selected ? " selected" : "") + ">" + escapeHtml(c.name) + "</option>"; });
    return o;
  }
  function headerSelect(cols, selected, label) {
    let o = '<option value="-1">' + (label || "— none —") + "</option>";
    cols.forEach(function (c) { o += '<option value="' + c.idx + '"' + (c.idx === selected ? " selected" : "") + ">" + escapeHtml(c.header) + "</option>"; });
    return o;
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

  function render() {
    const p = S.parsed, map = S.map, chans = S.chans;
    const cols = analyseColumns(p);
    const numCols = cols.filter(function (c) { return c.numeric; });
    const allCols = cols;
    const periods = buildPeriods(p, map, chans);
    S.periods = periods;
    const vec = scaledVector(periods, map);
    const mappedKeys = Object.keys(vec).filter(function (k) { return vec[k] > 0; });

    // ---------- mapping panel ----------
    let m = '<div class="csv-sub">Mapping <span class="csv-detected">' + (map.format === "long" ? "long / transactions" : "wide / columns") + " · " + p.rows.length + " rows detected</span></div>";
    m += '<div class="csv-fields">';
    m += field("Format", '<select data-k="format"><option value="wide"' + (map.format === "wide" ? " selected" : "") + ">Columns per channel</option><option value=\"long\"" + (map.format === "long" ? " selected" : "") + ">Channel + amount rows</option></select>");
    m += field("Values in", '<select data-k="scale"><option value="1"' + (map.scale === 1 ? " selected" : "") + '>€k (as-is)</option><option value="0.001"' + (map.scale === 0.001 ? " selected" : "") + '>€ (÷1,000)</option><option value="0.000001"' + (map.scale === 1e-6 ? " selected" : "") + ">€ millions base (÷1,000,000)</option></select>");
    m += field("Aggregate", '<select data-k="agg"><option value="mean"' + (map.agg === "mean" ? " selected" : "") + '>Average / period</option><option value="latest"' + (map.agg === "latest" ? " selected" : "") + '>Latest period</option><option value="total"' + (map.agg === "total" ? " selected" : "") + ">Total</option></select>");
    m += field("Date / period", '<select data-k="dateCol">' + headerSelect(allCols, map.dateCol, "— none —") + "</select>");
    if (map.format === "wide") {
      m += field("Revenue", '<select data-k="revCol">' + headerSelect(numCols, map.revCol, "— none (no calibration) —") + "</select>");
    } else {
      m += field("Channel column", '<select data-k="chanCol">' + headerSelect(allCols, map.chanCol) + "</select>");
      m += field("Amount column", '<select data-k="amtCol">' + headerSelect(numCols, map.amtCol) + "</select>");
    }
    m += "</div>";

    if (map.format === "wide") {
      m += '<div class="csv-sub">Channel columns</div><div class="csv-colmap">';
      numCols.forEach(function (c) {
        if (c.idx === map.revCol || c.idx === map.dateCol) return;
        m += '<div class="csv-colrow"><span class="csv-colname">' + escapeHtml(c.header) + '</span><select data-colmap="' + c.idx + '">' + colSelect(map.colMap[c.idx], true, chans) + "</select></div>";
      });
      m += "</div>";
    }
    els.map.innerHTML = m;

    // ---------- analysis panel ----------
    const totals = Object.keys(vec).reduce(function (a, k) { return a + vec[k]; }, 0);
    let a = '<div class="csv-sub">Expenditure analysis</div>';
    const dates = periods.map(function (x) { return x.date; }).filter(Boolean);
    a += '<div class="csv-stats">' +
      stat(mappedKeys.length + " / " + chans.length, "channels mapped") +
      stat(periods.length, "periods") +
      stat(fmtK(totals), map.agg === "total" ? "total spend" : (map.agg === "latest" ? "latest spend" : "avg spend / period")) +
      (dates.length ? stat(escapeHtml(dates[0]) + " → " + escapeHtml(dates[dates.length - 1]), "range") : "") +
      "</div>";
    // breakdown bars
    const maxv = Math.max.apply(null, chans.map(function (c) { return vec[c.key] || 0; })) || 1;
    a += '<div class="csv-bars">';
    chans.forEach(function (c) {
      const val = vec[c.key] || 0;
      const share = totals ? (100 * val / totals) : 0;
      a += '<div class="csv-bar"><span class="csv-bar-name"><span class="dot" style="background:' + c.color + '"></span>' + escapeHtml(c.name) + '</span>' +
        '<span class="csv-bar-track"><span class="csv-bar-fill" style="width:' + (val ? Math.max(3, 100 * val / maxv) : 0).toFixed(0) + "%;background:" + c.color + '"></span></span>' +
        '<span class="csv-bar-val">' + (val ? fmtK(val) : "—") + '</span><span class="csv-bar-pct">' + (val ? share.toFixed(0) + "%" : "") + "</span></div>";
    });
    a += "</div>";
    a += trendSVG(periods, chans, map);
    els.analysis.innerHTML = a;

    // ---------- actions ----------
    const canFit = map.format === "wide" && map.revCol >= 0 && periods.filter(function (x) { return x.revenue != null; }).length >= 6;
    let ac = '<div class="csv-sub">Apply to planner</div><div class="csv-opts">';
    ac += optChk("optLoad", "Load spend", "Set the planner's channel spend from this file", true, false);
    ac += optChk("optOpt", "Optimise after loading", "Run the optimiser at the loaded total budget", false, false);
    ac += optChk("optFit", "Calibrate response curves", canFit ? "Estimate β / γ from your spend + revenue history" : "Needs a Revenue column and ≥6 rows", false, !canFit);
    ac += "</div>";
    ac += '<div class="csv-actbtns"><button class="btn primary sm" id="csvApply">Apply</button>' +
      '<button class="btn ghost sm" id="csvClear">Clear</button><span class="csv-msg" id="csvMsg"></span></div>';
    els.actions.innerHTML = ac;

    els.map.querySelectorAll("select").forEach(function (sel) { sel.addEventListener("change", onMapChange); });
    document.getElementById("csvApply").addEventListener("click", apply);
    document.getElementById("csvClear").addEventListener("click", reset);
  }

  function field(label, inner) { return '<label class="csv-field"><span>' + label + "</span>" + inner + "</label>"; }
  function stat(v, l) { return '<div class="csv-stat"><div class="csv-stat-v">' + v + '</div><div class="csv-stat-l">' + l + "</div></div>"; }
  function optChk(id, label, desc, checked, disabled) {
    return '<label class="csv-opt' + (disabled ? " off" : "") + '"><input type="checkbox" id="' + id + '"' + (checked ? " checked" : "") + (disabled ? " disabled" : "") + '>' +
      '<span><b>' + label + "</b><br><small>" + desc + "</small></span></label>";
  }

  function trendSVG(periods, chans, map) {
    if (periods.length < 2) return "";
    const W = 520, H = 120, PL = 6, PR = 6, PT = 8, PB = 6;
    const pw = W - PL - PR, ph = H - PT - PB;
    let maxTot = 0;
    const tots = periods.map(function (p) {
      let t = 0; chans.forEach(function (c) { t += (p.spends[c.key] || 0) * map.scale; }); maxTot = Math.max(maxTot, t); return t;
    });
    maxTot = maxTot || 1;
    let svg = '<div class="csv-sub">Spend over time</div><svg class="csv-trend" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none">';
    // stacked areas per channel
    const cum = periods.map(function () { return 0; });
    chans.forEach(function (c) {
      let top = "", bot = "";
      periods.forEach(function (p, i) {
        const x = PL + (periods.length === 1 ? pw / 2 : (i / (periods.length - 1)) * pw);
        const yBot = PT + ph - (cum[i] / maxTot) * ph;
        cum[i] += (p.spends[c.key] || 0) * map.scale;
        const yTop = PT + ph - (cum[i] / maxTot) * ph;
        top += (i ? " L" : "M") + x.toFixed(1) + "," + yTop.toFixed(1);
        bot = " L" + x.toFixed(1) + "," + yBot.toFixed(1) + bot;
      });
      svg += '<path d="' + top + bot + ' Z" fill="' + c.color + '" fill-opacity="0.55" stroke="none"/>';
    });
    svg += "</svg>";
    return svg;
  }

  // ---- events ---------------------------------------------------------
  function onMapChange(e) {
    const t = e.target;
    if (t.dataset.colmap != null) { S.map.colMap[t.dataset.colmap] = t.value || null; render(); return; }
    const k = t.dataset.k; if (!k) return;
    let v = t.value;
    if (k === "scale") v = parseFloat(v);
    else if (["dateCol", "revCol", "chanCol", "amtCol"].indexOf(k) >= 0) v = parseInt(v, 10);
    S.map[k] = v;
    if (k === "format") S.map = Object.assign(autoDetect(S.parsed, S.chans), { format: v, scale: S.map.scale, agg: S.map.agg });
    render();
  }

  function apply() {
    const msg = document.getElementById("csvMsg");
    const load = document.getElementById("optLoad").checked;
    const opt = document.getElementById("optOpt").checked;
    const fit = document.getElementById("optFit").checked && !document.getElementById("optFit").disabled;
    const vec = scaledVector(S.periods, S.map);
    const notes = [];

    if (fit) {
      const r = fitModel(S.periods, S.map, S.chans);
      if (r.error) { notes.push("⚠ Calibration skipped: " + r.error); }
      else {
        window.MMM_APP.applyParams(r.params);
        window.MMM_APP.setBaseline(r.baseline);
        notes.push("Calibrated " + r.params.length + " channels from " + r.n + " periods · fit R² " + r.r2.toFixed(2) +
          (r.r2 < 0.4 ? " (weak — treat as indicative)" : ""));
        if (r.excluded && r.excluded.length) {
          notes.push("⚠ <b>" + r.excluded.map(function (e) { return escapeHtml(e.name); }).join(", ") +
            "</b> left unchanged — spend is (near-)constant in this history, so the channel cannot be told apart from the baseline. That is missing information, not zero effect.");
        }
        if (r.weak && r.weak.length) {
          notes.push("low spend variation for " + r.weak.map(function (e) { return escapeHtml(e.name); }).join(", ") +
            " — treat those estimates with caution");
        }
      }
    }
    if (load) {
      const capped = S.chans.some(function (c) { return (vec[c.key] || 0) > window.MMM_APP.sliderMax; });
      window.MMM_APP.setSpends(vec);
      const tot = Object.keys(vec).reduce(function (a, k) { return a + vec[k]; }, 0);
      window.MMM_APP.setOptBudget(Math.round(tot));
      notes.push("Loaded spend for " + Object.keys(vec).filter(function (k) { return vec[k] > 0; }).length + " channels" +
        (capped ? " (some values exceeded the slider max and were capped — try a different unit scale)" : ""));
    }
    if (opt) { window.MMM_APP.optimise(); notes.push("Ran the optimiser."); }

    if (!load && !opt && !fit) { msg.textContent = "Select at least one action."; msg.className = "csv-msg warn"; return; }
    msg.innerHTML = "✓ " + notes.join(" · ");
    msg.className = "csv-msg ok";
  }

  function loadText(text, name) {
    const parsed = parseCSV(text);
    if (!parsed || !parsed.rows.length) { flashError("Could not read any rows from " + (name || "the file") + "."); return; }
    const chans = window.MMM_APP.getChannels();
    S = { parsed: parsed, chans: chans, name: name, map: autoDetect(parsed, chans) };
    els.result.hidden = false;
    els.zone.classList.add("has-file");
    els.zoneTitle.textContent = name || "CSV loaded";
    render();
    els.result.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  function flashError(t) { els.zoneTitle.textContent = t; els.zone.classList.add("err"); setTimeout(function () { els.zone.classList.remove("err"); els.zoneTitle.textContent = "Drop a CSV file here"; }, 3200); }

  function reset() {
    S = null; els.result.hidden = true; els.zone.classList.remove("has-file");
    els.zoneTitle.textContent = "Drop a CSV file here"; els.file.value = "";
  }

  function readFile(f) {
    if (!f) return;
    if (!/\.csv$|text\/csv|text\/plain/i.test(f.name + " " + f.type)) { flashError("Please drop a .csv file."); return; }
    const r = new FileReader();
    r.onload = function () { loadText(String(r.result), f.name); };
    r.onerror = function () { flashError("Could not read the file."); };
    r.readAsText(f);
  }

  // ---- init -----------------------------------------------------------
  function init() {
    const zone = document.getElementById("dropzone");
    if (!zone || !window.MMM_APP) return;
    els = {
      zone: zone,
      zoneTitle: zone.querySelector(".dz-title"),
      file: document.getElementById("csvFile"),
      result: document.getElementById("csvResult"),
      map: null, analysis: null, actions: null
    };
    // build result sub-containers
    els.result.innerHTML = '<div class="csv-grid"><div class="csv-map" id="csvMap"></div><div class="csv-analysis" id="csvAnalysis"></div></div><div class="csv-actions" id="csvActions"></div>';
    els.map = document.getElementById("csvMap");
    els.analysis = document.getElementById("csvAnalysis");
    els.actions = document.getElementById("csvActions");

    zone.addEventListener("click", function (e) { if (e.target.closest(".dz-browse") || e.target === zone || e.target.closest(".dz-inner")) els.file.click(); });
    zone.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); els.file.click(); } });
    els.file.addEventListener("change", function () { readFile(els.file.files[0]); });

    ["dragenter", "dragover"].forEach(function (ev) { zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add("over"); }); });
    ["dragleave", "drop"].forEach(function (ev) { zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.remove("over"); }); });
    zone.addEventListener("drop", function (e) { const f = e.dataTransfer.files && e.dataTransfer.files[0]; readFile(f); });

    // full-window drag overlay
    const overlay = document.getElementById("dragOverlay");
    let dragDepth = 0;
    window.addEventListener("dragenter", function (e) { if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") >= 0) { dragDepth++; overlay.classList.add("show"); } });
    window.addEventListener("dragleave", function () { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) overlay.classList.remove("show"); });
    window.addEventListener("dragover", function (e) { if (overlay.classList.contains("show")) e.preventDefault(); });
    window.addEventListener("drop", function (e) {
      dragDepth = 0; overlay.classList.remove("show");
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        if (!e.target.closest("#dropzone")) { e.preventDefault(); document.getElementById("data").scrollIntoView({ behavior: "smooth", block: "start" }); readFile(e.dataTransfer.files[0]); }
      }
    });
  }

  // exposed for the automated test suite (tests/run-tests.mjs)
  window.CSV_ENGINE = { parseCSV: parseCSV, autoDetect: autoDetect, buildPeriods: buildPeriods,
    aggregate: aggregate, fitModel: fitModel, cleanNum: cleanNum, matchChannel: matchChannel };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
