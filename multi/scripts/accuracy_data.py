"""Download test data for the terminal accuracy test: 5y daily + 730d hourly bars."""
import json, os, sys
import pandas as pd
import yfinance as yf

OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/acc"
UNIVERSE = ["BTC-USD", "ETH-USD", "SOL-USD", "XRP-USD", "BNB-USD", "ADA-USD", "DOGE-USD",
            "EURUSD=X", "GBPUSD=X", "USDJPY=X", "AUDUSD=X", "USDCAD=X", "USDCHF=X", "NZDUSD=X", "GC=F",
            "SPY", "QQQ", "IWM", "DIA", "AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "TSLA", "JPM", "XOM", "UNH"]
os.makedirs(OUT, exist_ok=True)


def dump(df, path):
    df = df[["Open", "High", "Low", "Close"]].dropna()
    idx = df.index.tz_convert("UTC") if df.index.tz is not None else df.index
    rec = [{"t": int(t.timestamp()), "o": float(o), "h": float(h), "l": float(l), "c": float(c)}
           for t, o, h, l, c in zip(idx, df.Open, df.High, df.Low, df.Close)]
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
