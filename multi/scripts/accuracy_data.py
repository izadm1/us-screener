"""Download test data for the terminal accuracy test: 5y daily + 730d hourly bars."""
import json, os, sys
import pandas as pd
import yfinance as yf

OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/acc"
FULL = sys.argv[2] if len(sys.argv) > 2 else None  # optional: 5y daily bars for the whole screener universe (quality model)
UNIVERSE = ["BTC-USD", "ETH-USD", "SOL-USD", "XRP-USD", "BNB-USD", "ADA-USD", "DOGE-USD",
            "EURUSD=X", "GBPUSD=X", "USDJPY=X", "AUDUSD=X", "USDCAD=X", "USDCHF=X", "NZDUSD=X", "GC=F",
            "SPY", "QQQ", "IWM", "DIA", "AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "TSLA", "JPM", "XOM", "UNH"]
os.makedirs(OUT, exist_ok=True)


def dump(df, path):
    df = df[["Open", "High", "Low", "Close", "Volume"]].dropna(subset=["Close"])
    idx = df.index.tz_convert("UTC") if df.index.tz is not None else df.index
    rec = [{"t": int(t.timestamp()), "o": float(o), "h": float(h), "l": float(l), "c": float(c), "v": float(v) if v == v else 0.0}
           for t, o, h, l, c, v in zip(idx, df.Open, df.High, df.Low, df.Close, df.Volume)]
    json.dump(rec, open(path, "w"))
    return len(rec)


for interval, period, tag in [("1d", "5y", "1D"), ("60m", "730d", "1H")]:
    raw = yf.download(UNIVERSE, period=period, interval=interval, group_by="ticker", auto_adjust=True, threads=True, progress=False)
    for s in UNIVERSE:
        try:
            n = dump(raw[s], os.path.join(OUT, f"{s.replace('=', '_')}__{tag}.json"))
            print(tag, s, n)
        except Exception as e:
            print("skip", tag, s, e)

if FULL:
    sys.path.insert(0, os.path.dirname(__file__))
    import universe as U
    os.makedirs(FULL, exist_ok=True)
    full = list(dict.fromkeys(U.STOCKS + U.ETFS + list(U.INDICES) + U.CRYPTO + list(U.FOREX) + UNIVERSE))
    for i in range(0, len(full), 40):
        chunk = full[i:i + 40]
        raw = yf.download(chunk, period="5y", interval="1d", group_by="ticker", auto_adjust=True, threads=True, progress=False)
        for s in chunk:
            try:
                n = dump(raw[s], os.path.join(FULL, f"{s.replace('=', '_')}__1D.json"))
                print("full", s, n)
            except Exception as e:
                print("skip full", s, e)
