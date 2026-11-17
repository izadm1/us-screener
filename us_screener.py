#!/usr/bin/env python3
"""
US Day-Trading Screener — stocks + ETFs
=======================================
Run before the US open (any time after 4:00am New York time). Pulls daily bars
and today's pre-market price from Yahoo Finance (free, via yfinance), screens a
liquid universe, tags day-trading setups, and writes a sortable HTML report + CSV.

    pip3 install yfinance pandas numpy
    python3 us_screener.py                 # screen + open report in browser
    python3 us_screener.py --no-open       # for scheduled runs
    python3 us_screener.py --demo          # synthetic data, to test without internet
    python3 us_screener.py --add CGON,TU   # add today's news tickers to the universe

Edit the SETTINGS block below to change the universe, filters and risk sizing.
Research aid only, not investment advice. Check every level on your own chart.
"""
import argparse, datetime as dt, html, json, math, os, sys, webbrowser
from pathlib import Path

import numpy as np
import pandas as pd

# ───────────────────────────── SETTINGS ─────────────────────────────
STOCKS = """
AAPL MSFT NVDA AMZN META GOOGL TSLA AVGO AMD NFLX PLTR COIN MSTR MU INTC SMCI
ARM QCOM MRVL TSM ASML ORCL CRM ADBE NOW SNOW CRWD PANW NET DDOG SHOP UBER ABNB
DASH HOOD SOFI PYPL XYZ AFRM UPST RBLX RIVN LCID NIO BABA PDD JD DKNG
JPM BAC GS MS C WFC SCHW XOM CVX OXY SLB COP FCX NEM
LLY UNH NVO MRNA PFE ABBV JNJ ISRG HIMS
BA CAT DE GE LMT RTX F GM DAL UAL CCL
WMT COST TGT HD LOW NKE SBUX MCD DIS
MARA RIOT CLSK IREN APP TTD ROKU U AI IONQ RGTI SOUN OKLO SMR CVNA
""".split()

ETFS = """
SPY QQQ IWM DIA TQQQ SQQQ SPXL SPXS SOXL SOXS SMH XLK XLF XLE XLV XLI XLY XLP
XLU XLB XLRE KRE XBI ARKK GLD SLV GDX USO TLT HYG EEM FXI KWEB UVXY IBIT
""".split()

FILTERS = {
    "min_price": 5.0,           # skip penny stocks
    "min_avg_volume": 1_000_000,  # 20-day average shares/day
    "min_avg_dollar_vol": 25e6,   # 20-day average $ traded/day
    "min_atr_pct_stock": 1.5,     # stocks must move: ATR14 as % of price
}

ACCOUNT_SIZE_USD = 25_000   # used for position size
RISK_PER_TRADE_PCT = 0.5    # % of account risked per trade
STOP_ATR_MULT = 0.5         # intraday stop distance = 0.5 x daily ATR from the trigger
TOP_N = 15                  # rows in the "Top setups" section

OUT_DIR = Path.home() / "Documents" / "Stock Screener"
# ────────────────────────────────────────────────────────────────────


# ---------- data ----------
def fetch_yahoo(tickers):
    import yfinance as yf
    daily = yf.download(tickers, period="1y", interval="1d", group_by="ticker",
                        auto_adjust=False, threads=True, progress=False)
    intraday = yf.download(tickers, period="2d", interval="5m", prepost=True,
                           group_by="ticker", auto_adjust=False, threads=True, progress=False)
    names = {}
    return daily, intraday, names


def fetch_demo(tickers, seed=7):
    """Synthetic random-walk data so the pipeline can be tested offline."""
    rng = np.random.default_rng(seed)
    idx = pd.bdate_range(end=pd.Timestamp.today().normalize() - pd.Timedelta(days=1), periods=252)
    d_frames, i_frames = {}, {}
    for t in tickers:
        p0 = rng.uniform(8, 600)
        vol = rng.uniform(0.01, 0.045)
        drift = rng.normal(0, 0.0015)
        close = p0 * np.exp(np.cumsum(rng.normal(drift, vol, len(idx))))
        high = close * (1 + np.abs(rng.normal(0, vol / 1.5, len(idx))))
        low = close * (1 - np.abs(rng.normal(0, vol / 1.5, len(idx))))
        opn = (high + low) / 2
        v = rng.uniform(0.6, 1.4, len(idx)) * rng.uniform(1.5e6, 9e7)
        d_frames[t] = pd.DataFrame({"Open": opn, "High": high, "Low": low, "Close": close,
                                    "Adj Close": close, "Volume": v}, index=idx)
        gap = rng.normal(0, vol * 1.3)
        pre_idx = pd.date_range(pd.Timestamp.now().normalize() + pd.Timedelta(hours=4), periods=60, freq="5min")
        pre = close[-1] * (1 + gap) * (1 + np.cumsum(rng.normal(0, 0.001, len(pre_idx))))
        i_frames[t] = pd.DataFrame({"Open": pre, "High": pre * 1.001, "Low": pre * 0.999,
                                    "Close": pre, "Adj Close": pre,
                                    "Volume": rng.uniform(1e3, 2e5, len(pre_idx))}, index=pre_idx)
    daily = pd.concat(d_frames, axis=1)
    intraday = pd.concat(i_frames, axis=1)
    return daily, intraday, {}


def per_ticker(frame, t):
    try:
        df = frame[t] if isinstance(frame.columns, pd.MultiIndex) else frame
        return df.dropna(how="all")
    except KeyError:
        return pd.DataFrame()


# ---------- indicators ----------
def rsi(close, n=14):
    delta = close.diff()
    up = delta.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean()
    dn = (-delta.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    rs = up / dn.replace(0, np.nan)
    return 100 - 100 / (1 + rs)


def atr(df, n=14):
    pc = df["Close"].shift()
    tr = pd.concat([df["High"] - df["Low"], (df["High"] - pc).abs(), (df["Low"] - pc).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / n, adjust=False).mean()


def premarket_last(intra, ny_today):
    """Last price traded today (pre-market or regular) from 5-minute bars, plus today's volume."""
    if intra.empty:
        return None, 0.0
    ix = intra.index
    if ix.tz is not None:
        ix = ix.tz_convert("America/New_York")
    today = intra[ix.date == ny_today]
    if today.empty:
        return None, 0.0
    return float(today["Close"].dropna().iloc[-1]), float(today["Volume"].fillna(0).sum())


# ---------- screen ----------
def analyse(t, kind, d, intra, ny_today):
    d = d.dropna(subset=["Close"])
    if len(d) < 60:
        return None
    # drop a partial bar for today if Yahoo already started the session
    if d.index[-1].date() >= ny_today:
        d = d.iloc[:-1]
    c, h, l, v = d["Close"], d["High"], d["Low"], d["Volume"]
    last = float(c.iloc[-1])
    avg_vol = float(v.tail(20).mean())
    row = {
        "ticker": t, "type": kind, "prev_close": last,
        "prev_high": float(h.iloc[-1]), "prev_low": float(l.iloc[-1]),
        "avg_vol_20d": avg_vol, "avg_dollar_vol_m": avg_vol * last / 1e6,
        "rel_vol_yday": float(v.iloc[-1] / avg_vol) if avg_vol else np.nan,
        "atr14": float(atr(d).iloc[-1]),
        "rsi14": float(rsi(c).iloc[-1]),
        "sma20": float(c.tail(20).mean()), "sma50": float(c.tail(50).mean()),
        "sma200": float(c.tail(200).mean()) if len(c) >= 200 else np.nan,
        "high_20d": float(h.tail(20).max()), "low_20d": float(l.tail(20).min()),
        "high_52w": float(h.max()),
        "chg_5d_pct": float((last / c.iloc[-6] - 1) * 100),
    }
    pm, pm_vol = premarket_last(intra, ny_today)
    row["pre_price"] = pm if pm is not None else np.nan
    row["gap_pct"] = (pm / last - 1) * 100 if pm is not None else 0.0
    row["pre_vol"] = pm_vol
    row["atr_pct"] = row["atr14"] / last * 100
    row["gap_atr"] = abs(row["gap_pct"]) / row["atr_pct"] if row["atr_pct"] else 0
    row["px"] = pm if pm is not None else last
    row["from_52w_high_pct"] = (row["px"] / row["high_52w"] - 1) * 100
    return row


def classify(r):
    px, s20, s50, s200 = r["px"], r["sma20"], r["sma50"], r["sma200"]
    up_trend = px > s50 and (math.isnan(s200) or s50 > s200)
    dn_trend = px < s50 and (math.isnan(s200) or s50 < s200)
    g, rv, rs = r["gap_pct"], r["rel_vol_yday"], r["rsi14"]
    gap_big = abs(g) >= max(2.0, 0.5 * r["atr_pct"])

    if gap_big and g > 0:
        setup, bias = ("Gap & Go long" if up_trend or px > r["prev_high"] else "Gap up — fade watch",
                       "Long" if up_trend or px > r["prev_high"] else "Short")
    elif gap_big and g < 0:
        setup, bias = ("Gap & Go short" if dn_trend or px < r["prev_low"] else "Gap down — bounce watch",
                       "Short" if dn_trend or px < r["prev_low"] else "Long")
    elif px >= r["high_20d"] * 0.99 and up_trend:
        setup, bias = "Breakout watch (20-day high)", "Long"
    elif px <= r["low_20d"] * 1.01 and dn_trend:
        setup, bias = "Breakdown watch (20-day low)", "Short"
    elif rs < 30 and (math.isnan(s200) or px > s200 * 0.9):
        setup, bias = "Oversold bounce", "Long"
    elif rs > 75:
        setup, bias = "Overbought — pullback risk", "Short"
    elif up_trend and abs(px / s20 - 1) < 0.015 and 40 <= rs <= 60:
        setup, bias = "Trend pullback to 20-day avg", "Long"
    elif dn_trend and abs(px / s20 - 1) < 0.015 and 40 <= rs <= 60:
        setup, bias = "Downtrend rally to 20-day avg", "Short"
    else:
        setup, bias = "No setup", "Neutral"
    return setup, bias


def score(r):
    """0–100: how 'in play' and well-aligned the setup is. Not a probability."""
    if r["bias"] == "Neutral":
        return round(min(r["atr_pct"] / 5, 1) * 15 + min(r["rel_vol_yday"] / 3, 1) * 10, 1)
    s = 0.0
    s += min(r["gap_atr"], 1.5) / 1.5 * 30                    # move vs normal range
    s += min(max(r["rel_vol_yday"] - 0.8, 0) / 2.2, 1) * 20     # participation
    s += min(r["atr_pct"] / 5, 1) * 15                          # room to move
    s += min(math.log10(max(r["avg_dollar_vol_m"], 1)) / 3, 1) * 10  # liquidity
    long_ = r["bias"] == "Long"
    trend_ok = (r["px"] > r["sma50"]) if long_ else (r["px"] < r["sma50"])
    s += 15 if trend_ok else 0                                  # with the trend
    rsi_ok = (r["rsi14"] < 70) if long_ else (r["rsi14"] > 30)
    s += 10 if rsi_ok else 0                                    # not stretched
    return round(s, 1)


def plan(r):
    """Trigger, stop and targets from yesterday's range / pre-market and ATR."""
    stop_dist = STOP_ATR_MULT * r["atr14"]
    if r["bias"] == "Long":
        trig = max(r["prev_high"], r["px"]) if r["setup"].startswith(("Gap", "Breakout")) else r["px"]
        stop, t1, t2 = trig - stop_dist, trig + stop_dist, trig + 2 * stop_dist
    elif r["bias"] == "Short":
        trig = min(r["prev_low"], r["px"]) if r["setup"].startswith(("Gap", "Breakdown")) else r["px"]
        stop, t1, t2 = trig + stop_dist, trig - stop_dist, trig - 2 * stop_dist
    else:
        return dict(trigger=np.nan, stop=np.nan, target1=np.nan, target2=np.nan, shares=0,
                    target_price=np.nan, target_basis="", target_pct=np.nan,
                    hold_t1="", hold_target="", hold_mins=np.nan)
    risk_usd = ACCOUNT_SIZE_USD * RISK_PER_TRADE_PCT / 100
    shares = int(risk_usd // stop_dist) if stop_dist > 0 else 0
    shares = min(shares, int(ACCOUNT_SIZE_USD // trig)) if trig > 0 else 0
    tgt, basis = target_price(r, trig, t1, t2)
    m1, mt = est_minutes(r, abs(t1 - trig)), est_minutes(r, abs(tgt - trig))
    return dict(trigger=trig, stop=stop, target1=t1, target2=t2, shares=shares,
                target_price=tgt, target_basis=basis, target_pct=(tgt / trig - 1) * 100,
                hold_t1=hold_label(m1), hold_target=hold_label(mt), hold_mins=mt)


def target_price(r, trig, t1, t2):
    """Main target: 2R, unless a nearby chart level (where price often stalls) comes first."""
    long_ = r["bias"] == "Long"
    levels = {"yesterday's high": r["prev_high"], "20-day high": r["high_20d"],
              "50-day avg": r["sma50"], "20-day avg": r["sma20"]} if long_ else \
             {"yesterday's low": r["prev_low"], "20-day low": r["low_20d"],
              "50-day avg": r["sma50"], "20-day avg": r["sma20"]}
    best = None
    for name, lvl in levels.items():
        if lvl is None or math.isnan(lvl):
            continue
        # a level beyond 1R but before 2R caps the move; take the nearest one
        if (long_ and t1 < lvl < t2) or (not long_ and t2 < lvl < t1):
            if best is None or abs(lvl - trig) < abs(best[1] - trig):
                best = (name, lvl)
    if best:
        return best[1], f"{best[0]} (resistance)" if long_ else f"{best[0]} (support)"
    return t2, "2R (2× risk)"


def est_minutes(r, dist):
    """Rough time for price to travel `dist`, from the daily ATR.
    Typical move over t hours ≈ ATR × speed × √(t / 6.5); in-play names (gap, volume) move faster."""
    if not r["atr14"] or dist <= 0:
        return np.nan
    speed = min(max(0.7 + 0.3 * r["rel_vol_yday"] + 0.5 * r["gap_atr"], 0.8), 2.0)
    return 6.5 * 60 * (dist / (r["atr14"] * speed)) ** 2


def hold_label(mins):
    if mins is None or math.isnan(mins):
        return "—"
    if mins < 60:
        return f"~{max(15, int(round(mins / 15) * 15))} min"
    if mins <= 6.5 * 60:
        return f"~{mins / 60:.1f} h"
    days = math.ceil(mins / (6.5 * 60))
    return f"{days}+ days (swing)" if days > 1 else "full day"


def run(demo=False, extra=()):
    stocks = list(dict.fromkeys(STOCKS + [x for x in extra if x not in ETFS]))
    tickers = stocks + ETFS
    ny_now = pd.Timestamp.now(tz="America/New_York")
    ny_today = ny_now.date()
    print(f"Screening {len(stocks)} stocks + {len(ETFS)} ETFs at {ny_now:%a %d %b %Y %H:%M} New York time…")
    daily, intraday, _ = (fetch_demo if demo else fetch_yahoo)(tickers)

    rows, skipped = [], []
    for t in tickers:
        kind = "ETF" if t in ETFS else "Stock"
        try:
            r = analyse(t, kind, per_ticker(daily, t), per_ticker(intraday, t), ny_today)
        except Exception as e:  # one bad ticker shouldn't stop the run
            skipped.append(f"{t} ({e.__class__.__name__})"); continue
        if r is None:
            skipped.append(f"{t} (not enough history)"); continue
        if r["prev_close"] < FILTERS["min_price"] or r["avg_vol_20d"] < FILTERS["min_avg_volume"] \
                or r["avg_dollar_vol_m"] * 1e6 < FILTERS["min_avg_dollar_vol"]:
            continue
        if kind == "Stock" and r["atr_pct"] < FILTERS["min_atr_pct_stock"]:
            continue
        r["setup"], r["bias"] = classify(r)
        r["score"] = score(r)
        r.update(plan(r))
        rows.append(r)

    df = pd.DataFrame(rows).sort_values("score", ascending=False).reset_index(drop=True)
    has_pre = df["pre_price"].notna().sum()
    meta = dict(run_ny=f"{ny_now:%a %d %b %Y %H:%M} ET",
                run_local=dt.datetime.now().strftime("%a %d %b %Y %H:%M"),
                universe=len(tickers), passed=len(df), with_premarket=int(has_pre),
                skipped=skipped, demo=demo)
    return df, meta


# ---------- report ----------
COLS = [("ticker", "Ticker"), ("trade", "Trade"), ("score", "Score"), ("px", "Price"),
        ("gap_pct", "Gap %"), ("trigger", "Entry"), ("stop", "Stop"), ("target_price", "Target"),
        ("target_pct", "Gain %"), ("hold_target", "Hold"), ("shares", "Shares")]


def fmt(v, key):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return "—"
    if key in ("ticker", "type", "setup", "bias", "trade", "target_basis", "hold_t1", "hold_target"):
        return html.escape(str(v))
    if key == "shares":
        return f"{int(v):,}"
    if key.endswith("_pct") or key in ("gap_pct", "atr_pct"):
        return f"{v:+.1f}" if key in ("gap_pct", "chg_5d_pct", "target_pct") else f"{v:.1f}"
    if key == "avg_dollar_vol_m":
        return f"{v:,.0f}"
    if key in ("rel_vol_yday",):
        return f"{v:.2f}×"
    if key in ("rsi14", "score"):
        return f"{v:.0f}"
    return f"{v:,.2f}"


def table(df, tid):
    head = "".join(f'<th data-k="{k}">{lbl}</th>' for k, lbl in COLS)
    body = []
    for _, r in df.iterrows():
        cls = {"Long": "long", "Short": "short"}.get(r["bias"], "")
        tds = []
        for k, _ in COLS:
            v = r.get(k)
            if k == "hold_target":
                v_sort = r.get("hold_mins")
                sort = f' data-v="{v_sort}"' if isinstance(v_sort, float) and not math.isnan(v_sort) else ' data-v="1e18"'
            else:
                sort = "" if isinstance(v, str) else (f' data-v="{v}"' if v is not None and not (isinstance(v, float) and math.isnan(v)) else ' data-v="-1e18"')
            extra = ""
            if k == "gap_pct" and isinstance(v, (int, float)) and not math.isnan(v):
                extra = ' class="pos"' if v > 0 else (' class="neg"' if v < 0 else "")
            tds.append(f"<td{sort}{extra}>{fmt(v, k)}</td>")
        body.append(f'<tr class="{cls}" data-type="{r["type"]}" data-bias="{r["bias"]}">{"".join(tds)}</tr>')
    return f'<div class="wrap"><table id="{tid}"><thead><tr>{head}</tr></thead><tbody>{"".join(body)}</tbody></table></div>'


# ---------- track record: save today's plan, score yesterday's ----------
PLAN_CUTOFF_ET = dt.time(10, 0)   # only plans made before this time count (no hindsight)
ENTRY_FROM_ET = dt.time(9, 45)    # entries allowed after the open settles
EXIT_BY_ET = dt.time(15, 55)      # flat by the close


def save_plan(active, meta, hist_dir, ny_now):
    """Keep the first pre-10am plan of each day, so it can be scored the next day."""
    if ny_now.time() >= PLAN_CUTOFF_ET or not meta["with_premarket"] or active.empty:
        return None
    hist_dir.mkdir(parents=True, exist_ok=True)
    f = hist_dir / f"plan-{ny_now.date()}.csv"
    if f.exists():
        return f
    cols = ["ticker", "trade", "bias", "score", "trigger", "stop", "target_price", "shares", "hold_mins"]
    active[cols].assign(planned_at=meta["run_ny"]).to_csv(f, index=False, float_format="%.4f")
    return f


def bars_for_day(intra, t, day):
    b = per_ticker(intra, t)
    if b.empty:
        return b
    ix = b.index.tz_convert("America/New_York") if b.index.tz is not None else b.index
    b = b.set_axis(ix)
    b = b[(ix.date == day)]
    return b[(b.index.time >= ENTRY_FROM_ET) & (b.index.time < dt.time(16, 0))].dropna(subset=["Close"])


def score_trade(p, bars):
    """Walk 5-minute bars: entry on a break of the trigger, then stop or target, else exit at 3:55pm.
    If stop and target fall in the same bar, count it as stopped (conservative)."""
    long_ = p["bias"] == "Long"
    trig, stop, tgt = p["trigger"], p["stop"], p["target_price"]
    if bars.empty:
        return dict(result="No data", exit=np.nan, pl_pct=np.nan, r=np.nan, when="")
    entry_t = None
    for ts, b in bars.iterrows():
        if entry_t is None:
            if ts.time() >= EXIT_BY_ET:
                break
            hit = b["High"] >= trig if long_ else b["Low"] <= trig
            if not hit:
                continue
            entry_t, entry_px = ts, (max(trig, b["Open"]) if long_ else min(trig, b["Open"]))
        # after entry (including the entry bar)
        stop_hit = b["Low"] <= stop if long_ else b["High"] >= stop
        tgt_hit = b["High"] >= tgt if long_ else b["Low"] <= tgt
        if stop_hit:
            return _res("Stopped out", entry_px, stop, long_, p, entry_t, ts)
        if tgt_hit:
            return _res("Target hit", entry_px, tgt, long_, p, entry_t, ts)
        if ts.time() >= EXIT_BY_ET:
            return _res("Closed, target not hit", entry_px, b["Close"], long_, p, entry_t, ts)
    if entry_t is None:
        return dict(result="No entry", exit=np.nan, pl_pct=np.nan, r=np.nan, when="")
    last = bars.iloc[-1]
    return _res("Closed, target not hit", entry_px, last["Close"], long_, p, entry_t, bars.index[-1])


def _res(label, entry, exit_, long_, p, t_in, t_out):
    pl = (exit_ / entry - 1) * (1 if long_ else -1) * 100
    risk = abs(p["trigger"] - p["stop"])
    r = ((exit_ - entry) if long_ else (entry - exit_)) / risk if risk else np.nan
    mins = (t_out - t_in).total_seconds() / 60
    took = f"{int(mins)} min" if mins < 60 else f"{mins / 60:.1f} h"
    return dict(result=label, exit=exit_, pl_pct=pl, r=r,
                pl_usd=((exit_ - entry) if long_ else (entry - exit_)) * p["shares"],
                when=f"in at {t_in:%H:%M}, out {t_out:%H:%M} ET ({took})")


def score_previous(hist_dir, ny_today, demo=False):
    """Score the latest saved plan from before today. Returns (day, results DataFrame) or (None, None)."""
    plans = sorted(f for f in hist_dir.glob("plan-*.csv") if f.stem[5:] < str(ny_today))
    if not plans:
        return None, None
    f = plans[-1]
    day = dt.date.fromisoformat(f.stem[5:])
    plan_df = pd.read_csv(f)
    tickers = plan_df["ticker"].tolist()
    if demo:
        intra = _demo_session(plan_df, day)
    else:
        import yfinance as yf
        intra = yf.download(tickers, period="5d", interval="5m", group_by="ticker",
                            auto_adjust=False, threads=True, progress=False)
    out = []
    for _, p in plan_df.iterrows():
        out.append({**p.to_dict(), **score_trade(p, bars_for_day(intra, p["ticker"], day))})
    res = pd.DataFrame(out)
    # keep a running log, one block per day
    log = hist_dir / "results.csv"
    old = pd.read_csv(log) if log.exists() else pd.DataFrame()
    if old.empty or str(day) not in old.get("day", pd.Series(dtype=str)).astype(str).values:
        pd.concat([old, res.assign(day=str(day))]).to_csv(log, index=False, float_format="%.4f")
    return day, res


def _demo_session(plan_df, day, seed=3):
    rng = np.random.default_rng(seed)
    idx = pd.date_range(pd.Timestamp(day).tz_localize("America/New_York") + pd.Timedelta(hours=9, minutes=30),
                        periods=78, freq="5min")
    frames = {}
    for _, p in plan_df.iterrows():
        step = abs(p["trigger"] - p["stop"]) * 0.35
        c = p["trigger"] * (1 + rng.normal(0, 0.002)) + np.cumsum(rng.normal(0, step, len(idx)))
        frames[p["ticker"]] = pd.DataFrame({"Open": c, "High": c + step / 2, "Low": c - step / 2, "Close": c,
                                            "Volume": 1e4}, index=idx)
    return pd.concat(frames, axis=1)


def results_html(day, res, hist_dir):
    if day is None:
        return '<h2>Previous day\'s results</h2><p class="note">Starts tomorrow: today\'s pre-10am plan is saved and scored after the close.</p>'
    order = {"Target hit": 0, "Closed, target not hit": 1, "Stopped out": 2, "No entry": 3, "No data": 4}
    res = res.sort_values(by=["result", "score"], key=lambda c: c.map(order) if c.name == "result" else -c)
    traded = res[res["result"].isin(["Target hit", "Stopped out", "Closed, target not hit"])]
    n = lambda k: int((res["result"] == k).sum())
    net_r, net_usd = traded["r"].sum(), traded["pl_usd"].sum()
    wins = int((traded["r"] > 0).sum())
    summary = (f'{len(traded)} triggered: <span class="pos">{n("Target hit")} target hit</span> · '
               f'{n("Closed, target not hit")} closed without target · <span class="neg">{n("Stopped out")} stopped</span> · '
               f'{n("No entry")} never triggered. Net <b class="{"pos" if net_r >= 0 else "neg"}">{net_r:+.1f}R '
               f'(${net_usd:+,.0f})</b>, {wins}/{len(traded) or 0} winners.')
    log = hist_dir / "results.csv"
    track = ""
    if log.exists():
        allr = pd.read_csv(log)
        allt = allr[allr["result"].isin(["Target hit", "Stopped out", "Closed, target not hit"])]
        days = allr["day"].nunique()
        if days > 1 and len(allt):
            track = (f'<p class="sub">Track record, {days} days: {len(allt)} trades, '
                     f'{(allt["r"] > 0).mean() * 100:.0f}% winners, {(allt["result"] == "Target hit").mean() * 100:.0f}% hit target, '
                     f'net {allt["r"].sum():+.1f}R (${allt["pl_usd"].sum():+,.0f}).</p>')
    rows = []
    for _, r in res.iterrows():
        cls = {"Target hit": "pos", "Stopped out": "neg"}.get(r["result"], "")
        fmtn = lambda v, f="{:,.2f}": "—" if pd.isna(v) else f.format(v)
        rows.append(f'<tr><td>{html.escape(r["ticker"])}</td><td>{html.escape(r["trade"])}</td>'
                    f'<td>{fmtn(r["trigger"])}</td><td>{fmtn(r["target_price"])}</td>'
                    f'<td class="{cls}">{r["result"]}</td><td>{fmtn(r["exit"])}</td>'
                    f'<td class="{cls}">{fmtn(r["pl_pct"], "{:+.1f}%")}</td><td class="{cls}">{fmtn(r.get("r"), "{:+.1f}R")}</td>'
                    f'<td>{html.escape(r["when"] or "")}</td></tr>')
    return (f'<h2>Results — {day:%a %d %b} plan</h2><p class="sub">{summary}</p>{track}'
            '<div class="wrap"><table><thead><tr><th>Ticker</th><th>Trade</th><th>Entry</th><th>Target</th>'
            '<th>Result</th><th>Exit</th><th>P/L</th><th>R</th><th>Timing</th></tr></thead>'
            f'<tbody>{"".join(rows)}</tbody></table></div>')


SHORT_SETUP = {"Gap & Go long": "Gap & Go", "Gap & Go short": "Gap & Go", "Gap up — fade watch": "Gap fade",
               "Gap down — bounce watch": "Gap bounce", "Breakout watch (20-day high)": "Breakout",
               "Breakdown watch (20-day low)": "Breakdown", "Oversold bounce": "Oversold bounce",
               "Overbought — pullback risk": "Overbought fade", "Trend pullback to 20-day avg": "Trend pullback",
               "Downtrend rally to 20-day avg": "Rally fade"}


def trade_label(df):
    lab = df["bias"] + " · " + df["setup"].map(SHORT_SETUP).fillna(df["setup"])
    return lab.where(df["type"] != "ETF", lab + " (ETF)")


def write_report(df, meta, out_dir, results_block=""):
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y-%m-%d")
    csv_path = out_dir / f"screener-{stamp}.csv"
    df.to_csv(csv_path, index=False, float_format="%.4f")

    df = df.copy()
    df["trade"] = trade_label(df)
    active = df[df["bias"] != "Neutral"]
    top = active.head(TOP_N)
    idx = {r["ticker"]: r for _, r in df.iterrows()}
    def tile(t):
        r = idx.get(t)
        if r is None: return f'<div class="tile"><b>{t}</b><span>—</span></div>'
        g = r["gap_pct"]; c = "pos" if g > 0 else "neg" if g < 0 else ""
        return f'<div class="tile"><b>{t}</b><span class="{c}">{g:+.2f}%</span><small>{r["px"]:,.2f}</small></div>'
    n_long = int((active["bias"] == "Long").sum()); n_short = int((active["bias"] == "Short").sum())
    spy = idx.get("SPY"); qqq = idx.get("QQQ")
    tone = "—"
    if spy is not None and qqq is not None:
        avg = (spy["gap_pct"] + qqq["gap_pct"]) / 2
        tone = "risk-on" if avg > 0.3 else "risk-off" if avg < -0.3 else "flat"
    demo_banner = '<p class="warn">DEMO DATA — synthetic prices, for testing only.</p>' if meta["demo"] else ""
    pm_note = "" if meta["with_premarket"] else '<p class="warn">No pre-market prints for today yet — gaps show 0. Run after 4:00am New York time (4:00pm/5:00pm Malaysia).</p>'

    page = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>US Day-Trading Screener — {stamp}</title>
<style>
:root{{--bg:#0f1115;--panel:#171a21;--line:#262b36;--fg:#e7e9ee;--mut:#8a93a6;--pos:#2fbf71;--neg:#ef5a5a;--acc:#5b8cff}}
@media (prefers-color-scheme:light){{:root{{--bg:#f7f8fa;--panel:#fff;--line:#e3e6ec;--fg:#14171f;--mut:#5d6575;--pos:#138a4b;--neg:#c93838;--acc:#2f5fe0}}}}
*{{box-sizing:border-box}} body{{margin:0;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;background:var(--bg);color:var(--fg)}}
main{{max-width:1000px;margin:0 auto;padding:24px 18px 60px}}
h1{{font-size:24px;margin:0 0 4px}} h2{{font-size:16px;margin:28px 0 10px}}
.sub{{color:var(--mut);margin:0 0 14px}} .note{{color:var(--mut);font-size:13px;margin-top:14px;max-width:900px}} .warn{{background:#7a5a00;color:#fff;padding:8px 12px;border-radius:8px}}
.tiles{{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px}}
.tile{{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column}}
.tile b{{font-size:13px;color:var(--mut)}} .tile span{{font-size:20px;font-variant-numeric:tabular-nums}} .tile small{{color:var(--mut)}}
.kpis{{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0}} .kpi{{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:8px 14px}}
.kpi b{{display:block;font-size:20px}} .kpi span{{color:var(--mut);font-size:12px}}
.bar{{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0}}
.bar button{{background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:999px;padding:5px 12px;cursor:pointer}}
.bar button.on{{background:var(--acc);border-color:var(--acc);color:#fff}} .bar input{{background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:6px 10px}}
.wrap{{overflow-x:auto;border:1px solid var(--line);border-radius:10px}}
table{{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums;white-space:nowrap}}
th,td{{padding:6px 8px;font-size:13px;border-bottom:1px solid var(--line);text-align:right}} th:nth-child(-n+2),td:nth-child(-n+2){{text-align:left}}
th{{position:sticky;top:0;background:var(--panel);cursor:pointer;font-weight:600;font-size:12px;color:var(--mut)}}
tr.long td:first-child{{border-left:3px solid var(--pos)}} tr.short td:first-child{{border-left:3px solid var(--neg)}}
td:first-child{{font-weight:700}} .pos{{color:var(--pos)}} .neg{{color:var(--neg)}}
details{{margin-top:28px;color:var(--mut)}} details p,details li{{max-width:900px}}
</style></head><body><main>
<h1>US Day-Trading Screener</h1>
<p class="sub">Updated {meta['run_local']} MYT ({meta['run_ny']})</p>
{demo_banner}{pm_note}
<div class="tiles">{''.join(tile(t) for t in ['SPY','QQQ','IWM','UVXY'])}</div>
<p class="sub">Market {tone} · <span class="pos">{n_long} long</span> · <span class="neg">{n_short} short</span> · size risks {RISK_PER_TRADE_PCT}% of ${ACCOUNT_SIZE_USD:,}</p>
<div class="bar" id="flt">
<button data-f="all" class="on">All</button><button data-f="Long">Long</button><button data-f="Short">Short</button><button data-f="Stock">Stocks</button><button data-f="ETF">ETFs</button>
</div>
{table(active, 'all')}
{results_block}
<p class="note" id="rules">Enter on a break of <b>Entry</b> after 9:45am ET. Exit at <b>Stop</b> or <b>Target</b>; if neither by the <b>Hold</b> time, consider cutting it. Close all by 3:55pm ET. Results assume exactly these rules, full position. Check news/earnings first. Not investment advice.</p>
</main>
<script>
function sortBy(th){{const t=th.closest('table'),i=[...th.parentNode.children].indexOf(th),b=t.tBodies[0];
const asc=th.dataset.dir!=='asc';th.parentNode.querySelectorAll('th').forEach(x=>delete x.dataset.dir);th.dataset.dir=asc?'asc':'desc';
[...b.rows].sort((a,c)=>{{const A=a.cells[i],C=c.cells[i];const x=A.dataset.v,y=C.dataset.v;
const r=(x!==undefined&&y!==undefined)?(+x)-(+y):A.textContent.localeCompare(C.textContent);return asc?r:-r}}).forEach(r=>b.appendChild(r))}}
document.querySelectorAll('th').forEach(th=>th.addEventListener('click',()=>sortBy(th)));
let mode='all';
function apply(){{document.querySelectorAll('#all tbody tr').forEach(r=>{{
let ok=mode==='all'||r.dataset.type===mode||r.dataset.bias===mode;r.style.display=ok?'':'none'}})}}
document.querySelectorAll('#flt button').forEach(b=>b.addEventListener('click',()=>{{
document.querySelectorAll('#flt button').forEach(x=>x.classList.remove('on'));b.classList.add('on');mode=b.dataset.f;apply()}}));
</script></body></html>"""
    html_path = out_dir / f"screener-{stamp}.html"
    html_path.write_text(page, encoding="utf-8")
    (out_dir / "latest.html").write_text(page, encoding="utf-8")
    return html_path, csv_path


def main():
    ap = argparse.ArgumentParser(description="US day-trading screener (stocks + ETFs)")
    ap.add_argument("--demo", action="store_true", help="use synthetic data (no internet)")
    ap.add_argument("--no-open", action="store_true", help="don't open the report in a browser")
    ap.add_argument("--add", default="", help="extra tickers, comma-separated (e.g. today's news movers)")
    ap.add_argument("--out", default=str(OUT_DIR), help="output folder")
    ap.add_argument("--history", default=str(Path(__file__).resolve().parent / "history"),
                    help="folder for saved daily plans and results")
    a = ap.parse_args()
    extra = [x.strip().upper() for x in a.add.split(",") if x.strip()]
    df, meta = run(demo=a.demo, extra=extra)
    if df.empty:
        sys.exit("Nothing passed the filters — check your internet connection or loosen FILTERS.")
    hist = Path(a.history)
    ny_now = pd.Timestamp.now(tz="America/New_York")
    active = df[df["bias"] != "Neutral"].copy()
    active["trade"] = trade_label(active)
    save_plan(active, meta, hist, ny_now)
    try:
        day, res = score_previous(hist, ny_now.date(), demo=a.demo)
        block = results_html(day, res, hist)
    except Exception as e:
        print(f"Could not score previous plan: {e}")
        block = ""
    html_path, csv_path = write_report(df, meta, Path(a.out).expanduser(), block)
    top = df[df["bias"] != "Neutral"].head(5)
    print("\nTop setups:")
    for _, r in top.iterrows():
        print(f"  {r['ticker']:<6} {r['bias']:<5} {r['setup']:<32} gap {r['gap_pct']:+.2f}%  score {r['score']:.0f}"
              f"  entry {r['trigger']:.2f} target {r['target_price']:.2f} ({r['target_pct']:+.1f}%) hold {r['hold_target']}")
    if meta["skipped"]:
        print(f"\nSkipped {len(meta['skipped'])}: {', '.join(meta['skipped'][:15])}")
    print(f"\nReport: {html_path}\nCSV:    {csv_path}")
    if not a.no_open:
        webbrowser.open(html_path.as_uri())


if __name__ == "__main__":
    main()
