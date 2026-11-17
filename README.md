# US Day-Trading Screener (website)

A GitHub Action runs `us_screener.py` on weekdays before the US open (20:45 Malaysia time) and hourly while the market is open, and publishes the report to GitHub Pages.

## One-time setup
1. Create a new **public** repository on GitHub (e.g. `us-screener`) and upload every file in this folder, including the `.github` folder.
2. In the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. **Actions** tab → *Daily screener* → **Run workflow** to publish the first report.
4. Your site: `https://<your-github-username>.github.io/us-screener/`

Change the universe, filters or sizing in the SETTINGS block at the top of `us_screener.py`; the next run uses them.

Research aid only — not investment advice.
