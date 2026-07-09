# Media Mix Model — Budget Planner

An interactive planning tool built on a fitted Bayesian Media Mix Model. Set the weekly
spend per channel and watch contribution, ROAS, the saturation response curves, the optimal
budget split and the budget-response scenario update **in real time** — everything runs
client-side, so there is no server round-trip and no lag.

It is the decision layer of the wider MMM project: the notebook fits the model and exports
`params.json`, and this app consumes that file.

### Files

```
index.html              the dashboard edition (dark, glassy)
assets/css/styles.css   design system
assets/js/model.js      MMM maths (Hill response, projected-gradient optimiser)
assets/js/kpis.js       library of marketing KPIs (one entry per metric)
assets/js/csv.js        CSV import: parse, auto-detect, analyse, calibrate
assets/js/pro.js        command palette, snapshots/compare, toasts, plan export
assets/js/charts.js     dependency-free SVG charts
assets/js/app.js        state, interaction, rendering (+ window.MMM_APP API)
assets/js/luxe.js       hero canvas, cursor spotlight, card tilt
```

## What it does

- **Live KPIs** — predicted revenue, media-driven revenue, baseline, and blended ROAS, with
  animated counters.
- **Custom analytics** — a built-in library of 17 marketing KPIs (efficiency, saturation,
  allocation, growth, risk) that you pin to your dashboard. Search the library, add or remove
  metrics, and your selection is saved. Optimiser-backed metrics (e.g. reallocation upside,
  breakeven budget) recompute on a debounce. New built-in metrics are one entry in
  `assets/js/kpis.js`.
- **Build your own metric** — define a KPI from a formula right in the UI. Reference model
  variables (`media`, `totSpend`, `roas`, `tv.contrib`, …) and helpers (`sum`, `avg`, `max`,
  `min`, `count`, `Math.*`), choose a unit (€k / % / ×), and watch a live preview as you type.
  Saved metrics persist, appear in the library, and can be pinned or deleted like any other.
  Examples: `media / totSpend`, `100 * tv.contrib / media`, `count(c => c.marg < 1)`.
- **Command palette** — press **Ctrl+K** (⌘K on Mac) for fuzzy-searchable actions: optimise,
  save/compare snapshots, export, jump to sections, toggle theme.
- **Plan snapshots & A/B compare** — save any allocation, keep working, then compare it against
  the current plan in a per-channel delta table (Δ spend, Δ contribution, revenue and ROAS
  before/after). Restore any snapshot in one click. Up to 12 are kept in the browser.
- **Click-to-optimise frontier** — click any point on the scenario revenue curve to apply that
  total budget optimally; the sliders animate to the new split.
- **Plan export** — one command exports the full plan (spend, contribution, ROAS, marginal,
  parameters, totals) as `mmm-plan.csv`.
- **CSV import** — drag a CSV anywhere onto the page (or into the Data panel). The engine
  auto-detects the shape (spend-by-channel columns, a per-channel snapshot, or long
  transaction rows), matches your columns to channels (with synonyms like Facebook→Social),
  guesses the unit scale (€ → €k), and shows an expenditure breakdown + spend-over-time trend.
  You then choose any of: **load spend** into the planner, **optimise**, and/or **calibrate**
  the response curves (β/γ) from your spend+revenue history — an approximate, regularised
  least-squares fit with an R² readout (not a substitute for the full Bayesian fit).
- **Saturation curves** — the fitted response per channel with your current operating point
  marked. Drag the point (or the slider) and everything re-renders instantly.
- **Contribution & efficiency table** — spend, contribution, ROAS, marginal return and share
  of media per channel.
- **Optimise a budget** — reallocate any total budget so the marginal return is equalised
  across funded channels (the optimality condition); the sliders animate to the result.
- **Budget-response scenario** — optimal incremental revenue and the marginal euro as the
  total budget grows, with the €1 breakeven flagged.
- **Parameters** — edit the fitted `β / γ / α / θ` in place, upload or paste your own
  `params.json`, or download the current set. Your session is saved in the browser.

The optimiser is a monotone-safe multi-start projected-gradient ascent, needed because the
Hill response is S-shaped (non-concave) for `alpha > 1`, so naive allocation gets stuck in
local optima.

## Reproducibility & tests

- **The optimiser is deterministic.** Its random restarts use a seeded PRNG (seed 0 by
  default, matching the legacy Python edition), so identical inputs give byte-identical
  allocations, marginal returns and breakeven — run after run, session after session.
- **Breakeven has a fixed 15 €k resolution**, independent of how wide the plotted budget
  range is (a coarse scan is refined back to 15 €k).
- **Calibration reports identifiability.** Channels whose spend is (near-)constant across
  the uploaded history are excluded from the fit and reported explicitly — constant spend
  cannot be distinguished from baseline, and "not identifiable" is not the same statement
  as "produces no revenue". Weakly-varying channels are fitted but flagged.
- **Automated test suite:** `node tests/run-tests.mjs` verifies the Hill identity
  (hill(γ)=β/2), simplex projection (budget conservation, non-negativity), optimiser
  budget conservation + reproducibility, revenue monotonicity in the budget, the KPI
  library against independently computed values, and the calibration behaviour on two
  adversarial fixtures (a constant-spend channel and a perfectly collinear pair).
  `tests/goldens.json` pins the optimiser's outputs so any silent change in the maths
  fails the suite.
- **Source of truth:** `assets/js/model.js`. The legacy Streamlit `app.py` implements the
  same maths in Python; it is kept for reference and is not maintained in lockstep — the
  golden test guards the JS side against drift.

## Load your own model

Export `params.json` from the notebook, then in the **Parameters** section upload it, paste
the array, or replace `params.json` in the repo. The four numbers per channel are:

- `beta` — ceiling, the most a channel can contribute
- `gamma` — half-saturation spend
- `alpha` — shape (1 = concave, >1 = S-shaped with a threshold)
- `theta` — carryover retention (memory)

## Note on the steady-state assumption

The planner assumes spend is held constant week over week. Under that assumption the
normalised geometric adstock settles to the spend level itself, so the steady-state
contribution of a channel is the Hill response of its weekly spend. The optimiser and
scenario maximise total contribution subject to total spend not exceeding the budget.
