/* =========================================================================
 * pro.js — the industry-grade interaction layer:
 *   • command palette (Ctrl/⌘+K) with fuzzy search
 *   • plan snapshots + A/B comparison with delta table
 *   • toast notifications (aria-live)
 *   • one-click plan export (CSV)
 * Self-contained: builds its own DOM, drives the planner via window.MMM_APP.
 * ========================================================================= */
(function () {
  "use strict";
  const APP = window.MMM_APP, M = window.MMM;
  if (!APP || !M) return;

  const SNAP_KEY = "mmm-snapshots";
  const isMac = /mac/i.test(navigator.platform || "");
  const KBD = isMac ? "⌘K" : "Ctrl K";

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function fmtK(v) { return "€" + Math.round(v).toLocaleString() + "k"; }
  function el(html) { const d = document.createElement("div"); d.innerHTML = html.trim(); return d.firstChild; }

  // ---- plan maths (derived from the live model) ------------------------
  function planNow() {
    const chans = APP.getChannels(), spends = APP.getSpends(), baseline = APP.getBaseline();
    let media = 0, spend = 0;
    const rows = chans.map(function (c) {
      const s = +spends[c.key] || 0, y = M.hill(s, c);
      media += y; spend += s;
      return { key: c.key, name: c.name, color: c.color, spend: s, contrib: y, roas: s > 0 ? y / s : 0, marg: M.marginal(s, c) };
    });
    return { rows: rows, media: media, spend: spend, baseline: baseline, revenue: baseline + media, roas: spend ? media / spend : 0 };
  }
  function planOf(snap) {
    let media = 0, spend = 0;
    const rows = snap.params.map(function (c) {
      const s = +snap.spends[c.key] || 0, y = M.hill(s, c);
      media += y; spend += s;
      return { key: c.key, name: c.name, color: c.color, spend: s, contrib: y };
    });
    return { rows: rows, media: media, spend: spend, baseline: +snap.baseline, revenue: +snap.baseline + media, roas: spend ? media / spend : 0 };
  }

  // ---- toasts ----------------------------------------------------------
  const toastHost = el('<div class="toasts" aria-live="polite" aria-atomic="false"></div>');
  document.body.appendChild(toastHost);
  function toast(msg, type) {
    const t = el('<div class="toast ' + (type || "info") + '">' + msg + "</div>");
    toastHost.appendChild(t);
    requestAnimationFrame(function () { t.classList.add("in"); });
    setTimeout(function () {
      t.classList.remove("in");
      setTimeout(function () { t.remove(); }, 350);
    }, 3800);
  }

  // ---- snapshots -------------------------------------------------------
  function loadSnaps() { try { return JSON.parse(localStorage.getItem(SNAP_KEY)) || []; } catch (e) { return []; } }
  function saveSnaps(s) { try { localStorage.setItem(SNAP_KEY, JSON.stringify(s.slice(0, 12))); } catch (e) {} }

  function takeSnapshot() {
    const snaps = loadSnaps();
    const p = planNow();
    const name = "Plan " + String.fromCharCode(65 + (snaps.length % 26)) + " · " +
      new Date().toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    snaps.unshift({
      id: "s_" + Date.now().toString(36), name: name, ts: Date.now(),
      baseline: APP.getBaseline(), spends: APP.getSpends(), optBudget: APP.getOptBudget(),
      params: APP.getChannels()
    });
    saveSnaps(snaps);
    toast('Saved <b>' + esc(name) + "</b> — " + fmtK(p.spend) + " spend → " + fmtK(p.revenue) + " revenue", "ok");
    if (!snapModal.hidden) renderSnaps();
  }
  function restoreSnapshot(id) {
    const s = loadSnaps().find(function (x) { return x.id === id; });
    if (!s) return;
    APP.applyParams(s.params);
    APP.setBaseline(s.baseline);
    APP.setSpends(s.spends);
    APP.setOptBudget(s.optBudget);
    toast("Restored <b>" + esc(s.name) + "</b>", "ok");
    closeSnaps();
  }
  function deleteSnapshot(id) {
    saveSnaps(loadSnaps().filter(function (x) { return x.id !== id; }));
    renderSnaps();
  }

  // ---- snapshot modal --------------------------------------------------
  const snapModal = el(
    '<div class="modal-backdrop" hidden role="dialog" aria-modal="true" aria-label="Plan snapshots">' +
    '<div class="modal"><div class="modal-head"><h3>Plan snapshots</h3>' +
    '<div class="modal-actions"><button class="btn primary sm" data-snap-save>Save current plan</button>' +
    '<button class="modal-x" data-snap-close aria-label="Close">×</button></div></div>' +
    '<div class="modal-body" data-snap-body></div></div></div>'
  );
  document.body.appendChild(snapModal);
  let compareId = null;

  function openSnaps() { snapModal.hidden = false; compareId = null; renderSnaps(); }
  function closeSnaps() { snapModal.hidden = true; }
  snapModal.addEventListener("click", function (e) {
    if (e.target === snapModal || e.target.closest("[data-snap-close]")) closeSnaps();
    if (e.target.closest("[data-snap-save]")) takeSnapshot();
    const row = e.target.closest("[data-snap-act]");
    if (row) {
      const act = row.dataset.snapAct, id = row.dataset.id;
      if (act === "restore") restoreSnapshot(id);
      if (act === "delete") deleteSnapshot(id);
      if (act === "compare") { compareId = compareId === id ? null : id; renderSnaps(); }
    }
  });

  function deltaCell(d, fmt, goodUp) {
    if (Math.abs(d) < 0.05) return '<span class="d0">—</span>';
    const cls = goodUp === null ? "dn0" : ((d > 0) === goodUp ? "dup" : "ddn");
    return '<span class="' + cls + '">' + (d > 0 ? "+" : "−") + fmt(Math.abs(d)) + "</span>";
  }

  function renderSnaps() {
    const body = snapModal.querySelector("[data-snap-body]");
    const snaps = loadSnaps();
    if (!snaps.length) {
      body.innerHTML = '<div class="empty-hint">No snapshots yet. Save the current plan, change the sliders, then come back to compare the two allocations side by side.</div>';
      return;
    }
    const cur = planNow();
    let h = "";
    snaps.forEach(function (s) {
      const p = planOf(s);
      h += '<div class="snap-row' + (compareId === s.id ? " open" : "") + '">' +
        '<div class="snap-main"><div class="snap-name">' + esc(s.name) + '</div>' +
        '<div class="snap-meta">' + fmtK(p.spend) + " spend · " + fmtK(p.revenue) + " revenue · " + p.roas.toFixed(2) + "× roas</div></div>" +
        '<div class="snap-btns">' +
        '<button class="btn ghost sm" data-snap-act="compare" data-id="' + s.id + '">' + (compareId === s.id ? "Hide" : "Compare") + "</button>" +
        '<button class="btn ghost sm" data-snap-act="restore" data-id="' + s.id + '">Restore</button>' +
        '<button class="btn ghost sm snap-del" data-snap-act="delete" data-id="' + s.id + '" aria-label="Delete snapshot">' +
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg></button></div></div>';
      if (compareId === s.id) {
        h += '<div class="delta-wrap"><table class="delta"><thead><tr><th>Channel</th>' +
          "<th>" + esc(s.name.split(" · ")[0]) + "</th><th>Current</th><th>Δ spend</th><th>Δ contribution</th></tr></thead><tbody>";
        cur.rows.forEach(function (r) {
          const old = p.rows.find(function (x) { return x.key === r.key; }) || { spend: 0, contrib: 0 };
          h += '<tr><td class="ch"><span class="dot" style="background:' + r.color + '"></span>' + esc(r.name) + "</td>" +
            "<td>" + old.spend.toFixed(1) + "</td><td>" + r.spend.toFixed(1) + "</td>" +
            "<td>" + deltaCell(r.spend - old.spend, function (v) { return v.toFixed(1); }, null) + "</td>" +
            "<td>" + deltaCell(r.contrib - old.contrib, function (v) { return fmtK(v); }, true) + "</td></tr>";
        });
        h += '<tr class="tot"><td class="ch">Total</td><td>' + p.spend.toFixed(0) + "</td><td>" + cur.spend.toFixed(0) + "</td>" +
          "<td>" + deltaCell(cur.spend - p.spend, function (v) { return fmtK(v); }, null) + "</td>" +
          "<td>" + deltaCell(cur.media - p.media, function (v) { return fmtK(v); }, true) + "</td></tr>";
        h += "</tbody></table>" +
          '<div class="delta-foot">Predicted revenue ' + fmtK(p.revenue) + " → <b>" + fmtK(cur.revenue) + "</b> " +
          deltaCell(cur.revenue - p.revenue, function (v) { return fmtK(v); }, true) +
          " · blended ROAS " + p.roas.toFixed(2) + "× → <b>" + cur.roas.toFixed(2) + "×</b></div></div>";
      }
    });
    body.innerHTML = h;
  }

  // ---- plan export -----------------------------------------------------
  function exportPlan() {
    const p = planNow();
    const lines = ["channel,spend_k,contribution_k,roas,marginal,beta,gamma,alpha,theta"];
    const chans = APP.getChannels();
    p.rows.forEach(function (r) {
      const c = chans.find(function (x) { return x.key === r.key; }) || {};
      lines.push([r.name, r.spend.toFixed(1), r.contrib.toFixed(1), r.roas.toFixed(3), r.marg.toFixed(3),
        c.beta, c.gamma, c.alpha, c.theta].join(","));
    });
    lines.push("");
    lines.push("baseline_k," + p.baseline.toFixed(1));
    lines.push("total_spend_k," + p.spend.toFixed(1));
    lines.push("media_revenue_k," + p.media.toFixed(1));
    lines.push("predicted_revenue_k," + p.revenue.toFixed(1));
    lines.push("blended_roas," + p.roas.toFixed(3));
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "mmm-plan.csv"; a.click();
    URL.revokeObjectURL(a.href);
    toast("Exported the current plan as <b>mmm-plan.csv</b>", "ok");
  }

  // ---- command palette -------------------------------------------------
  const ACTIONS = [
    { t: "Optimise allocation now", hint: "run the optimiser at the set budget", run: function () { APP.optimise(); toast("Optimiser finished — sliders moved to the optimal split", "ok"); go("#plan"); } },
    { t: "Save plan snapshot", hint: "store the current allocation for comparison", run: takeSnapshot },
    { t: "Open snapshots · compare plans", hint: "A/B compare saved allocations", run: openSnaps },
    { t: "Export plan as CSV", hint: "spend, contribution, ROAS and parameters", run: exportPlan },
    { t: "Toggle light / dark theme", hint: "switch the interface theme", run: function () { const b = document.querySelector("[data-theme-toggle]"); if (b) b.click(); } },
    { t: "Import CSV data", hint: "go to the drop zone", run: function () { go("#data"); } },
    { t: "Go to Plan", hint: "sliders, curves, table", run: function () { go("#plan"); } },
    { t: "Go to Analytics", hint: "custom KPIs and the metric library", run: function () { go("#analytics"); } },
    { t: "Go to Scenario", hint: "budget-response frontier", run: function () { go("#scenario"); } },
    { t: "Go to Parameters", hint: "edit β γ α θ, import / export", run: function () { go("#params"); } },
    { t: "Add metrics from the KPI library", hint: "open the metric picker", run: function () { go("#analytics"); const b = document.getElementById("libToggle"); if (b && document.getElementById("kpiLibrary").hidden) b.click(); } },
    { t: "Download params.json", hint: "export the fitted parameters", run: function () { const b = document.getElementById("exportBtn"); if (b) b.click(); } },
    { t: "Reset everything", hint: "back to the fitted defaults", run: function () { const b = document.getElementById("resetBtn"); if (b) b.click(); toast("Planner reset to defaults", "info"); } }
  ];
  function go(sel) { const n = document.querySelector(sel); if (n) n.scrollIntoView({ behavior: "smooth", block: "start" }); }

  const pal = el(
    '<div class="cmdk-backdrop" hidden role="dialog" aria-modal="true" aria-label="Command palette">' +
    '<div class="cmdk"><div class="cmdk-inputwrap">' +
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>' +
    '<input class="cmdk-input" placeholder="Type a command…" aria-label="Search commands" />' +
    '<kbd class="cmdk-esc">esc</kbd></div>' +
    '<div class="cmdk-list" role="listbox"></div></div></div>'
  );
  document.body.appendChild(pal);
  const palInput = pal.querySelector(".cmdk-input");
  const palList = pal.querySelector(".cmdk-list");
  let palSel = 0, palItems = [], lastFocus = null;

  function score(q, t) {
    t = t.toLowerCase();
    if (!q) return 1;
    const ix = t.indexOf(q);
    if (ix >= 0) return 100 - ix;
    // subsequence
    let i = 0;
    for (let j = 0; j < t.length && i < q.length; j++) if (t[j] === q[i]) i++;
    return i === q.length ? 10 : -1;
  }
  function renderPal() {
    const q = palInput.value.trim().toLowerCase();
    palItems = ACTIONS
      .map(function (a) { return { a: a, s: score(q, a.t + " " + a.hint) }; })
      .filter(function (x) { return x.s >= 0; })
      .sort(function (x, y) { return y.s - x.s; })
      .map(function (x) { return x.a; });
    palSel = Math.min(palSel, Math.max(0, palItems.length - 1));
    palList.innerHTML = palItems.length
      ? palItems.map(function (a, i) {
        return '<div class="cmdk-item' + (i === palSel ? " sel" : "") + '" role="option" aria-selected="' + (i === palSel) + '" data-i="' + i + '">' +
          "<span>" + esc(a.t) + "</span><small>" + esc(a.hint) + "</small></div>";
      }).join("")
      : '<div class="cmdk-none">No matching command</div>';
  }
  function openPal() {
    lastFocus = document.activeElement;
    pal.hidden = false; palInput.value = ""; palSel = 0; renderPal();
    palInput.focus();
  }
  function closePal() {
    pal.hidden = true;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  function runSel() {
    const a = palItems[palSel];
    if (!a) return;
    closePal();
    a.run();
  }
  palInput.addEventListener("input", function () { palSel = 0; renderPal(); });
  palInput.addEventListener("keydown", function (e) {
    if (e.key === "ArrowDown") { e.preventDefault(); palSel = Math.min(palSel + 1, palItems.length - 1); renderPal(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); palSel = Math.max(palSel - 1, 0); renderPal(); }
    else if (e.key === "Enter") { e.preventDefault(); runSel(); }
  });
  palList.addEventListener("click", function (e) {
    const it = e.target.closest(".cmdk-item");
    if (it) { palSel = +it.dataset.i; runSel(); }
  });
  pal.addEventListener("click", function (e) { if (e.target === pal) closePal(); });

  window.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      if (pal.hidden) openPal(); else closePal();
    } else if (e.key === "Escape") {
      if (!pal.hidden) closePal();
      else if (!snapModal.hidden) closeSnaps();
    }
  });

  // ---- discoverability: nav chip + controls button ---------------------
  const navInner = document.querySelector(".nav-inner");
  if (navInner) {
    const chip = el('<button class="cmdk-chip" title="Command palette (' + KBD + ')" aria-label="Open command palette">' +
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>' +
      "<kbd>" + KBD + "</kbd></button>");
    chip.addEventListener("click", openPal);
    navInner.insertBefore(chip, navInner.querySelector(".theme-toggle"));
  }
  const optBtn = document.getElementById("optBtn");
  if (optBtn) {
    const row = el('<div class="snapbar"><button class="btn ghost sm" id="snapSaveBtn">Save snapshot</button>' +
      '<button class="btn ghost sm" id="snapOpenBtn">Compare plans…</button></div>');
    optBtn.parentNode.insertBefore(row, optBtn.nextSibling);
    row.querySelector("#snapSaveBtn").addEventListener("click", takeSnapshot);
    row.querySelector("#snapOpenBtn").addEventListener("click", openSnaps);
  }

  window.PRO = { toast: toast, openPalette: openPal, openSnapshots: openSnaps, exportPlan: exportPlan, takeSnapshot: takeSnapshot };
})();
