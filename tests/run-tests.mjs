/* =========================================================================
 * run-tests.mjs — automated verification of the MMM engine.
 *
 * Covers the properties from the structural-debug audit (July 2026):
 *   1. hill(gamma) = beta/2 exactly
 *   2. projSimplex: budget conservation + non-negativity (incl. negative inputs)
 *   3. optimise: allocation sums to budget
 *   4. optimise: REPRODUCIBLE — the audit's 8-run test, spread must be 0
 *   5. optimal revenue is monotone in the budget
 *   6. computeScenario: deterministic; breakeven at fixed 15 €k resolution,
 *      invariant to how wide the chart range is
 *   7. KPI library coherence against independently computed values
 *   8. fitModel: constant-spend channel EXCLUDED with a diagnostic
 *      (audit fixture: storico_canale_costante.csv, Display always 15 €k)
 *   9. fitModel: collinear channels stay stable, no explosion
 *      (audit fixture: storico_canali_collineari.csv, Social = 2 × Video)
 *  10. golden drift detector: pinned outputs in goldens.json catch any
 *      silent change in the maths between editions/refactors
 *
 * Run:  node tests/run-tests.mjs
 * ========================================================================= */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

/* ---- browser-global shims so the classic scripts load ---------------- */
global.window = globalThis;
global.document = {
  readyState: "complete",
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  createElement: () => ({ innerHTML: "", firstChild: null, appendChild: () => {} }),
  body: { appendChild: () => {} }
};
function load(f) { (0, eval)(readFileSync(join(root, "assets", "js", f), "utf8")); }
load("model.js");
load("kpis.js");
load("csv.js");
const M = globalThis.MMM, CSV = globalThis.CSV_ENGINE, LIB = globalThis.KPI_BY_ID;

/* ---- tiny harness ----------------------------------------------------- */
let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log("  ok  " + name); }
  else { fail++; console.log("FAIL  " + name + (detail ? "  →  " + detail : "")); }
}
function approx(a, b, tol) { return Math.abs(a - b) <= (tol == null ? 1e-9 : tol); }
const sum = (a) => a.reduce((x, y) => x + y, 0);

const PARAMS = [
  { key: "tv",      name: "TV",           beta: 320, gamma: 60, alpha: 1.5, theta: 0.65 },
  { key: "search",  name: "Paid Search",  beta: 140, gamma: 10, alpha: 1.0, theta: 0.05 },
  { key: "social",  name: "Paid Social",  beta: 200, gamma: 30, alpha: 1.3, theta: 0.30 },
  { key: "video",   name: "Online Video", beta: 170, gamma: 38, alpha: 1.4, theta: 0.45 },
  { key: "display", name: "Display",      beta: 90,  gamma: 22, alpha: 1.1, theta: 0.20 }
];

/* ===== 1 · Hill identity ================================================ */
console.log("\n[1] hill(gamma) = beta/2");
for (const p of PARAMS) ok(approx(M.hill(p.gamma, p), p.beta / 2, 1e-9), `${p.key}: hill(γ)=${(p.beta / 2)}`);

/* ===== 2 · simplex projection =========================================== */
console.log("\n[2] projSimplex: conservation + non-negativity");
const cases = [[1, 2, 3, 4, 5], [-3, 0.5, 10, -7, 2], [0, 0, 0], [120], [5, -5, 5, -5, 5, -5]];
for (const v of cases) {
  for (const B of [10, 120, 0.5]) {
    const x = M.projSimplex(v, B);
    ok(approx(sum(x), B, 1e-9) && x.every((c) => c >= 0),
      `proj([${v}], B=${B}) sums to B, all ≥ 0`, `sum=${sum(x)}`);
  }
}

/* ===== 3 · budget conservation of optimise ============================== */
console.log("\n[3] optimise conserves the budget");
for (const B of [40, 120, 240]) {
  const a = M.optimise(PARAMS, B, { restarts: 20, iters: 150 });
  ok(approx(sum(a), B, 1e-6) && a.every((c) => c >= 0), `optimise(B=${B}): Σalloc = ${B}`, `Σ=${sum(a)}`);
}

/* ===== 4 · reproducibility (the audit's §2.1 test, 8 runs) ============= */
console.log("\n[4] optimise is reproducible (8 identical runs @ B=120)");
const margs = [], revs = [], allocs = [];
for (let i = 0; i < 8; i++) {
  const a = M.optimise(PARAMS, 120);
  allocs.push(JSON.stringify(a));
  revs.push(M.totalContrib(a, PARAMS));
  margs.push(Math.max(...PARAMS.map((p, j) => M.marginal(a[j], p))));
}
const spread = Math.max(...margs) - Math.min(...margs);
ok(spread === 0, `max marginal return spread over 8 runs is exactly 0 (was ±9% in the audit)`, `spread=${spread}`);
ok(new Set(allocs).size === 1, "allocations byte-identical across runs");
ok(new Set(revs).size === 1, "optimised revenue identical across runs");

/* ===== 5 · revenue monotone in budget =================================== */
console.log("\n[5] optimal revenue is monotone in the budget");
let prev = -Infinity, monotone = true, seq = [];
for (let B = 30; B <= 300; B += 30) {
  const r = M.totalContrib(M.optimise(PARAMS, B, { restarts: 24, iters: 200 }), PARAMS);
  seq.push(r.toFixed(2));
  if (r < prev - 1e-6) monotone = false;
  prev = r;
}
ok(monotone, "revenue non-decreasing over budgets 30..300", seq.join(" → "));

/* ===== 6 · scenario determinism + fixed breakeven resolution =========== */
console.log("\n[6] computeScenario: deterministic, breakeven at fixed 15 €k resolution");
const s1 = M.computeScenario(PARAMS);
const s2 = M.computeScenario(PARAMS);
ok(JSON.stringify(s1.rev) === JSON.stringify(s2.rev) && s1.breakeven === s2.breakeven,
  `scenario identical across runs (breakeven=${s1.breakeven})`);
ok(s1.breakeven % 15 === 0, "breakeven is a multiple of 15 €k");
const sWide = M.computeScenario(PARAMS, { maxBudget: 1200 });
ok(sWide.breakeven === s1.breakeven,
  `breakeven invariant to chart range (default: ${s1.breakeven}, wide 1200: ${sWide.breakeven})`);

/* ===== 7 · KPI library coherence ======================================== */
console.log("\n[7] KPI library vs independent computation");
{
  const spends = { tv: 50, search: 14, social: 27, video: 21, display: 9 };
  const rows = PARAMS.map((p) => {
    const s = spends[p.key], y = M.hill(s, p);
    return { key: p.key, name: p.name, spend: s, contrib: y, roas: y / s, marg: M.marginal(s, p), gamma: p.gamma };
  });
  const media = sum(rows.map((r) => r.contrib));
  const totSpend = sum(rows.map((r) => r.spend));
  const baseline = 300, revenue = baseline + media;
  rows.forEach((r) => { r.sShare = r.spend / totSpend; r.cShare = r.contrib / media; });
  const ctx = {
    rows, n: rows.length, media, totSpend, baseline, revenue,
    roas: media / totSpend, pct: (100 * media) / revenue,
    sumBeta: sum(PARAMS.map((p) => p.beta)),
    spendWMarg: sum(rows.map((r) => r.marg * r.sShare)),
    bestMarg: Math.max(...rows.map((r) => r.marg)), bestMargName: "x", topChannel: "x",
    optRevenue: null, breakeven: 270
  };
  ok(approx(LIB.mroas.compute(ctx), ctx.spendWMarg), "mroas = spend-weighted marginal");
  ok(approx(LIB.cpir.compute(ctx), totSpend / media), "cpir = spend per € of media revenue");
  ok(approx(LIB.media_pct.compute(ctx), (100 * media) / revenue), "media share of revenue");
  ok(approx(LIB.hhi.compute(ctx), sum(rows.map((r) => r.sShare * r.sShare))), "HHI");
  ok(approx(LIB.eff_channels.compute(ctx), 1 / sum(rows.map((r) => r.sShare * r.sShare))), "effective channels = 1/HHI");
  ok(approx(LIB.headroom.compute(ctx), ctx.sumBeta - media), "headroom = Σβ − media");
  ok(approx(LIB.overspend.compute(ctx), sum(rows.filter((r) => r.marg < 1).map((r) => r.spend))), "sub-breakeven spend");
  ok(approx(LIB.misalloc.compute(ctx), 50 * sum(rows.map((r) => Math.abs(r.sShare - r.cShare)))), "allocation gap");
  const zeroCtx = Object.assign({}, ctx, { totSpend: 0, media: 0 });
  ok(LIB.cpir.compute(zeroCtx) === null, "cpir → null when media = 0 (no divide-by-zero)");
}

/* ===== 8 · calibration: constant-spend channel excluded ================= */
console.log("\n[8] fitModel excludes the non-identifiable constant channel (audit fixture)");
function fitFixture(file) {
  const parsed = CSV.parseCSV(readFileSync(join(__dirname, "fixtures", file), "utf8"));
  const map = CSV.autoDetect(parsed, PARAMS);
  const periods = CSV.buildPeriods(parsed, map, PARAMS);
  return CSV.fitModel(periods, map, PARAMS);
}
{
  const r = fitFixture("storico_canale_costante.csv");
  ok(!r.error, "fit runs without error", r.error);
  ok(r.excluded && r.excluded.some((e) => e.key === "display"),
    "Display (constant 15 €k) EXCLUDED as non-identifiable", JSON.stringify(r.excluded));
  ok(!r.keys.includes("display"), "Display not in the fitted set");
  ok(r.keys.length === 4, `the four varying channels are fitted (${r.keys.join(",")})`);
  ok(r.r2 > 0.5, `fit quality reasonable (R²=${r.r2.toFixed(3)})`);
}

/* ===== 9 · calibration: collinear channels stable ======================= */
console.log("\n[9] fitModel stable under perfect collinearity (audit fixture)");
{
  const runs = [fitFixture("storico_canali_collineari.csv"),
                fitFixture("storico_canali_collineari.csv"),
                fitFixture("storico_canali_collineari.csv")];
  ok(runs.every((r) => !r.error), "all runs complete");
  const sigs = runs.map((r) => JSON.stringify(r.params));
  ok(new Set(sigs).size === 1, "identical result across repeated fits (deterministic)");
  const r = runs[0];
  ok(r.r2 > 0.8, `R² coherent (${r.r2.toFixed(3)})`);
  ok(r.params.every((p) => isFinite(p.beta) && p.beta >= 0), "no explosion: all betas finite and ≥ 0");
  const soc = r.params.find((p) => p.key === "social"), vid = r.params.find((p) => p.key === "video");
  ok(soc && vid && soc.beta + vid.beta > 100 && soc.beta + vid.beta < 700,
    `collinear pair splits uncertainly but sanely (social ${soc.beta.toFixed(0)} + video ${vid.beta.toFixed(0)})`);
}

/* ===== 10 · golden drift detector ======================================= */
console.log("\n[10] golden values (drift detector between editions/refactors)");
{
  const a = M.optimise(PARAMS, 120);
  const golden = {
    alloc: a.map((x) => +x.toFixed(6)),
    rev: +M.totalContrib(a, PARAMS).toFixed(6),
    marg: +Math.max(...PARAMS.map((p, j) => M.marginal(a[j], p))).toFixed(6),
    breakeven: s1.breakeven
  };
  const gfile = join(__dirname, "goldens.json");
  if (!existsSync(gfile)) {
    writeFileSync(gfile, JSON.stringify(golden, null, 2));
    ok(true, "goldens recorded (first run) → tests/goldens.json");
  } else {
    const want = JSON.parse(readFileSync(gfile, "utf8"));
    ok(JSON.stringify(want) === JSON.stringify(golden),
      "outputs match pinned goldens — the maths has not drifted",
      "got " + JSON.stringify(golden) + " want " + JSON.stringify(want));
  }
}

/* ---- summary ----------------------------------------------------------- */
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
