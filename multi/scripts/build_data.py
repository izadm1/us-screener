"""Builds data/screener.json and data/history/*.json for the website.

Run:  python scripts/build_data.py
Runs on GitHub Actions on a schedule (see .github/workflows/update.yml).
"""
import json
import math
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
import indicators as ind  # noqa: E402
import universe as U  # noqa: E402
import forecast as FC  # noqa: E402
import model as MDL  # noqa: E402
import structure as STR  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DATA = os.path.join(ROOT, "data")
HIST = os.path.join(DATA, "history")
FUND_CACHE = os.path.join(DATA, "fundamentals.json")
FUND_MAX_AGE_DAYS = 7
HIST_BARS = 260


# ---------------------------------------------------------------- download
def download(tickers, period="5y"):
    import yfinance as yf

    out = {}
    tickers = list(dict.fromkeys(tickers))
    for i in range(0, len(tickers), 40):
        chunk = tickers[i : i + 40]
        for attempt in range(3):
            try:
                raw = yf.download(chunk, period=period, interval="1d", group_by="ticker",
                                  auto_adjust=True, threads=True, progress=False)
                break
            except Exception as e:  # network hiccup
                print("download retry", attempt, e)
                time.sleep(5)
        else:
            continue
        for t in chunk:
            try:
                df = raw[t] if isinstance(raw.columns, pd.MultiIndex) else raw
                df = df[["Open", "High", "Low", "Close", "Volume"]].dropna(subset=["Close"])
                if len(df) >= 60:
                    out[t] = df
            except Exception:
                pass
    return out


# ---------------------------------------------------------------- fundamentals
def _row(df, names, col=0):
    if df is None or df.empty:
        return np.nan
    for n in names:
        if n in df.index:
            try:
                v = df.loc[n].iloc[col]
                return float(v) if pd.notna(v) else np.nan
            except Exception:
                pass
    return np.nan


def fundamentals_for(sym):
    """Piotroski F-score (0-9) and Altman Z-score from annual statements."""
    import yfinance as yf

    t = yf.Ticker(sym)
    res = {"asof": datetime.now(timezone.utc).strftime("%Y-%m-%d")}
    try:
        info = t.get_info()
        res["name"] = info.get("shortName") or info.get("longName")
        res["sector"] = info.get("sector")
        res["mcap"] = info.get("marketCap")
    except Exception:
        pass
    try:
        inc, bs, cf = t.financials, t.balance_sheet, t.cashflow
        if inc is None or inc.empty or bs is None or bs.empty or bs.shape[1] < 2 or inc.shape[1] < 2:
            return res
        g = lambda df, n, c=0: _row(df, n, c)  # noqa: E731
        ni0, ni1 = g(inc, ["Net Income"]), g(inc, ["Net Income"], 1)
        ta0, ta1 = g(bs, ["Total Assets"]), g(bs, ["Total Assets"], 1)
        cfo0 = g(cf, ["Operating Cash Flow", "Cash Flow From Continuing Operating Activities"])
        ltd0 = g(bs, ["Long Term Debt", "Long Term Debt And Capital Lease Obligation"])
        ltd1 = g(bs, ["Long Term Debt", "Long Term Debt And Capital Lease Obligation"], 1)
        ca0, ca1 = g(bs, ["Current Assets"]), g(bs, ["Current Assets"], 1)
        cl0, cl1 = g(bs, ["Current Liabilities"]), g(bs, ["Current Liabilities"], 1)
        sh0 = g(bs, ["Ordinary Shares Number", "Share Issued"])
        sh1 = g(bs, ["Ordinary Shares Number", "Share Issued"], 1)
        gp0, gp1 = g(inc, ["Gross Profit"]), g(inc, ["Gross Profit"], 1)
        rv0, rv1 = g(inc, ["Total Revenue"]), g(inc, ["Total Revenue"], 1)
        ok = lambda x: x is not None and not (isinstance(x, float) and math.isnan(x))  # noqa: E731
        f = 0
        roa0 = ni0 / ta0 if ok(ni0) and ok(ta0) and ta0 else np.nan
        roa1 = ni1 / ta1 if ok(ni1) and ok(ta1) and ta1 else np.nan
        f += int(ok(roa0) and roa0 > 0)
        f += int(ok(cfo0) and cfo0 > 0)
        f += int(ok(roa0) and ok(roa1) and roa0 > roa1)
        f += int(ok(cfo0) and ok(ni0) and cfo0 > ni0)
        lev0 = (ltd0 if ok(ltd0) else 0) / ta0 if ok(ta0) else np.nan
        lev1 = (ltd1 if ok(ltd1) else 0) / ta1 if ok(ta1) else np.nan
        f += int(ok(lev0) and ok(lev1) and lev0 <= lev1)
        f += int(ok(ca0) and ok(cl0) and ok(ca1) and ok(cl1) and cl0 and cl1 and ca0 / cl0 > ca1 / cl1)
        f += int(ok(sh0) and ok(sh1) and sh0 <= sh1)
        f += int(ok(gp0) and ok(gp1) and ok(rv0) and ok(rv1) and rv0 and rv1 and gp0 / rv0 > gp1 / rv1)
        f += int(ok(rv0) and ok(rv1) and ok(ta0) and ok(ta1) and rv0 / ta0 > rv1 / ta1)
        res["fscore"] = f
        # Altman Z (original). Not meaningful for banks/insurers -> flagged in UI.
        wc = (ca0 - cl0) if ok(ca0) and ok(cl0) else np.nan
        re_ = g(bs, ["Retained Earnings"])
        ebit = g(inc, ["EBIT", "Operating Income"])
        tl = g(bs, ["Total Liabilities Net Minority Interest", "Total Liabilities"])
        mcap = res.get("mcap")
        if all(ok(x) for x in [wc, re_, ebit, tl, rv0, ta0]) and mcap and ta0 and tl:
            z = 1.2 * wc / ta0 + 1.4 * re_ / ta0 + 3.3 * ebit / ta0 + 0.6 * mcap / tl + 1.0 * rv0 / ta0
            res["altz"] = round(float(z), 2)
    except Exception as e:
        print("fundamentals failed", sym, e)
    return res


def load_fundamentals(symbols, etfs):
    cache = {}
    if os.path.exists(FUND_CACHE):
        with open(FUND_CACHE) as fh:
            cache = json.load(fh)
    today = datetime.now(timezone.utc)

    def stale(s):
        a = cache.get(s, {}).get("asof")
        return not a or (today - datetime.strptime(a, "%Y-%m-%d").replace(tzinfo=timezone.utc)).days >= FUND_MAX_AGE_DAYS

    todo = [s for s in symbols if stale(s)]
    todo_etf = [s for s in etfs if stale(s)]
    print(f"fundamentals: refreshing {len(todo)} stocks, {len(todo_etf)} ETF names")

    def etf_meta(s):
        import yfinance as yf
        try:
            info = yf.Ticker(s).get_info()
            return {"asof": today.strftime("%Y-%m-%d"), "name": info.get("shortName") or info.get("longName")}
        except Exception:
            return {"asof": today.strftime("%Y-%m-%d")}

    with ThreadPoolExecutor(6) as ex:
        for s, r in zip(todo, ex.map(fundamentals_for, todo)):
            cache[s] = r
        for s, r in zip(todo_etf, ex.map(etf_meta, todo_etf)):
            cache[s] = r
    with open(FUND_CACHE, "w") as fh:
        json.dump(cache, fh, indent=0)
    return cache


# ---------------------------------------------------------------- features
def ret(c, n):
    return float(c.iloc[-1] / c.iloc[-1 - n] - 1) if len(c) > n else np.nan


def features(sym, df):
    x = ind.compute_all(df)
    last, c = x.iloc[-1], x["Close"]
    vol = x["Volume"].fillna(0)
    has_vol = vol.tail(20).sum() > 0
    hi252 = x["High"].tail(252).max()
    f = {
        "sym": sym,
        "price": float(last.Close),
        "chg1d": ret(c, 1), "chg5d": ret(c, 5), "chg1m": ret(c, 21),
        "ret63": ret(c, 63), "ret126": ret(c, 126),
        # 12-1 month momentum (skip latest month: avoids short-term reversal)
        "mom12_1": float(c.iloc[-22] / c.iloc[-253] - 1) if len(c) > 253 else np.nan,
        "rsi14": last.rsi14, "rsi2": last.rsi2,
        "macd_hist": last.macd_hist,
        "macd_rising": bool(x["macd_hist"].iloc[-1] > x["macd_hist"].iloc[-2]),
        "adx": last.adx, "pdi": last.pdi, "mdi": last.mdi,
        "pct_b": last.pct_b, "z20": last.z20,
        "atr_pct": last.atr14 / last.Close if last.Close else np.nan,
        "relvol": (vol.iloc[-1] / last.vol_avg20) if has_vol and last.vol_avg20 else np.nan,
        "obv_slope": ind.slope_pct(x["obv"], 20) if has_vol else np.nan,
        "dist52h": float(last.Close / hi252 - 1),
        "above20": bool(last.Close > last.ema20) if pd.notna(last.ema20) else None,
        "above50": bool(last.Close > last.ema50) if pd.notna(last.ema50) else None,
        "above200": bool(last.Close > last.ema200) if pd.notna(last.ema200) else None,
        "golden": bool(last.ema50 > last.ema200) if pd.notna(last.ema200) else None,
        "st_dir": int(last.st_dir), "st_stop": last.st_stop,
        "div": ind.divergence(c, x["rsi14"]),
        "bars": len(x),
        "date": x.index[-1].strftime("%Y-%m-%d"),
    }
    return f, x


def pct_rank(values):
    s = pd.Series(values, dtype=float)
    return s.rank(pct=True).values  # NaN stays NaN


def clean(v):
    if isinstance(v, dict):
        return {k: clean(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [clean(x) for x in v]
    if isinstance(v, (np.floating, float)):
        return None if (v is None or math.isnan(v) or math.isinf(v)) else round(float(v), 6)
    if isinstance(v, np.integer):
        return int(v)
    if isinstance(v, np.bool_):
        return bool(v)
    return v


# ---------------------------------------------------------------- scoring
def score_class(rows, cls, bench_ret63):
    mom = pct_rank([r["mom12_1"] for r in rows])
    roc = pct_rank([r["ret63"] for r in rows])
    rs = pct_rank([(r["ret63"] - bench_ret63) if bench_ret63 is not None and not math.isnan(r["ret63"]) else np.nan for r in rows])
    for i, r in enumerate(rows):
        b = {}
        # 1) TREND — the most robust factor family (time-series momentum / trend following)
        t = 0
        t += 25 if r["above200"] else 0
        t += 20 if r["golden"] else 0
        t += 15 if r["above50"] else 0
        t += 10 if r["above20"] else 0
        t += 15 if r["st_dir"] == 1 else 0
        if not math.isnan(r["adx"]):
            t += 15 if (r["adx"] > 20 and r["pdi"] > r["mdi"]) else (7 if r["pdi"] > r["mdi"] else 0)
        if r["above200"] is None:  # short history (new listing / coin)
            t = t / 0.75
        b["trend"] = min(t, 100)
        # 2) MOMENTUM — cross-sectional rank within the asset class
        m_r = mom[i] if not math.isnan(mom[i]) else roc[i]
        mac = 20 if (r["macd_hist"] > 0 and r["macd_rising"]) else (10 if r["macd_hist"] > 0 else 0)
        b["momentum"] = None if math.isnan(m_r) else 50 * m_r + 30 * (roc[i] if not math.isnan(roc[i]) else m_r) + mac
        # 3) RELATIVE STRENGTH vs benchmark
        b["relstr"] = None if math.isnan(rs[i]) else 100 * rs[i]
        # 4) VOLUME confirmation
        if math.isnan(r["obv_slope"]):
            b["volume"] = None
        else:
            up_day = r["chg1d"] > 0
            rv = 0 if math.isnan(r["relvol"]) else r["relvol"]
            b["volume"] = 60 * (r["obv_slope"] > 0) + (40 * min(rv / 2, 1) if up_day else 0)
        # 5) TIMING — buy pullbacks in uptrends, avoid chasing stretched moves
        if r["above200"] or (r["above200"] is None and r["st_dir"] == 1):
            tm = 50
            if -2.0 <= r["z20"] <= 0.5:
                tm += 20
            if 40 <= r["rsi14"] <= 65:
                tm += 15
            if r["rsi2"] < 10:
                tm += 15
            if r["rsi14"] > 75 or r["z20"] > 2.2:
                tm = 15
        else:
            tm = 25 if r["rsi14"] < 30 else 10
        b["timing"] = min(tm, 100)
        # 6) QUALITY (stocks only) — Piotroski F, Altman Z distress filter
        if cls == "stocks" and r.get("fscore") is not None:
            q = r["fscore"] / 9 * 100
            if r.get("altz") is not None and r["altz"] < 1.81 and r.get("sector") != "Financial Services":
                q = min(q, 30)
            b["quality"] = q
        else:
            b["quality"] = None

        weights = {"trend": .30, "momentum": .25, "relstr": .15, "volume": .10, "timing": .10, "quality": .10}
        num = sum(weights[k] * v for k, v in b.items() if v is not None)
        den = sum(weights[k] for k, v in b.items() if v is not None)
        r["score"] = round(num / den, 1) if den else None
        r["buckets"] = {k: (round(v) if v is not None else None) for k, v in b.items()}
        r["signals"] = signals(r)


def signals(r):
    s = []
    up = bool(r["above200"]) and bool(r["golden"])
    down = r["above200"] is False and r["golden"] is False
    if up and r["st_dir"] == 1 and (r["score"] or 0) >= 70 and r["rsi14"] < 72:
        s.append("Strong trend")
    if r["dist52h"] > -0.02 and (r["relvol"] or 0) >= 1.5 and r["chg1d"] > 0:
        s.append("Breakout")
    if up and (r["z20"] < -1 or r["rsi14"] < 40):
        s.append("Pullback in uptrend")
    if r["above200"] and r["rsi2"] < 10:
        s.append("RSI(2) oversold")
    if r["rsi14"] > 75 or r["z20"] > 2.2:
        s.append("Overextended")
    if r["div"] == "bullish":
        s.append("Bullish divergence")
    if r["div"] == "bearish":
        s.append("Bearish divergence")
    if down:
        s.append("Downtrend")
    fc = r.get("fc") or {}
    for t in (fc.get("turns") or [])[:1]:
        if t["bars"] <= 5 and (fc.get("cycle") or {}).get("strength", 0) >= 0.3:
            s.append("Cycle trough due" if t["type"] == "trough" else "Cycle peak due")
    if r.get("altz") is not None and r["altz"] < 1.81 and r.get("sector") != "Financial Services":
        s.append("Distress risk")
    return s


# ---------------------------------------------------------------- macro
def macro_block(frames):
    out = {}
    for sym, label in U.MACRO.items():
        df = frames.get(sym)
        if df is None:
            continue
        x = ind.compute_all(df)
        last = x.iloc[-1]
        out[sym] = {
            "label": label, "price": clean(last.Close), "chg1d": clean(ret(x.Close, 1)),
            "chg1m": clean(ret(x.Close, 21)),
            "above200": bool(last.Close > last.ema200) if pd.notna(last.ema200) else None,
            "trend": int(last.st_dir),
        }
    regime = {}
    spx, vix = out.get("^GSPC"), out.get("^VIX")
    if spx and vix:
        v = vix["price"] or 0
        if spx["above200"] and v < 20:
            regime["equity"] = ("Risk-on", "S&P 500 above 200-day EMA and VIX below 20")
        elif (spx["above200"] is False) or v > 28:
            regime["equity"] = ("Risk-off", "S&P 500 below 200-day EMA or VIX above 28 — favour cash / smaller size")
        else:
            regime["equity"] = ("Neutral", "Mixed: trend and volatility disagree — be selective")
    btc = out.get("BTC-USD")
    if btc:
        if btc["above200"] and btc["trend"] == 1:
            regime["crypto"] = ("Risk-on", "BTC above 200-day EMA with ATR trail up")
        elif btc["above200"] is False and btc["trend"] == -1:
            regime["crypto"] = ("Risk-off", "BTC below 200-day EMA with ATR trail down")
        else:
            regime["crypto"] = ("Neutral", "BTC trend signals mixed")
    return out, regime


def crypto_sentiment():
    import requests

    res = {}
    try:
        j = requests.get("https://api.alternative.me/fng/?limit=2", timeout=15).json()
        res["fear_greed"] = {"value": int(j["data"][0]["value"]), "label": j["data"][0]["value_classification"],
                             "prev": int(j["data"][1]["value"])}
    except Exception as e:
        print("fng failed", e)
    try:
        g = requests.get("https://api.coingecko.com/api/v3/global", timeout=15).json()["data"]
        res["btc_dominance"] = round(g["market_cap_percentage"]["btc"], 2)
        res["eth_dominance"] = round(g["market_cap_percentage"]["eth"], 2)
        res["mcap_chg24h"] = round(g["market_cap_change_percentage_24h_usd"], 2)
    except Exception as e:
        print("coingecko failed", e)
    return res


# ---------------------------------------------------------------- output
def safe_name(sym):
    return "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in sym)


def write_history(sym, x):
    t = x.tail(HIST_BARS)
    rec = {
        "t": [int(i.timestamp()) for i in t.index],
        **{k: [clean(v) for v in t[col].round(6).values] for k, col in
           [("o", "Open"), ("h", "High"), ("l", "Low"), ("c", "Close"), ("v", "Volume"),
            ("e20", "ema20"), ("e50", "ema50"), ("e200", "ema200"), ("st", "st_stop"),
            ("rsi", "rsi14"), ("mh", "macd_hist")]},
        "sd": [int(v) for v in t["st_dir"].values],
    }
    with open(os.path.join(HIST, safe_name(sym) + ".json"), "w") as fh:
        json.dump(rec, fh, separators=(",", ":"))


def build(frames=None, fundamentals=None, sentiment=None):
    os.makedirs(HIST, exist_ok=True)
    classes = {"stocks": U.STOCKS, "etfs": U.ETFS, "indices": list(U.INDICES), "crypto": U.CRYPTO, "forex": list(U.FOREX)}
    if frames is None:
        all_syms = sum(classes.values(), []) + list(U.MACRO) + [b for b in U.BENCH.values() if b]
        frames = download(all_syms)
    if fundamentals is None:
        fundamentals = load_fundamentals(U.STOCKS, U.ETFS)
    if sentiment is None:
        sentiment = crypto_sentiment()

    result = {"generated": datetime.now(timezone.utc).isoformat(timespec="minutes"), "classes": {}, "model": {}}
    GROUP = {"stocks": "equity", "etfs": "equity", "indices": "equity", "crypto": "crypto", "forex": "forex"}
    rows_by_cls, xs = {}, {}
    for cls, syms in classes.items():
        rows = []
        for s in syms:
            df = frames.get(s)
            if df is None:
                continue
            try:
                f, x = features(s, df)
                f["ms"] = STR.structure(x, calendar=(cls == "crypto"))
            except Exception as e:
                print("features failed", s, e)
                continue
            meta = fundamentals.get(s, {})
            if cls == "indices":
                f["name"] = U.INDICES[s]
            elif cls == "forex":
                f["label"], f["name"], f["group"] = U.FOREX[s]
            elif cls == "crypto":
                f["name"] = s.split("-")[0].rstrip("0123456789")
            else:
                f["name"] = meta.get("name") or s
            if cls == "stocks":
                f.update({"fscore": meta.get("fscore"), "altz": meta.get("altz"),
                          "sector": meta.get("sector"), "mcap": meta.get("mcap")})
            rows.append(f)
            xs.setdefault(GROUP[cls], {})[s] = x
            write_history(s, x)
        rows_by_cls[cls] = rows
    msym = {}
    for g, xd in xs.items():
        try:
            per, stats = MDL.fit_group({s: MDL.features(x) for s, x in xd.items()})
            msym.update(per)
            result["model"][g] = stats
            print(g, {h: (v["ic_oos"], v["hit_oos"], v["k"]) for h, v in stats["h"].items()})
        except Exception as e:
            print("model failed", g, e)
    for cls, rows in rows_by_cls.items():
        bench = frames.get(U.BENCH.get(cls)) if U.BENCH.get(cls) else None
        bench_r63 = ret(bench["Close"], 63) if bench is not None else None
        for f in rows:
            try:
                f["fc"] = FC.forecast(frames[f["sym"]]["Close"], calendar=(cls == "crypto"),
                                      msym=msym.get(f["sym"], {}), grp=GROUP[cls])
            except Exception as e:
                print("forecast failed", f["sym"], e)
                f["fc"] = None
        score_class(rows, cls, bench_r63)
        rows.sort(key=lambda r: -(r["score"] or 0))
        result["classes"][cls] = [{k: clean(v) for k, v in r.items()} for r in rows]
        print(f"{cls}: {len(rows)} symbols")
    macro, regime = macro_block(frames)
    result["macro"], result["regime"], result["crypto_sentiment"] = macro, regime, sentiment
    with open(os.path.join(DATA, "screener.json"), "w") as fh:
        json.dump(result, fh, separators=(",", ":"))
    return result


if __name__ == "__main__":
    build()
