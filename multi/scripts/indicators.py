"""Technical indicators used by the screener.

Only a deliberately small, non-redundant set is computed. Each one represents a
distinct, evidence-backed "factor family" so the composite score does not
double-count the same information (e.g. RSI, KDJ, Williams %R and CCI all
measure the same overbought/oversold idea, so only RSI is kept).
"""
import numpy as np
import pandas as pd


def ema(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(span=n, adjust=False, min_periods=n).mean()


def sma(s: pd.Series, n: int) -> pd.Series:
    return s.rolling(n, min_periods=n).mean()


def wilder(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(alpha=1 / n, adjust=False, min_periods=n).mean()


def rsi(close: pd.Series, n: int = 14) -> pd.Series:
    d = close.diff()
    up = wilder(d.clip(lower=0), n)
    dn = wilder(-d.clip(upper=0), n)
    rs = up / dn.replace(0, np.nan)
    out = 100 - 100 / (1 + rs)
    return out.fillna(100.0).where(dn.notna())


def macd(close: pd.Series, fast=12, slow=26, sig=9):
    line = ema(close, fast) - ema(close, slow)
    signal = ema(line, sig)
    return line, signal, line - signal


def atr(h, l, c, n=14):
    pc = c.shift(1)
    tr = pd.concat([h - l, (h - pc).abs(), (l - pc).abs()], axis=1).max(axis=1)
    return wilder(tr, n)


def adx(h, l, c, n=14):
    """DMI / ADX: +DI, -DI and ADX (trend strength)."""
    up = h.diff()
    dn = -l.diff()
    plus_dm = pd.Series(np.where((up > dn) & (up > 0), up, 0.0), index=h.index)
    minus_dm = pd.Series(np.where((dn > up) & (dn > 0), dn, 0.0), index=h.index)
    a = atr(h, l, c, n)
    pdi = 100 * wilder(plus_dm, n) / a
    mdi = 100 * wilder(minus_dm, n) / a
    dx = 100 * (pdi - mdi).abs() / (pdi + mdi).replace(0, np.nan)
    return pdi, mdi, wilder(dx, n)


def bollinger(close, n=20, k=2.0):
    mid = sma(close, n)
    sd = close.rolling(n, min_periods=n).std(ddof=0)
    upper, lower = mid + k * sd, mid - k * sd
    pct_b = (close - lower) / (upper - lower)
    zscore = (close - mid) / sd  # "sigma-zone" position, like ELCARO's Trading Filter
    return mid, upper, lower, pct_b, zscore


def obv(close, vol):
    direction = np.sign(close.diff()).fillna(0)
    return (direction * vol).cumsum()


def slope_pct(s: pd.Series, n: int) -> float:
    """Linear-regression slope over the last n points, as % of mean abs level."""
    y = s.dropna().tail(n).values
    if len(y) < n:
        return np.nan
    x = np.arange(n)
    m = np.polyfit(x, y, 1)[0]
    denom = np.mean(np.abs(y)) or 1.0
    return float(m * n / denom * 100)


def supertrend(h, l, c, n=10, mult=3.0):
    """ATR trailing stop (open equivalent of a 'Trend Trail').

    Returns (stop_line, direction) where direction = 1 uptrend, -1 downtrend.
    """
    a = atr(h, l, c, n)
    hl2 = (h + l) / 2
    ub = (hl2 + mult * a).values
    lb = (hl2 - mult * a).values
    cl = c.values
    fu, fl = ub.copy(), lb.copy()
    direction = np.ones(len(c))
    stop = np.full(len(c), np.nan)
    for i in range(1, len(c)):
        if np.isnan(ub[i]) or np.isnan(fu[i - 1]):
            continue
        fu[i] = ub[i] if (ub[i] < fu[i - 1] or cl[i - 1] > fu[i - 1]) else fu[i - 1]
        fl[i] = lb[i] if (lb[i] > fl[i - 1] or cl[i - 1] < fl[i - 1]) else fl[i - 1]
        if direction[i - 1] == 1:
            direction[i] = -1 if cl[i] < fl[i] else 1
        else:
            direction[i] = 1 if cl[i] > fu[i] else -1
        stop[i] = fl[i] if direction[i] == 1 else fu[i]
    return pd.Series(stop, index=c.index), pd.Series(direction, index=c.index)


def _pivots(s: pd.Series, k: int, kind: str):
    vals = s.values
    idx = []
    for i in range(k, len(vals) - k):
        w = vals[i - k : i + k + 1]
        if np.isnan(vals[i]):
            continue
        if kind == "low" and vals[i] == np.nanmin(w):
            idx.append(i)
        if kind == "high" and vals[i] == np.nanmax(w):
            idx.append(i)
    return idx


def divergence(close: pd.Series, osc: pd.Series, lookback=60, k=3):
    """Regular divergence between price and an oscillator over the last `lookback` bars.

    bullish: price lower low, oscillator higher low
    bearish: price higher high, oscillator lower high
    Only pivots confirmed in the most recent 15 bars count, so signals are fresh.
    """
    c = close.tail(lookback).reset_index(drop=True)
    o = osc.tail(lookback).reset_index(drop=True)
    res = None
    lows = _pivots(c, k, "low")
    if len(lows) >= 2 and lows[-1] >= len(c) - 15 - k:
        a, b = lows[-2], lows[-1]
        if c[b] < c[a] and o[b] > o[a]:
            res = "bullish"
    highs = _pivots(c, k, "high")
    if len(highs) >= 2 and highs[-1] >= len(c) - 15 - k:
        a, b = highs[-2], highs[-1]
        if c[b] > c[a] and o[b] < o[a]:
            res = "bearish" if res is None else res
    return res


def compute_all(df: pd.DataFrame) -> pd.DataFrame:
    """df columns: Open High Low Close Volume (daily). Returns df with indicator columns."""
    out = df.copy()
    c, h, l, v = out["Close"], out["High"], out["Low"], out["Volume"].fillna(0)
    out["ema20"], out["ema50"], out["ema200"] = ema(c, 20), ema(c, 50), ema(c, 200)
    out["rsi14"], out["rsi2"] = rsi(c, 14), rsi(c, 2)
    out["macd"], out["macd_sig"], out["macd_hist"] = macd(c)
    out["atr14"] = atr(h, l, c, 14)
    out["pdi"], out["mdi"], out["adx"] = adx(h, l, c, 14)
    _, out["bb_up"], out["bb_lo"], out["pct_b"], out["z20"] = bollinger(c)
    out["obv"] = obv(c, v)
    out["st_stop"], out["st_dir"] = supertrend(h, l, c)
    out["vol_avg20"] = sma(v, 20)
    return out
