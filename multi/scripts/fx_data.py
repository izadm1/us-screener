"""Download forex test data: 10y daily + 730d hourly for the 12 main pairs + gold."""
import json, os, sys
import yfinance as yf

OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/fx"
SYMS = ["EURUSD=X", "USDJPY=X", "GBPUSD=X", "USDCHF=X", "AUDUSD=X", "USDCAD=X", "NZDUSD=X",
        "EURGBP=X", "EURJPY=X", "GBPJPY=X", "AUDJPY=X", "GC=F"]
os.makedirs(OUT, exist_ok=True)
for interval, period, tag in [("1d", "10y", "1D"), ("60m", "730d", "1H")]:
    raw = yf.download(SYMS, period=period, interval=interval, group_by="ticker", auto_adjust=True, threads=True, progress=False)
    for s in SYMS:
        try:
            df = raw[s][["Open", "High", "Low", "Close"]].dropna()
            df = df[(df.Close > 0) & (df.High >= df.Low) & (df.Open > 0)]
            idx = df.index.tz_convert("UTC") if df.index.tz is not None else df.index
            rec = [{"t": int(t.timestamp()), "o": float(o), "h": float(h), "l": float(l), "c": float(c)}
                   for t, o, h, l, c in zip(idx, df.Open, df.High, df.Low, df.Close)]
            json.dump(rec, open(os.path.join(OUT, f"{s.replace('=', '_')}__{tag}.json"), "w"))
            print(tag, s, len(rec))
        except Exception as e:
            print("skip", tag, s, e)
