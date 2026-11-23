# Multi-Asset Screener

Stocks · ETFs · Indices · Crypto screener with a single 0–100 composite score built from a
non-redundant, evidence-based indicator set (trend, momentum, relative strength, volume,
entry timing, and Piotroski/Altman quality for stocks). Runs free on GitHub Pages; data is
refreshed by GitHub Actions — no server and no API keys.

## Deploy (about 5 minutes)

1. Create a new **public** repository on GitHub, e.g. `izadm1/screener`.
2. Upload every file in this folder (keep the folder structure, including `.github/` and `.nojekyll`).
3. **Settings → Actions → General → Workflow permissions** → choose *Read and write permissions* → Save.
4. **Actions** tab → *Update screener data* → **Run workflow**. First run takes ~5–10 minutes
   (it pulls 2 years of daily bars plus fundamentals). It commits `data/screener.json` and `data/history/`.
5. **Settings → Pages** → Source: *Deploy from a branch* → Branch `main`, folder `/ (root)` → Save.
6. Open `https://izadm1.github.io/screener/`.

After that it refreshes automatically: once after the US close (05:15 MYT, Tue–Sat) and three times
a day for crypto/Asia (09:00, 15:00, 21:00 MYT). Fundamentals refresh weekly.

## Customise

- **Symbols:** edit `scripts/universe.py` (Yahoo Finance tickers; e.g. Bursa stocks use `.KL`, such as `1155.KL`).
- **Weights / rules:** `score_class()` and `signals()` in `scripts/build_data.py`.
- **Schedule:** the `cron` lines in `.github/workflows/update.yml` (times are UTC).

## Run locally

```bash
pip install -r requirements.txt
python scripts/build_data.py
python -m http.server 8000   # then open http://localhost:8000
```

## Data sources

- Daily OHLCV and fundamentals: Yahoo Finance via `yfinance` (unofficial; can occasionally break or rate-limit — rerun the workflow).
- Crypto Fear & Greed: alternative.me. BTC dominance: CoinGecko.
- Crypto funding rate and long/short ratio: Binance Futures, fetched live in the viewer's browser.

Research tool only — not investment advice.
