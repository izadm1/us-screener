"""Market structure: support/resistance, pivots, swing structure, weekly trend, volatility regime."""
import numpy as np
import pandas as pd


def _swings(h, l, k=3):
    hi, lo = [], []
    H, L = h.values, l.values
    for i in range(k, len(H) - k):
        if H[i] == H[i - k:i + k + 1].max():
            hi.append(i)
        if L[i] == L[i - k:i + k + 1].min():
            lo.append(i)
    return hi, lo


def sr_levels(x: pd.DataFrame, lookback=180, k=3):
    """Cluster swing highs/lows within 0.6 ATR into levels; return nearest 3 supports and 3 resistances."""
    t = x.tail(lookback)
    atr = float(x["atr14"].iloc[-1])
    price = float(x["Close"].iloc[-1])
    hi, lo = _swings(t["High"], t["Low"], k)
    pts = [(float(t["High"].iloc[i]), i) for i in hi] + [(float(t["Low"].iloc[i]), i) for i in lo]
    pts.sort()
    clusters = []
    for p, i in pts:
        if clusters and abs(p - clusters[-1]["sum"] / clusters[-1]["n"]) <= 0.6 * atr:
            c = clusters[-1]
            c["sum"] += p; c["n"] += 1; c["last"] = max(c["last"], i)
        else:
            clusters.append({"sum": p, "n": 1, "last": i})
    lv = []
    n = len(t)
    for c in clusters:
        p = c["sum"] / c["n"]
        recency = 1 - (n - 1 - c["last"]) / n
        lv.append({"price": round(p, 6), "touches": c["n"], "strength": round(c["n"] * (0.5 + recency), 2)})
    sup = sorted([v for v in lv if v["price"] < price - 0.1 * atr], key=lambda v: -v["price"])[:3]
    res = sorted([v for v in lv if v["price"] > price + 0.1 * atr], key=lambda v: v["price"])[:3]
    return sup, res


def pivots(h, l, c):
    p = (h + l + c) / 3
    return {"P": p, "R1": 2 * p - l, "S1": 2 * p - h, "R2": p + (h - l), "S2": p - (h - l), "R3": h + 2 * (p - l), "S3": l - 2 * (h - p)}


def structure(x: pd.DataFrame, calendar=False):
    c, h, l = x["Close"], x["High"], x["Low"]
    out = {}
    hi, lo = _swings(h.tail(150), l.tail(150), 3)
    t = x.tail(150)
    sh = [float(t["High"].iloc[i]) for i in hi]
    sl = [float(t["Low"].iloc[i]) for i in lo]
    last = float(c.iloc[-1])
    if len(sh) >= 2 and len(sl) >= 2:
        hh, hl = sh[-1] > sh[-2], sl[-1] > sl[-2]
        lh, ll = sh[-1] < sh[-2], sl[-1] < sl[-2]
        out["structure"] = "Uptrend (HH/HL)" if hh and hl else "Downtrend (LH/LL)" if lh and ll else "Range / transition"
        out["last_swing_high"] = round(sh[-1], 6)
        out["last_swing_low"] = round(sl[-1], 6)
        out["bos"] = "bullish" if last > sh[-1] else "bearish" if last < sl[-1] else None
    out["swing_lo20"] = round(float(l.tail(20).min()), 6)
    out["swing_hi20"] = round(float(h.tail(20).max()), 6)
    out["lo52"] = round(float(l.tail(252).min()), 6)
    out["hi52"] = round(float(h.tail(252).max()), 6)
    # daily pivots (last bar) and weekly pivots (last completed week)
    out["piv_d"] = {k: round(float(v), 6) for k, v in pivots(float(h.iloc[-1]), float(l.iloc[-1]), last).items()}
    wk = x[["High", "Low", "Close"]].resample("W-FRI").agg({"High": "max", "Low": "min", "Close": "last"}).dropna()
    if len(wk) >= 2:
        w = wk.iloc[-2] if wk.index[-1] > x.index[-1] else wk.iloc[-1]
        out["piv_w"] = {k: round(float(v), 6) for k, v in pivots(float(w.High), float(w.Low), float(w.Close)).items()}
    # weekly trend (10/40-week EMAs ~ 50/200-day)
    if len(wk) >= 45:
        e10 = wk["Close"].ewm(span=10, adjust=False).mean().iloc[-1]
        e40 = wk["Close"].ewm(span=40, adjust=False).mean().iloc[-1]
        wc = wk["Close"].iloc[-1]
        out["wk_trend"] = 1 if (wc > e40 and e10 > e40) else -1 if (wc < e40 and e10 < e40) else 0
    else:
        out["wk_trend"] = None
    # volatility regime
    atrp = (x["atr14"] / c).tail(252).dropna()
    if len(atrp) > 60:
        out["atr_pctile"] = round(float((atrp < atrp.iloc[-1]).mean()), 3)
    r = np.log(c).diff().tail(20).dropna()
    out["rvol_ann"] = round(float(r.std() * np.sqrt(365 if calendar else 252)), 4)
    # trend quality: R^2 and annualised slope of log price over 63 bars
    y = np.log(c.tail(63).values)
    if len(y) == 63:
        xx = np.arange(63)
        m, b0 = np.polyfit(xx, y, 1)
        fit = m * xx + b0
        ss = np.sum((y - y.mean()) ** 2) or 1e-12
        out["trend_r2"] = round(float(1 - np.sum((y - fit) ** 2) / ss), 3)
        out["trend_slope_ann"] = round(float(m * (365 if calendar else 252)), 4)
    out["sup"], out["res"] = sr_levels(x)
    return out
