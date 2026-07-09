/* =========================================================================
 * charts.js — lightweight, dependency-free SVG charts with smooth updates.
 * Exposes window.Charts: ResponseCurves and ScenarioChart.
 * ========================================================================= */
(function (global) {
  "use strict";

  const SVGNS = "http://www.w3.org/2000/svg";
  const hill = function (s, p) { return global.MMM.hill(s, p); };

  function el(tag, attrs, parent) {
    const n = document.createElementNS(SVGNS, tag);
    if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function hexToRgba(hex, a) {
    hex = hex.replace("#", "");
    const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
    return "rgba(" + r + "," + g + "," + b + "," + a + ")";
  }

  // "nice" tick values for an axis spanning [0, max].
  function niceTicks(max, count) {
    count = count || 4;
    const raw = max / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    let step;
    if (norm < 1.5) step = 1; else if (norm < 3) step = 2; else if (norm < 7) step = 5; else step = 10;
    step *= mag;
    const ticks = [];
    for (let v = 0; v <= max + 1e-9; v += step) ticks.push(v);
    return ticks;
  }

  function smoothPath(pts) {
    // Catmull-Rom -> cubic bezier for a silky curve through the points.
    if (pts.length < 2) return "";
    let d = "M" + pts[0][0].toFixed(2) + "," + pts[0][1].toFixed(2);
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] || p2;
      const c1x = p1[0] + (p2[0] - p0[0]) / 6;
      const c1y = p1[1] + (p2[1] - p0[1]) / 6;
      const c2x = p2[0] - (p3[0] - p1[0]) / 6;
      const c2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += "C" + c1x.toFixed(2) + "," + c1y.toFixed(2) + " " +
        c2x.toFixed(2) + "," + c2y.toFixed(2) + " " +
        p2[0].toFixed(2) + "," + p2[1].toFixed(2);
    }
    return d;
  }

  /* ---------------------------------------------------------------------
   * ResponseCurves — one mini interactive card per channel.
   * handlers.onDrag(key, spend) fires while dragging the operating point.
   * ------------------------------------------------------------------- */
  function ResponseCurves(container, handlers) {
    this.container = container;
    this.handlers = handlers || {};
    this.cards = {};      // key -> card refs
    this.smax = 110;
    this.maxY = 1;
  }

  ResponseCurves.prototype.build = function (channels, spends) {
    const self = this;
    this.container.innerHTML = "";
    this.cards = {};

    let smax = 110, maxY = 1;
    channels.forEach(function (c) { smax = Math.max(smax, spends[c.key] * 1.3); });
    channels.forEach(function (c) { maxY = Math.max(maxY, hill(smax, c)); });
    this.smax = smax; this.maxY = maxY;

    const VB_W = 300, VB_H = 150, PAD_L = 8, PAD_R = 8, PAD_T = 14, PAD_B = 22;
    const plotW = VB_W - PAD_L - PAD_R, plotH = VB_H - PAD_T - PAD_B;

    channels.forEach(function (c) {
      const card = document.createElement("div");
      card.className = "curve-card";

      const head = document.createElement("div");
      head.className = "curve-head";
      head.innerHTML =
        '<div class="curve-name"><span class="dot" style="background:' + c.color + '"></span>' + c.name + '</div>' +
        '<div class="curve-val" data-val></div>';
      card.appendChild(head);

      const svg = el("svg", { viewBox: "0 0 " + VB_W + " " + VB_H, class: "curve-svg", preserveAspectRatio: "none" });
      const gid = "grad-" + c.key;
      const defs = el("defs", null, svg);
      const lg = el("linearGradient", { id: gid, x1: "0", y1: "0", x2: "0", y2: "1" }, defs);
      el("stop", { offset: "0%", "stop-color": c.color, "stop-opacity": "0.34" }, lg);
      el("stop", { offset: "100%", "stop-color": c.color, "stop-opacity": "0" }, lg);

      // baseline axis
      el("line", { x1: PAD_L, y1: PAD_T + plotH, x2: PAD_L + plotW, y2: PAD_T + plotH, class: "axis-base" }, svg);

      const area = el("path", { fill: "url(#" + gid + ")", stroke: "none", class: "curve-area" }, svg);
      const line = el("path", { fill: "none", stroke: c.color, "stroke-width": "2.4", "stroke-linecap": "round", class: "curve-line" }, svg);
      const vline = el("line", { stroke: c.color, "stroke-width": "1.2", "stroke-dasharray": "2 3", opacity: "0.6" }, svg);
      const hit = el("rect", { x: PAD_L, y: PAD_T, width: plotW, height: plotH, fill: "transparent", class: "curve-hit" }, svg);
      const dot = el("circle", { r: "5.5", fill: "#0a0f1b", stroke: c.color, "stroke-width": "2.6", class: "curve-dot" }, svg);

      card.appendChild(svg);

      const foot = document.createElement("div");
      foot.className = "curve-foot";
      foot.innerHTML = '<span data-foot-spend></span><span data-foot-roas></span><span data-foot-marg></span>';
      card.appendChild(foot);

      self.container.appendChild(card);

      const refs = {
        ch: c, svg: svg, area: area, line: line, vline: vline, dot: dot, hit: hit,
        valEl: head.querySelector("[data-val]"),
        footSpend: foot.querySelector("[data-foot-spend]"),
        footRoas: foot.querySelector("[data-foot-roas]"),
        footMarg: foot.querySelector("[data-foot-marg]"),
        geom: { PAD_L: PAD_L, PAD_T: PAD_T, plotW: plotW, plotH: plotH }
      };
      self.cards[c.key] = refs;

      // draw static curve
      const N = 64, pts = [];
      for (let i = 0; i <= N; i++) {
        const s = (smax * i) / N;
        const x = PAD_L + (s / smax) * plotW;
        const y = PAD_T + plotH - (hill(s, c) / maxY) * plotH;
        pts.push([x, y]);
      }
      const d = smoothPath(pts);
      line.setAttribute("d", d);
      area.setAttribute("d", d + " L" + (PAD_L + plotW) + "," + (PAD_T + plotH) + " L" + PAD_L + "," + (PAD_T + plotH) + " Z");

      // animate draw-in
      const len = line.getTotalLength();
      line.style.strokeDasharray = len;
      line.style.strokeDashoffset = len;
      requestAnimationFrame(function () {
        line.style.transition = "stroke-dashoffset .9s cubic-bezier(.2,.7,.2,1)";
        line.style.strokeDashoffset = "0";
      });

      // interaction
      function pointToSpend(ev) {
        const r = svg.getBoundingClientRect();
        const px = ((ev.clientX - r.left) / r.width) * VB_W;
        const frac = clamp((px - PAD_L) / plotW, 0, 1);
        return frac * smax;
      }
      let dragging = false;
      function down(ev) { dragging = true; svg.classList.add("dragging"); move(ev); ev.preventDefault(); }
      function move(ev) {
        if (!dragging) return;
        const s = pointToSpend(ev.touches ? ev.touches[0] : ev);
        if (self.handlers.onDrag) self.handlers.onDrag(c.key, Math.round(s * 2) / 2);
      }
      function up() { dragging = false; svg.classList.remove("dragging"); }
      svg.addEventListener("mousedown", down);
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
      svg.addEventListener("touchstart", down, { passive: false });
      window.addEventListener("touchmove", function (e) { if (dragging) { e.preventDefault(); move(e); } }, { passive: false });
      window.addEventListener("touchend", up);
    });
  };

  // Move just the operating point / readouts — cheap, runs on every slider tick.
  ResponseCurves.prototype.setPoint = function (key, spend, contrib, roas, marg) {
    const r = this.cards[key];
    if (!r) return;
    const g = r.geom;
    const x = g.PAD_L + (clamp(spend, 0, this.smax) / this.smax) * g.plotW;
    const y = g.PAD_T + g.plotH - (hill(spend, r.ch) / this.maxY) * g.plotH;
    r.dot.setAttribute("cx", x.toFixed(2));
    r.dot.setAttribute("cy", y.toFixed(2));
    r.vline.setAttribute("x1", x.toFixed(2));
    r.vline.setAttribute("x2", x.toFixed(2));
    r.vline.setAttribute("y1", (g.PAD_T + g.plotH).toFixed(2));
    r.vline.setAttribute("y2", y.toFixed(2));
    r.valEl.textContent = "€" + Math.round(contrib) + "k";
    r.footSpend.innerHTML = "spend <b>€" + spend.toFixed(1) + "k</b>";
    r.footRoas.innerHTML = "roas <b>" + roas.toFixed(2) + "×</b>";
    const cls = marg >= 1 ? "ok" : "warn";
    r.footMarg.innerHTML = 'marg <b class="' + cls + '">' + marg.toFixed(2) + "</b>";
  };

  /* ---------------------------------------------------------------------
   * ScenarioChart — a full line chart with axes, gridlines, marker, tooltip.
   * ------------------------------------------------------------------- */
  function ScenarioChart(svgEl, opts) {
    this.svg = svgEl;
    this.opts = opts || {};
    this.VB_W = this.opts.vbW || 520; this.VB_H = this.opts.vbH || 300;
    this.PAD_L = 46; this.PAD_R = 18; this.PAD_T = 16; this.PAD_B = 34;
  }

  ScenarioChart.prototype.render = function (cfg) {
    // cfg: { xs, ys, color, yFmt, xLabel, yLabel, markerX, markerY, hline, fill }
    const svg = this.svg;
    svg.innerHTML = "";
    svg.setAttribute("viewBox", "0 0 " + this.VB_W + " " + this.VB_H);
    svg.setAttribute("preserveAspectRatio", "none");
    const PAD_L = this.PAD_L, PAD_R = this.PAD_R, PAD_T = this.PAD_T, PAD_B = this.PAD_B;
    const W = this.VB_W, H = this.VB_H;
    const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;

    const xs = cfg.xs, ys = cfg.ys;
    const xRaw = Math.max.apply(null, xs);
    const xMax = xRaw * 1.045;   // breathing room so the curve end / marker sit inside
    let yMax = Math.max.apply(null, ys);
    if (cfg.hline != null) yMax = Math.max(yMax, cfg.hline * 1.15);
    yMax = yMax * 1.08 || 1;

    const X = function (v) { return PAD_L + (v / xMax) * plotW; };
    const Y = function (v) { return PAD_T + plotH - (v / yMax) * plotH; };
    this._X = X; this._Y = Y; this._xMax = xMax;
    this._mbounds = { lo: PAD_L + 22, hi: PAD_L + plotW - 22, top: PAD_T, bot: PAD_T + plotH };

    const defs = el("defs", null, svg);
    const gid = "sgrad-" + Math.random().toString(36).slice(2, 7);
    const lg = el("linearGradient", { id: gid, x1: "0", y1: "0", x2: "0", y2: "1" }, defs);
    el("stop", { offset: "0%", "stop-color": cfg.color, "stop-opacity": "0.22" }, lg);
    el("stop", { offset: "100%", "stop-color": cfg.color, "stop-opacity": "0" }, lg);

    // gridlines + y ticks
    const yticks = niceTicks(yMax, 4);
    yticks.forEach(function (t) {
      const y = Y(t);
      el("line", { x1: PAD_L, y1: y, x2: PAD_L + plotW, y2: y, class: "grid" }, svg);
      const lbl = el("text", { x: PAD_L - 8, y: y + 3.5, class: "axis-lbl", "text-anchor": "end" }, svg);
      lbl.textContent = cfg.yFmt ? cfg.yFmt(t) : Math.round(t);
    });
    // x ticks
    const xticks = niceTicks(xRaw, 5);
    xticks.forEach(function (t) {
      const x = X(t);
      const lbl = el("text", { x: x, y: PAD_T + plotH + 16, class: "axis-lbl", "text-anchor": "middle" }, svg);
      lbl.textContent = Math.round(t);
    });
    // axis titles
    if (cfg.xLabel) {
      const xl = el("text", { x: PAD_L + plotW / 2, y: H - 4, class: "axis-title", "text-anchor": "middle" }, svg);
      xl.textContent = cfg.xLabel;
    }

    // build curve
    const pts = xs.map(function (x, i) { return [X(x), Y(ys[i])]; });
    const d = smoothPath(pts);
    if (cfg.fill !== false) {
      el("path", { d: d + " L" + X(xRaw) + "," + (PAD_T + plotH) + " L" + X(0) + "," + (PAD_T + plotH) + " Z", fill: "url(#" + gid + ")" }, svg);
    }
    const line = el("path", { d: d, fill: "none", stroke: cfg.color, "stroke-width": "2.6", "stroke-linecap": "round", "stroke-linejoin": "round" }, svg);

    // threshold horizontal line
    if (cfg.hline != null) {
      const yh = Y(cfg.hline);
      el("line", { x1: PAD_L, y1: yh, x2: PAD_L + plotW, y2: yh, class: "threshold" }, svg);
      const tl = el("text", { x: PAD_L + plotW - 2, y: yh - 5, class: "axis-lbl", "text-anchor": "end", fill: "#e0728a" }, svg);
      tl.textContent = "€1 breakeven";
    }

    // current marker (vertical guide + dot) — refs kept for cheap updates
    this._marker = null;
    if (cfg.markerX != null) {
      const mLine = el("line", { class: "marker-line" }, svg);
      const mDot = el("circle", { r: "5", fill: "#e8edf7", stroke: cfg.color, "stroke-width": "2.4", class: "marker-dot" }, svg);
      const mTag = el("text", { class: "marker-tag", "text-anchor": "middle" }, svg);
      mTag.textContent = "now";
      this._marker = { line: mLine, dot: mDot, tag: mTag };
      this.setMarker(cfg.markerX, cfg.markerY);
    }

    // animate line draw-in (skip on lightweight refreshes or when the chart
    // is inside a closed <details> and not rendered yet)
    if (cfg.animate !== false) {
      try {
        const len = line.getTotalLength();
        line.style.strokeDasharray = len;
        line.style.strokeDashoffset = len;
        requestAnimationFrame(function () {
          line.style.transition = "stroke-dashoffset 1s cubic-bezier(.2,.7,.2,1)";
          line.style.strokeDashoffset = "0";
        });
      } catch (e) { /* not rendered — draw statically */ }
    }

    // hover tooltip
    const focus = el("circle", { r: "4.5", fill: cfg.color, stroke: "#0a0f1b", "stroke-width": "2", opacity: "0", class: "focus-dot" }, svg);
    const vline = el("line", { class: "focus-line", opacity: "0", y1: PAD_T, y2: PAD_T + plotH }, svg);
    const tip = this.opts.tooltip;
    const hit = el("rect", { x: PAD_L, y: PAD_T, width: plotW, height: plotH, fill: "transparent" }, svg);
    if (cfg.onClick) {
      hit.style.cursor = "pointer";
      hit.addEventListener("click", function (ev) {
        const r = svg.getBoundingClientRect();
        const px = ((ev.clientX - r.left) / r.width) * W;
        const xv = clamp(((px - PAD_L) / plotW) * xMax, 0, xMax);
        let bi = 0, bd = Infinity;
        for (let i = 0; i < xs.length; i++) { const dd = Math.abs(xs[i] - xv); if (dd < bd) { bd = dd; bi = i; } }
        cfg.onClick(xs[bi], ys[bi]);
      });
    }
    hit.addEventListener("mousemove", function (ev) {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      const xv = clamp(((px - PAD_L) / plotW) * xMax, 0, xMax);
      // nearest sample
      let bi = 0, bd = Infinity;
      for (let i = 0; i < xs.length; i++) { const dd = Math.abs(xs[i] - xv); if (dd < bd) { bd = dd; bi = i; } }
      const fx = X(xs[bi]), fy = Y(ys[bi]);
      focus.setAttribute("cx", fx); focus.setAttribute("cy", fy); focus.setAttribute("opacity", "1");
      vline.setAttribute("x1", fx); vline.setAttribute("x2", fx); vline.setAttribute("opacity", "1");
      if (tip) {
        tip.style.opacity = "1";
        tip.innerHTML = (cfg.tipFmt ? cfg.tipFmt(xs[bi], ys[bi]) : (xs[bi] + " → " + ys[bi]));
        const cr = tip.parentElement.getBoundingClientRect();
        tip.style.left = (ev.clientX - cr.left) + "px";
        tip.style.top = (ev.clientY - cr.top) + "px";
      }
    });
    hit.addEventListener("mouseleave", function () {
      focus.setAttribute("opacity", "0"); vline.setAttribute("opacity", "0");
      if (tip) tip.style.opacity = "0";
    });
  };

  // Reposition the "now" marker without rebuilding the chart.
  ScenarioChart.prototype.setMarker = function (xVal, yVal) {
    if (!this._marker || !this._X) return;
    const mx = this._X(clamp(xVal, 0, this._xMax));
    const my = yVal != null ? this._Y(yVal) : this._mbounds.bot;
    this._marker.line.setAttribute("x1", mx); this._marker.line.setAttribute("x2", mx);
    this._marker.line.setAttribute("y1", this._mbounds.top); this._marker.line.setAttribute("y2", this._mbounds.bot);
    this._marker.dot.setAttribute("cx", mx); this._marker.dot.setAttribute("cy", my);
    this._marker.tag.setAttribute("x", clamp(mx, this._mbounds.lo, this._mbounds.hi));
    this._marker.tag.setAttribute("y", this._mbounds.top + 10);
  };

  global.Charts = {
    ResponseCurves: ResponseCurves,
    ScenarioChart: ScenarioChart,
    hexToRgba: hexToRgba
  };
})(window);
