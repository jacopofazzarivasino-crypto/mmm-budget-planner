/* =========================================================================
 * luxe.js — premium interactive layer:
 *   1) generative hero canvas (flowing response-curve ribbons)
 *   2) cursor-reactive spotlight over the hero
 *   3) 3D tilt + glare on KPI cards
 *   4) magnetic primary CTA
 * All effects respect prefers-reduced-motion and only run on fine pointers.
 * ========================================================================= */
(function () {
  "use strict";

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const fine = window.matchMedia("(hover: hover) and (pointer: fine)").matches;

  /* ---- 1) hero ribbons ------------------------------------------------ */
  (function ribbons() {
    const canvas = document.getElementById("heroCanvas");
    const landing = document.getElementById("landing");
    if (!canvas || !landing) return;
    const ctx = canvas.getContext("2d");

    const COLORS = ["#4C7EF3", "#17A08C", "#7C5CE6", "#2E9BC4"];
    let W = 0, H = 0, dpr = 1, raf = null, t = 0, visible = true;
    let light = document.documentElement.getAttribute("data-theme") === "light";
    const lines = [];

    function build() {
      lines.length = 0;
      const n = 5;
      for (let i = 0; i < n; i++) {
        lines.push({
          color: COLORS[i % COLORS.length],
          amp: 26 + Math.random() * 46,
          freq: 0.7 + Math.random() * 1.1,
          phase: Math.random() * Math.PI * 2,
          speed: 0.12 + Math.random() * 0.16,
          yBase: 0.30 + (i / n) * 0.5,
          width: 1.2 + Math.random() * 1.6,
          alpha: 0.5
        });
      }
    }
    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = landing.clientWidth; H = landing.clientHeight;
      canvas.width = W * dpr; canvas.height = H * dpr;
      canvas.style.width = W + "px"; canvas.style.height = H + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function draw() {
      ctx.clearRect(0, 0, W, H);
      ctx.globalCompositeOperation = light ? "source-over" : "lighter";
      const lineAlpha = light ? 0.24 : 0.5;
      const steps = 56;
      for (let li = 0; li < lines.length; li++) {
        const L = lines[li];
        const yb = L.yBase * H;
        ctx.beginPath();
        for (let s = 0; s <= steps; s++) {
          const x = (s / steps) * W;
          // two stacked sines + a soft saturation envelope = "response curve" drift
          const env = 0.55 + 0.45 * Math.sin((s / steps) * Math.PI);
          const y = yb +
            Math.sin((s / steps) * L.freq * Math.PI * 2 + L.phase + t * L.speed) * L.amp * env +
            Math.sin((s / steps) * L.freq * 3.3 + t * L.speed * 0.6) * (L.amp * 0.25);
          if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        const grad = ctx.createLinearGradient(0, 0, W, 0);
        grad.addColorStop(0, "rgba(0,0,0,0)");
        grad.addColorStop(0.5, hexA(L.color, lineAlpha));
        grad.addColorStop(1, "rgba(0,0,0,0)");
        ctx.strokeStyle = grad;
        ctx.lineWidth = L.width;
        ctx.stroke();
      }
      ctx.globalCompositeOperation = "source-over";
    }

    function loop() {
      t += 0.016;
      draw();
      raf = requestAnimationFrame(loop);
    }
    function start() { if (!raf && visible && !reduced) loop(); }
    function stop() { if (raf) { cancelAnimationFrame(raf); raf = null; } }

    function hexA(hex, a) {
      hex = hex.replace("#", "");
      const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
      return "rgba(" + r + "," + g + "," + b + "," + a + ")";
    }

    build(); resize(); draw();
    let rz;
    window.addEventListener("resize", function () { clearTimeout(rz); rz = setTimeout(function () { resize(); draw(); }, 150); });

    // only animate while the hero is on screen
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (es) {
        visible = es[0].isIntersecting;
        if (visible) start(); else stop();
      }, { threshold: 0.02 }).observe(landing);
    }
    document.addEventListener("visibilitychange", function () { if (document.hidden) stop(); else start(); });
    window.addEventListener("themechange", function (e) { light = e.detail.theme === "light"; draw(); });
    start();
  })();

  /* ---- 2) cursor spotlight over the hero ------------------------------ */
  (function spotlight() {
    const landing = document.getElementById("landing");
    const spot = document.getElementById("heroSpot");
    if (!landing || !spot || !fine || reduced) return;
    let tx = 0, ty = 0, cx = 0, cy = 0, raf = null;
    landing.addEventListener("pointermove", function (e) {
      const r = landing.getBoundingClientRect();
      tx = e.clientX - r.left; ty = e.clientY - r.top;
      spot.style.opacity = "1";
      if (!raf) raf = requestAnimationFrame(follow);
    });
    landing.addEventListener("pointerleave", function () { spot.style.opacity = "0"; });
    function follow() {
      cx += (tx - cx) * 0.12; cy += (ty - cy) * 0.12;
      spot.style.transform = "translate(" + cx + "px," + cy + "px)";
      if (Math.abs(tx - cx) > 0.5 || Math.abs(ty - cy) > 0.5) raf = requestAnimationFrame(follow);
      else raf = null;
    }
  })();

  /* ---- 3) 3D tilt + glare on KPI cards -------------------------------- */
  (function tilt() {
    if (!fine || reduced) return;
    function bind(grid) {
      grid.addEventListener("pointermove", function (e) {
        const card = e.target.closest(".kpi");
        grid.querySelectorAll(".kpi.tilting").forEach(function (c) { if (c !== card) clear(c); });
        if (!card || !grid.contains(card)) return;
        const r = card.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
        card.style.setProperty("--rx", ((0.5 - py) * 7).toFixed(2) + "deg");
        card.style.setProperty("--ry", ((px - 0.5) * 7).toFixed(2) + "deg");
        card.style.setProperty("--gx", (px * 100).toFixed(1) + "%");
        card.style.setProperty("--gy", (py * 100).toFixed(1) + "%");
        card.classList.add("tilting");
      });
      grid.addEventListener("pointerleave", function () {
        grid.querySelectorAll(".kpi.tilting").forEach(clear);
      });
    }
    function clear(c) {
      c.classList.remove("tilting");
      c.style.removeProperty("--rx"); c.style.removeProperty("--ry");
    }
    document.querySelectorAll(".kgrid").forEach(bind);
  })();

  /* ---- 4) magnetic primary CTA ---------------------------------------- */
  (function magnetic() {
    if (!fine || reduced) return;
    document.querySelectorAll(".magnetic").forEach(function (btn) {
      btn.addEventListener("pointermove", function (e) {
        const r = btn.getBoundingClientRect();
        const dx = (e.clientX - (r.left + r.width / 2)) / r.width;
        const dy = (e.clientY - (r.top + r.height / 2)) / r.height;
        btn.style.transform = "translate(" + (dx * 14).toFixed(1) + "px," + (dy * 14).toFixed(1) + "px)";
      });
      btn.addEventListener("pointerleave", function () { btn.style.transform = ""; });
    });
  })();
})();
