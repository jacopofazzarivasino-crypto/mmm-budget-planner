"""
Media Mix Model -- Budget Planner  (premium edition)
====================================================
A serious, modern dashboard built on Streamlit with a custom HTML/CSS design
layer and Plotly visuals. Set weekly spend per channel and watch contribution,
ROAS, response curves, the optimal split, and the budget-response scenario
update live. Baseline (organic) revenue is user-adjustable.

Performance: the interactive core runs inside an st.fragment so moving a slider
reruns only that block, not the whole page, and the optimiser sweep behind the
scenario chart is cached on the parameter signature.

Run:     streamlit run app.py     (or: python -m streamlit run app.py)
Deploy:  push to GitHub, deploy on https://share.streamlit.io
"""

import json
import numpy as np
import pandas as pd
import streamlit as st
import plotly.graph_objects as go
from plotly.subplots import make_subplots

st.set_page_config(page_title="MMM Budget Planner", page_icon="◆",
                   layout="wide", initial_sidebar_state="expanded")

# ==========================================================================
# Defaults (notebook export shape). These are the simulated-data parameters.
# ==========================================================================
DEFAULT_PARAMS = [
    {"key": "tv",      "name": "TV",           "color": "#6C8CFF", "beta": 320, "gamma": 60, "alpha": 1.5, "theta": 0.65, "spend": 50.0},
    {"key": "search",  "name": "Paid Search",  "color": "#34D6A0", "beta": 140, "gamma": 10, "alpha": 1.0, "theta": 0.05, "spend": 14.0},
    {"key": "social",  "name": "Paid Social",  "color": "#B98AF0", "beta": 200, "gamma": 30, "alpha": 1.3, "theta": 0.30, "spend": 27.0},
    {"key": "video",   "name": "Online Video", "color": "#F0B84A", "beta": 170, "gamma": 38, "alpha": 1.4, "theta": 0.45, "spend": 21.0},
    {"key": "display", "name": "Display",      "color": "#4FCBD6", "beta": 90,  "gamma": 22, "alpha": 1.1, "theta": 0.20, "spend": 9.0},
]
DEFAULT_BASELINE = 300.0
SLIDER_MAX = 250.0

# ==========================================================================
# Model maths
# ==========================================================================
def hill(s, p):
    s = max(float(s), 1e-9)
    return p["beta"] * s ** p["alpha"] / (p["gamma"] ** p["alpha"] + s ** p["alpha"])

def hill_arr(s, p):
    s = np.maximum(np.asarray(s, float), 1e-9)
    return p["beta"] * s ** p["alpha"] / (p["gamma"] ** p["alpha"] + s ** p["alpha"])

def marginal(s, p, eps=1e-3):
    return (hill(s + eps, p) - hill(s, p)) / eps

def total_contrib(alloc, params):
    return float(sum(hill(v, params[i]) for i, v in enumerate(alloc)))

def proj_simplex(v, B):
    """Euclidean projection onto {x >= 0, sum = B} (Duchi et al. 2008)."""
    v = np.asarray(v, float)
    u = np.sort(v)[::-1]
    css, theta = 0.0, 0.0
    for j in range(len(v)):
        css += u[j]
        t = (css - B) / (j + 1)
        if u[j] - t > 0:
            theta = t
    return np.maximum(v - theta, 0.0)

def optimise(params, budget, current=None, restarts=60, iters=300, seed=0):
    """Maximise total Hill contribution s.t. total spend == budget.
    Monotone-safe multi-start projected-gradient ascent. Needed because the Hill
    response is non-concave for alpha>1, so naive allocation hits local optima."""
    n = len(params)
    if budget <= 0:
        return np.zeros(n)
    rng = np.random.default_rng(seed)
    best, bestv = None, -np.inf

    def keep(s):
        nonlocal best, bestv
        v = total_contrib(s, params)
        if v > bestv:
            bestv, best = v, s.copy()

    starts = []
    if current is not None:
        cur = np.asarray(current, float)
        starts.append(cur * budget / (cur.sum() or 1.0))
    starts.append(np.full(n, budget / n))
    for i in range(n):
        a = np.zeros(n); a[i] = budget; starts.append(a)
    while len(starts) < restarts:
        starts.append(rng.dirichlet(np.ones(n)) * budget)

    for s0 in starts:
        s = proj_simplex(s0, budget); keep(s)
        eta = max(budget, 40) / 8.0
        for it in range(iters):
            grad = np.array([marginal(s[i], params[i]) for i in range(n)])
            s = proj_simplex(s + eta * grad, budget); keep(s)
            if it % 80 == 79:
                eta *= 0.5
    return best

@st.cache_data(show_spinner=False)
def compute_scenario(params_sig):
    """Optimal incremental revenue and marginal return across total budgets.
    Cached on the parameter signature, so it recomputes only when params change."""
    params = [{"beta": b, "gamma": g, "alpha": a, "theta": t} for (b, g, a, t) in params_sig]
    budgets = list(range(15, 241, 15))
    rev, marg = [], []
    for B in budgets:
        a = optimise(params, B, restarts=14, iters=110)
        rev.append(total_contrib(a, params))
        marg.append(max(marginal(a[i], params[i]) for i in range(len(params))))
    breakeven = None
    for B in range(15, 421, 15):
        a = optimise(params, B, restarts=14, iters=110)
        if max(marginal(a[i], params[i]) for i in range(len(params))) < 1.0:
            breakeven = B
            break
    return budgets, rev, marg, breakeven

def hex_to_rgba(hx, a):
    hx = hx.lstrip("#")
    r, g, b = int(hx[0:2], 16), int(hx[2:4], 16), int(hx[4:6], 16)
    return f"rgba({r},{g},{b},{a})"

def style_dark(fig, height):
    fig.update_layout(template="plotly_dark", height=height,
                      margin=dict(l=6, r=6, t=30, b=6),
                      paper_bgcolor="rgba(0,0,0,0)", plot_bgcolor="rgba(0,0,0,0)",
                      font=dict(color="#aeb9d4", size=11, family="Inter"),
                      hoverlabel=dict(bgcolor="#121826", font_size=12, font_family="Inter"))
    fig.update_xaxes(showgrid=True, gridcolor="rgba(255,255,255,.06)", zeroline=False,
                     linecolor="rgba(255,255,255,.12)")
    fig.update_yaxes(showgrid=True, gridcolor="rgba(255,255,255,.06)", zeroline=False,
                     linecolor="rgba(255,255,255,.12)")
    fig.update_annotations(font=dict(color="#cdd7ec", size=12))
    return fig

# ==========================================================================
# Design layer (HTML / CSS)
# ==========================================================================
CSS = """
<style>
@import url('https://fonts.googleapis.com/css2?family=Roboto:ital,wght@0,100..900;1,100..900&display=swap');
:root{
 --bg:#080b14; --surface:#131a2a; --surface2:#0e1420; --border:rgba(255,255,255,.07);
 --text:#e8edf7; --muted:#8893ad; --accent:#6c8cff; --pos:#34d6a0; --neg:#ff7a7a;
}
html, body, [class*="css"], .stApp{font-family:'Inter',-apple-system,sans-serif;}
[data-testid="stAppViewContainer"]{
 background:
   radial-gradient(1100px 480px at 82% -8%, rgba(108,140,255,.12), transparent 60%),
   radial-gradient(820px 460px at -8% 2%, rgba(52,214,160,.07), transparent 55%),
   var(--bg);
}
[data-testid="stHeader"]{background:transparent;}
[data-testid="stSidebar"]{background:#0a0f1b; border-right:1px solid var(--border);}
[data-testid="stSidebar"] *{color:var(--text);}
#MainMenu, footer{visibility:hidden;}
.block-container{padding-top:1.0rem; padding-bottom:3rem; max-width:1320px;}
h1,h2,h3,h4{color:var(--text); letter-spacing:-.01em;}
hr{border-color:var(--border);}

/* hero */
.hero{position:relative; overflow:hidden; border:1px solid var(--border); border-radius:20px;
 padding:22px 26px; margin-bottom:16px;
 background:linear-gradient(135deg, rgba(20,27,43,.92), rgba(12,18,30,.66));}
.hero::after{content:""; position:absolute; right:-70px; top:-70px; width:260px; height:260px;
 background:radial-gradient(circle, rgba(108,140,255,.30), transparent 70%);}
.hero .eyebrow{font-size:11px; letter-spacing:.20em; text-transform:uppercase; color:var(--accent); font-weight:700;}
.hero h1{font-size:26px; font-weight:800; margin:7px 0 5px; color:var(--text);}
.hero p{color:var(--muted); margin:0; font-size:13.5px; max-width:760px; line-height:1.5;}
.badge{display:inline-block; padding:3px 11px; border-radius:30px; background:rgba(108,140,255,.14);
 color:#a9bcff; font-size:10.5px; font-weight:600; letter-spacing:.04em; margin-top:10px; border:1px solid rgba(108,140,255,.25);}

/* kpi cards */
.kgrid{display:grid; grid-template-columns:repeat(4,1fr); gap:13px; margin:4px 0 6px;}
.kpi{position:relative; background:linear-gradient(160deg, var(--surface), var(--surface2));
 border:1px solid var(--border); border-radius:16px; padding:15px 17px; box-shadow:0 14px 32px rgba(0,0,0,.32);}
.kpi::before{content:""; position:absolute; left:0; top:14px; bottom:14px; width:3px; border-radius:4px; background:rgba(255,255,255,.10);}
.kpi.accent::before{background:linear-gradient(180deg, var(--accent), #93a9ff);}
.kpi.green::before{background:linear-gradient(180deg, var(--pos), #6fe6bf);}
.klabel{font-size:10px; letter-spacing:.13em; text-transform:uppercase; color:var(--muted); font-weight:700;}
.kval{font-size:28px; font-weight:780; letter-spacing:-.02em; margin-top:4px; color:var(--text); font-variant-numeric:tabular-nums;}
.ksub{font-size:11.5px; color:var(--muted); margin-top:1px;}

/* section heading */
.sect{font-size:11px; letter-spacing:.15em; text-transform:uppercase; color:var(--muted); font-weight:700; margin:16px 2px 8px;}

/* contribution table */
.ctable{width:100%; border-collapse:collapse; font-size:13px; color:var(--text);}
.ctable th{font-size:9.5px; letter-spacing:.09em; text-transform:uppercase; color:var(--muted);
 font-weight:700; text-align:right; padding:7px 9px; border-bottom:1px solid var(--border);}
.ctable th:first-child{text-align:left;}
.ctable td{padding:10px 9px; border-bottom:1px solid rgba(255,255,255,.045); text-align:right; font-variant-numeric:tabular-nums;}
.ctable tr:last-child td{border-bottom:0;}
.ctable td.ch{text-align:left; font-weight:600;}
.ctable td.pos{color:var(--pos);} .ctable td.neg{color:var(--neg);}
.dot{display:inline-block; width:9px; height:9px; border-radius:3px; margin-right:9px; vertical-align:middle;}
.bartrack{display:inline-block; width:78px; height:7px; border-radius:5px; background:rgba(255,255,255,.08); vertical-align:middle; overflow:hidden;}
.barfill{height:100%; border-radius:5px;} .sharepct{margin-left:9px; color:var(--muted);}

/* optimiser result banner */
.optbox{background:linear-gradient(135deg, rgba(52,214,160,.14), rgba(52,214,160,.04));
 border:1px solid rgba(52,214,160,.3); border-radius:12px; padding:11px 14px; color:#cdebdd;
 font-size:13px; margin-bottom:6px;}

/* widgets */
.stButton>button{border-radius:11px; border:1px solid var(--border); font-weight:600; color:var(--text); background:rgba(255,255,255,.03);}
.stButton>button:hover{border-color:var(--accent); color:#fff;}
.stButton>button[kind="primary"]{background:linear-gradient(135deg,#6c8cff,#5673ff); border:0; color:#fff;}
[data-testid="stSlider"] label, .stNumberInput label, .stTextArea label{font-size:12.5px; color:var(--text)!important;}
.js-plotly-plot{border-radius:12px;}
[data-testid="stMetricValue"]{font-variant-numeric:tabular-nums;}
</style>
"""
st.markdown(CSS, unsafe_allow_html=True)

# ==========================================================================
# State
# ==========================================================================
if "params" not in st.session_state:
    st.session_state.params = [dict(c) for c in DEFAULT_PARAMS]
for c in DEFAULT_PARAMS:
    st.session_state.setdefault(f"sl_{c['key']}", c["spend"])
st.session_state.setdefault("baseline", DEFAULT_BASELINE)
st.session_state.setdefault("opt_budget", float(round(sum(c["spend"] for c in DEFAULT_PARAMS))))

# ==========================================================================
# Hero
# ==========================================================================
st.markdown("""
<div class="hero">
  <div class="eyebrow">Bayesian Media Mix Model</div>
  <h1>Budget Planner</h1>
  <p>Set the weekly spend per channel and read contribution, return on ad spend, the saturation
  response curves, the optimal allocation, and the budget-response scenario in real time. Steady-state
  weekly view, figures in &euro;k per week.</p>
  <span class="badge">Defaults from simulated data &middot; load your own params.json in the sidebar</span>
</div>
""", unsafe_allow_html=True)

# ==========================================================================
# Sidebar  (params editor / IO / reset)  -- outside the fragment
# ==========================================================================
with st.sidebar:
    st.markdown("### ◆  Model parameters")
    st.caption("β ceiling · γ half-saturation · α shape · θ carryover")
    pdf = pd.DataFrame([{"Channel": p["name"], "β": p["beta"], "γ": p["gamma"],
                         "α": p["alpha"], "θ": p["theta"]} for p in st.session_state.params])
    edited = st.data_editor(pdf, hide_index=True, width="stretch", disabled=["Channel"])
    for i, row in edited.iterrows():
        for col, k in [("β", "beta"), ("γ", "gamma"), ("α", "alpha"), ("θ", "theta")]:
            st.session_state.params[i][k] = float(row[col])

    with st.expander("Load params.json"):
        txt = st.text_area("Paste the exported array", height=130,
                           placeholder='[{"key":"tv","name":"TV","beta":320,...}]')
        if st.button("Apply", width="stretch"):
            try:
                arr = json.loads(txt)
                new = [{"key": o.get("key", o.get("name", "ch")),
                        "name": o.get("name", o.get("key", "Channel")),
                        "color": o.get("color", "#6C8CFF"),
                        "beta": float(o["beta"]), "gamma": float(o["gamma"]),
                        "alpha": float(o["alpha"]), "theta": float(o["theta"]),
                        "spend": float(o.get("spend", o["gamma"]))} for o in arr]
                st.session_state.params = new
                for c in new:
                    st.session_state[f"sl_{c['key']}"] = c["spend"]
                st.rerun()
            except Exception as e:
                st.error(f"Parse error: {e}")

    export = [{"key": p["key"], "name": p["name"], "color": p["color"], "beta": p["beta"],
               "gamma": p["gamma"], "alpha": p["alpha"], "theta": p["theta"]}
              for p in st.session_state.params]
    st.download_button("Download params.json", json.dumps(export, indent=2),
                       "params.json", "application/json", width="stretch")

    st.divider()
    if st.button("Reset everything", width="stretch"):
        for c in DEFAULT_PARAMS:
            st.session_state[f"sl_{c['key']}"] = c["spend"]
        st.session_state.baseline = DEFAULT_BASELINE
        st.session_state.opt_budget = float(round(sum(c["spend"] for c in DEFAULT_PARAMS)))
        st.session_state.params = [dict(c) for c in DEFAULT_PARAMS]
        st.session_state.pop("opt_msg", None)
        st.rerun()

def do_optimise():
    """Button callback. Runs before widgets instantiate, so it may set slider state."""
    params = st.session_state.params
    B = float(st.session_state["opt_budget"])
    spend = {c["key"]: float(st.session_state[f"sl_{c['key']}"]) for c in params}
    before = total_contrib([spend[c["key"]] for c in params], params)
    alloc = optimise(params, B, current=[spend[c["key"]] for c in params])
    after = total_contrib(alloc, params)
    for i, c in enumerate(params):
        st.session_state[f"sl_{c['key']}"] = float(round(alloc[i], 1))
    msg = (f"Optimal split for &euro;{B:,.0f}k &rarr; media revenue "
           f"<b>&euro;{after:,.0f}k</b> at blended ROAS <b>{after/max(B,1e-9):.2f}&times;</b>")
    if before > 0:
        msg += f", <b>{100*(after-before)/before:+.0f}%</b> vs the previous allocation"
    st.session_state["opt_msg"] = msg + "."

# ==========================================================================
# Interactive dashboard  -- isolated in a fragment for snappy reruns
# ==========================================================================
@st.fragment
def dashboard():
    params = st.session_state.params
    baseline = float(st.session_state["baseline"])
    spend = {c["key"]: float(st.session_state[f"sl_{c['key']}"]) for c in params}

    rows = []
    for c in params:
        s = spend[c["key"]]; y = hill(s, c)
        rows.append({"key": c["key"], "name": c["name"], "color": c["color"], "spend": s,
                     "contrib": y, "roas": (y / s if s > 0 else 0.0), "marg": marginal(s, c)})
    media = sum(r["contrib"] for r in rows)
    tot_spend = sum(r["spend"] for r in rows)
    revenue = baseline + media
    roas = media / tot_spend if tot_spend else 0.0
    pct = 100 * media / revenue if revenue else 0.0

    # ---- KPI cards ----
    st.markdown(f"""
    <div class="kgrid">
      <div class="kpi"><div class="klabel">Predicted revenue</div>
        <div class="kval">&euro;{revenue:,.0f}k</div><div class="ksub">per week &middot; baseline + media</div></div>
      <div class="kpi accent"><div class="klabel">Media-driven</div>
        <div class="kval">&euro;{media:,.0f}k</div><div class="ksub">{pct:.0f}% of revenue</div></div>
      <div class="kpi"><div class="klabel">Baseline</div>
        <div class="kval">&euro;{baseline:,.0f}k</div><div class="ksub">organic &middot; no media</div></div>
      <div class="kpi green"><div class="klabel">Blended ROAS</div>
        <div class="kval">{roas:.2f}&times;</div><div class="ksub">&euro;{tot_spend:,.0f}k total spend</div></div>
    </div>
    """, unsafe_allow_html=True)

    left, right = st.columns([1, 1.32], gap="large")

    # ---- controls ----
    with left:
        st.markdown('<div class="sect">Controls</div>', unsafe_allow_html=True)
        st.number_input("Baseline revenue (€k/week)", min_value=0.0, max_value=5000.0,
                        step=10.0, key="baseline")
        for c in params:
            st.slider(f"{c['name']}  ·  half-sat €{c['gamma']:g}k", 0.0, SLIDER_MAX, step=0.5,
                      key=f"sl_{c['key']}")

        st.markdown('<div class="sect">Optimise a budget</div>', unsafe_allow_html=True)
        st.number_input("Total weekly budget (€k)", min_value=0.0, max_value=2000.0,
                        step=5.0, key="opt_budget")
        st.button("Optimise allocation  →", type="primary", width="stretch", on_click=do_optimise)
        if "opt_msg" in st.session_state:
            st.markdown(f'<div class="optbox">{st.session_state["opt_msg"]}</div>', unsafe_allow_html=True)

    # ---- response curves ----
    with right:
        st.markdown('<div class="sect">Saturation response curves</div>', unsafe_allow_html=True)
        smax = max(110.0, max(spend.values()) * 1.3)
        grid = np.linspace(0, smax, 60)
        fig = make_subplots(rows=1, cols=len(params),
                            subplot_titles=[c["name"] for c in params],
                            shared_yaxes=True, horizontal_spacing=0.012)
        for i, c in enumerate(params, start=1):
            fig.add_trace(go.Scatter(x=grid, y=hill_arr(grid, c), mode="lines",
                                     line=dict(color=c["color"], width=2.4),
                                     fill="tozeroy", fillcolor=hex_to_rgba(c["color"], 0.10),
                                     hovertemplate="€%{x:.0f}k → €%{y:.0f}k<extra></extra>",
                                     showlegend=False), row=1, col=i)
            sp = spend[c["key"]]; yp = hill(sp, c)
            fig.add_trace(go.Scatter(x=[sp, sp], y=[0, yp], mode="lines",
                                     line=dict(color=c["color"], width=1, dash="dot"),
                                     opacity=0.55, hoverinfo="skip", showlegend=False), row=1, col=i)
            fig.add_trace(go.Scatter(x=[sp], y=[yp], mode="markers",
                                     marker=dict(color="#080b14", size=9, line=dict(color=c["color"], width=2.5)),
                                     hoverinfo="skip", showlegend=False), row=1, col=i)
            fig.update_xaxes(title_text="€k", title_font_size=10, row=1, col=i)
        style_dark(fig, 250)
        st.plotly_chart(fig, width="stretch", config={"displayModeBar": False})

        st.markdown('<div class="sect">Contribution &amp; efficiency</div>', unsafe_allow_html=True)
        maxc = max((r["contrib"] for r in rows), default=1) or 1
        trs = ""
        for r in rows:
            share = (r["contrib"] / media * 100) if media else 0
            cls = "pos" if r["marg"] >= 1 else "neg"
            trs += (f'<tr><td class="ch"><span class="dot" style="background:{r["color"]}"></span>{r["name"]}</td>'
                    f'<td>{r["spend"]:.1f}</td><td>{r["contrib"]:.1f}</td><td>{r["roas"]:.2f}&times;</td>'
                    f'<td class="{cls}">{r["marg"]:.2f}</td>'
                    f'<td><span class="bartrack"><span class="barfill" style="width:{max(4,100*r["contrib"]/maxc):.0f}%;background:{r["color"]}"></span></span>'
                    f'<span class="sharepct">{share:.0f}%</span></td></tr>')
        st.markdown(f"""<table class="ctable"><thead><tr>
          <th>Channel</th><th>Spend &euro;k</th><th>Contribution &euro;k</th><th>ROAS</th>
          <th>Marg &euro;/&euro;</th><th>Share of media</th></tr></thead><tbody>{trs}</tbody></table>""",
          unsafe_allow_html=True)

    # ---- scenario ----
    st.markdown('<div class="sect">Scenario · response to total budget</div>', unsafe_allow_html=True)
    sig = tuple((p["beta"], p["gamma"], p["alpha"], p["theta"]) for p in params)
    budgets, rev, marg, breakeven = compute_scenario(sig)
    sc = make_subplots(rows=1, cols=2, horizontal_spacing=0.08,
                       subplot_titles=("Optimal incremental revenue", "Marginal € per € (diminishing returns)"))
    sc.add_trace(go.Scatter(x=budgets, y=rev, mode="lines", line=dict(color="#6c8cff", width=2.6),
                            fill="tozeroy", fillcolor="rgba(108,140,255,.10)",
                            hovertemplate="€%{x}k budget → €%{y:.0f}k<extra></extra>", showlegend=False), row=1, col=1)
    sc.add_vline(x=tot_spend, line=dict(color="#7c89a3", dash="dash"), row=1, col=1)
    sc.add_trace(go.Scatter(x=[tot_spend], y=[media], mode="markers",
                            marker=dict(color="#e8edf7", size=10, line=dict(color="#6c8cff", width=2)),
                            hovertemplate="current €%{x:.0f}k<extra></extra>", showlegend=False), row=1, col=1)
    sc.add_trace(go.Scatter(x=budgets, y=marg, mode="lines", line=dict(color="#34d6a0", width=2.6),
                            hovertemplate="€%{x}k → %{y:.2f}€/€<extra></extra>", showlegend=False), row=1, col=2)
    sc.add_hline(y=1.0, line=dict(color="#ff7a7a", dash="dash"), row=1, col=2)
    sc.update_xaxes(title_text="Total budget €k", title_font_size=10)
    sc.update_yaxes(title_text="€k", title_font_size=10, row=1, col=1)
    sc.update_yaxes(title_text="€ per €", title_font_size=10, row=1, col=2)
    style_dark(sc, 320)
    st.plotly_chart(sc, width="stretch", config={"displayModeBar": False})
    if breakeven:
        st.caption(f"Marginal revenue per euro falls to the €1 breakeven near a total budget of "
                   f"€{breakeven}k. Spending past that destroys value at current efficiencies.")
    else:
        st.caption("Marginal revenue per euro stays above €1 across the plotted range.")

dashboard()

st.markdown("<div style='color:#6b7794;font-size:11px;margin-top:18px;line-height:1.5'>"
            "Planning view assumes spend held constant week over week, so the normalised geometric "
            "adstock settles to the spend level and the steady-state contribution is the Hill response "
            "of spend. The optimiser and scenario maximise total contribution subject to total spend "
            "not exceeding the budget. Built on a Bayesian MMM fitted in PyMC.</div>",
            unsafe_allow_html=True)
