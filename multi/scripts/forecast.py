"""Date-based price forecasts.

Two parts, kept separate so each can be checked on its own:

1. Probabilistic price range (log-normal):
   - drift  = 30% of the last 6 months' average daily log-return (shrunk toward zero,
              because raw historical drift massively over-predicts)
   - vol    = blend of EWMA (lambda 0.94) and 1-year realised volatility
   For any future date: median price, 50% and 80% ranges, probability of being higher.

2. Dominant market cycle (open replacement for "Forecast" turning dates):
   - log price detrended over the last 256 bars
   - periodogram over 8–64 bar periods picks the strongest cycle
   - a sine wave fitted to the most recent 3 cycles gives phase and amplitude
   - projected peaks / troughs become dates
   The cycle term is only added to the median price when the walk-forward backtest shows
   it beat the drift-only model for that symbol.

3. Walk-forward backtest: the model is re-run at ~50 past dates using only data available
   then, and its 10-bar forecast is compared with what actually happened.
"""
import math

import numpy as np
import pandas as pd

Z80, Z50 = 1.2816, 0.6745
HORIZONS = [5, 10, 21, 63]
BT_H = 10


def drift_vol(logc: np.ndarray):
    r = np.diff(logc)
    r = r[~np.isnan(r)]
    if len(r) < 60:
        return 0.0, float(np.std(r)) if len(r) > 2 else 0.02
    mu = 0.30 * float(np.mean(r[-126:]))
    lam = 0.94
    w = lam ** np.arange(min(len(r), 250))[::-1]
    ewma_var = float(np.sum(w * r[-len(w):] ** 2) / np.sum(w))
    var252 = float(np.var(r[-252:]))
    return mu, math.sqrt(0.5 * ewma_var + 0.5 * var252)


def dominant_cycle(logc: np.ndarray, win=256, pmin=8, pmax=64):
    x = logc[-win:]
    n = len(x)
    if n < 2 * pmax:
        return None
    t = np.arange(n)
    resid = x - np.polyval(np.polyfit(t, x, 1), t)
    best, best_pow = None, 0.0
    for p in range(pmin, pmax + 1):
        w = 2 * np.pi / p
        pw = (np.sum(resid * np.cos(w * t)) ** 2 + np.sum(resid * np.sin(w * t)) ** 2)
        pw /= n
        if pw > best_pow:
            best, best_pow = p, pw
    p = best
    # local sine fit on the latest 3 cycles (re-detrended locally)
    m = min(n, 3 * p)
    tl = np.arange(m)
    xl = x[-m:]
    rl = xl - np.polyval(np.polyfit(tl, xl, 1), tl)
    w = 2 * np.pi / p
    A = np.column_stack([np.sin(w * tl), np.cos(w * tl)])
    (a, b), *_ = np.linalg.lstsq(A, rl, rcond=None)
    amp = math.hypot(a, b)
    phi = math.atan2(b, a)  # a sin + b cos = amp * sin(wt + phi)
    fit = A @ np.array([a, b])
    ss = float(np.sum(rl ** 2)) or 1e-12
    strength = max(0.0, 1 - float(np.sum((rl - fit) ** 2)) / ss)
    phase_now = (w * (m - 1) + phi) % (2 * np.pi)
    return {"period": int(p), "amp": float(amp), "phase": float(phase_now), "strength": float(strength)}


def cycle_delta(cyc, h):
    if not cyc:
        return 0.0
    w = 2 * np.pi / cyc["period"]
    return cyc["amp"] * (math.sin(cyc["phase"] + w * h) - math.sin(cyc["phase"]))


def next_turns(cyc, n=4):
    """Bar offsets (>=1) of the next peaks and troughs."""
    if not cyc:
        return []
    p, ph = cyc["period"], cyc["phase"]
    out = []
    for target, kind in [(np.pi / 2, "peak"), (3 * np.pi / 2, "trough")]:
        h = ((target - ph) % (2 * np.pi)) * p / (2 * np.pi)
        if h < 1:
            h += p
        while h <= 3 * p and len(out) < 2 * n:
            out.append((h, kind))
            h += p
    out.sort()
    return out[:n]


def _norm_cdf(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def backtest(logc: np.ndarray, step=5, samples=50):
    n = len(logc)
    start = max(300, n - BT_H - step * samples)
    rec = []
    for i in range(start, n - BT_H, step):
        hist = logc[: i + 1]
        mu, sig = drift_vol(hist)
        cyc = dominant_cycle(hist)
        actual = logc[i + BT_H] - logc[i]
        d_drift = mu * BT_H
        d_cyc = d_drift + cycle_delta(cyc, BT_H)
        band = Z80 * sig * math.sqrt(BT_H)
        rec.append((actual, d_drift, d_cyc, band))
    if len(rec) < 10:
        return None
    a = np.array(rec)
    act, dd, dc, band = a[:, 0], a[:, 1], a[:, 2], a[:, 3]
    nz = act != 0
    return {
        "n": int(len(a)), "h": BT_H,
        "dir_drift": float(np.mean(np.sign(dd[nz]) == np.sign(act[nz]))),
        "dir_cycle": float(np.mean(np.sign(dc[nz]) == np.sign(act[nz]))),
        "cov80": float(np.mean(np.abs(act - dd) <= band)),
        "cov80_cycle": float(np.mean(np.abs(act - dc) <= band)),
        "mae_drift": float(np.mean(np.abs(np.exp(act) - np.exp(dd)))),
        "mae_cycle": float(np.mean(np.abs(np.exp(act) - np.exp(dc)))),
        "base_up": float(np.mean(act > 0)),
    }


def future_dates(last: pd.Timestamp, n: int, calendar: bool):
    if calendar:
        return pd.date_range(last + pd.Timedelta(days=1), periods=n, freq="D")
    return pd.bdate_range(last + pd.Timedelta(days=1), periods=n)


def forecast(close: pd.Series, calendar: bool, msym: dict, grp: str):
    """Assemble the per-symbol forecast block.

    Direction and ranges come from the pooled model (model.py): msym = {"mz": {h: z}, "sigma",
    "hit21", "n21"}. The dominant cycle is added on top only when its own walk-forward test
    on this symbol beat the no-cycle forecast.
    """
    logc = np.log(close.dropna().values.astype(float))
    if len(logc) < 120:
        return None
    p0 = float(np.exp(logc[-1]))
    cyc = dominant_cycle(logc)
    bt = backtest(logc)
    use_cycle = bool(cyc and bt and cyc["strength"] >= 0.25
                     and bt["dir_cycle"] > max(bt["dir_drift"], 0.5)
                     and bt["mae_cycle"] <= bt["mae_drift"])
    last = close.dropna().index[-1]
    dates = future_dates(last, 63 * 2, calendar)
    turns = []
    if cyc and cyc["strength"] >= 0.15:
        for h, kind in next_turns(cyc):
            k = int(round(h))
            if 1 <= k <= len(dates):
                turns.append({"date": dates[k - 1].strftime("%Y-%m-%d"), "type": kind, "bars": k})
    return {
        "p0": p0, "asof": last.strftime("%Y-%m-%d"), "calendar": calendar, "grp": grp,
        "sigma": msym.get("sigma"), "mz": msym.get("mz", {}),
        "cycle": cyc, "use_cycle": use_cycle, "turns": turns,
        "acc": {"dir": msym["hit21"], "n": msym["n21"], "h": 21} if msym.get("hit21") is not None else None,
    }
