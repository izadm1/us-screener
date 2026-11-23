"""Pooled factor forecasting model with walk-forward validation.

For each asset group (equity = stocks+ETFs+indices, crypto, forex) and each horizon
h in HORIZONS (bars), the model predicts the *volatility-normalised* forward return

    y = log(P[t+h] / P[t]) / (sigma_t * sqrt(h))

from a small set of standardised technical factors measured at t, where sigma_t is the
ex-ante daily volatility (blend of EWMA(0.94) and 1-year realised). Pooling across many
assets and years gives tens of thousands of observations, so the coefficients are far
more stable than any single-asset fit.

Validation (walk-forward): the last ~252 dates with a known outcome are held out; the
model is trained only on data ending h bars before that window. Out-of-sample we report
  - IC: Spearman rank correlation of predicted vs realised (the standard quant metric)
  - hit rate: share of non-zero predictions with the right sign
  - coverage: share of outcomes inside the model's 50% and 80% ranges
The live prediction is shrunk by k = clip(IC_oos / IC_in, 0, 1): no proven out-of-sample
edge means no directional tilt. Ranges come from the empirical distribution of residuals
(filtered historical simulation), so fat tails and skew are kept.
"""
import numpy as np
import pandas as pd

HORIZONS = [1, 5, 21, 63, 126, 252]
GRID_P = [1, 2.5, 5, 10, 16, 25, 37.5, 50, 62.5, 75, 84, 90, 95, 97.5, 99]
FEATS = ["tr200", "m63", "m12_1", "r5", "rsi", "z20", "st", "adx", "e50"]
OOS_DAYS = 252


def ex_ante_vol(close: pd.Series) -> pd.Series:
    r = np.log(close).diff()
    ew = (r ** 2).ewm(alpha=0.06, adjust=False, min_periods=20).mean()
    rv = r.rolling(252, min_periods=60).var()
    v = np.sqrt(0.5 * ew + 0.5 * rv.fillna(ew))
    return v.clip(lower=1e-4)


def features(x: pd.DataFrame) -> pd.DataFrame:
    """x = indicators.compute_all output. Returns factor frame + vol, aligned to x.index."""
    c = x["Close"]
    lc = np.log(c)
    vol = ex_ante_vol(c)
    f = pd.DataFrame(index=x.index)
    f["tr200"] = (lc - np.log(x["ema200"])) / (vol * np.sqrt(200))
    f["m63"] = (lc - lc.shift(63)) / (vol * np.sqrt(63))
    f["m12_1"] = (lc.shift(21) - lc.shift(252)) / (vol * np.sqrt(231))
    f["r5"] = (lc - lc.shift(5)) / (vol * np.sqrt(5))
    f["rsi"] = (x["rsi14"] - 50) / 25
    f["z20"] = x["z20"]
    f["st"] = x["st_dir"]
    f["adx"] = (x["adx"] / 25).clip(0, 3) * np.sign(x["pdi"] - x["mdi"])
    f["e50"] = np.sign(x["ema50"] - x["ema200"])
    f = f.clip(-5, 5)
    # 12-1 momentum needs 252 bars; fall back to 0 (neutral) so younger assets still get rows
    f["m12_1"] = f["m12_1"].fillna(0.0)
    f["vol"] = vol
    f["lc"] = lc
    return f


def _ridge(X, y, lam_scale=0.05):
    n, p = X.shape
    Xc = np.column_stack([np.ones(n), X])
    xtx = Xc.T @ Xc
    lam = lam_scale * np.trace(xtx[1:, 1:]) / max(p, 1)
    pen = np.eye(p + 1) * lam
    pen[0, 0] = 0.0
    return np.linalg.solve(xtx + pen, Xc.T @ y)


def _pred(b, X):
    return b[0] + X @ b[1:]


def _spearman(a, b):
    if len(a) < 30:
        return np.nan
    return float(pd.Series(a).rank().corr(pd.Series(b).rank()))


def fit_group(feat_by_sym: dict, center: bool = False):
    """feat_by_sym: {sym: features() frame}. Returns (per_symbol, group_stats).

    center=True (forex, crypto): no reliable built-in drift, so forecasts are centred on zero and
    only the model's tilt relative to its own average is used. Equities keep their historical drift
    (the equity risk premium)."""
    per_sym = {s: {"mz": {}, "hit21": None, "n21": 0} for s in feat_by_sym}
    stats = {}
    for h in HORIZONS:
        rows = []
        for s, f in feat_by_sym.items():
            y = (f["lc"].shift(-h) - f["lc"]) / (f["vol"] * np.sqrt(h))
            d = f[FEATS].copy()
            d["y"] = y.clip(-6, 6)
            d["sym"] = s
            d["date"] = f.index
            rows.append(d.dropna())
        if not rows:
            continue
        D = pd.concat(rows, ignore_index=True)
        if len(D) < 500:
            continue
        dates = np.sort(D["date"].unique())
        if len(dates) < OOS_DAYS + h + 120:
            continue
        test_start = dates[-OOS_DAYS]
        gap_end = dates[max(0, len(dates) - OOS_DAYS - h)]
        tr = D[D["date"] < gap_end]
        te = D[D["date"] >= test_start]
        Xtr, ytr = tr[FEATS].values, tr["y"].values
        b_tr = _ridge(Xtr, ytr)
        p_tr = _pred(b_tr, Xtr)
        p_te = _pred(b_tr, te[FEATS].values)
        ic_in = _spearman(p_tr, ytr)
        ic_oos = _spearman(p_te, te["y"].values)
        k = 0.0 if (np.isnan(ic_in) or np.isnan(ic_oos) or ic_in <= 0) else float(np.clip(ic_oos / ic_in, 0, 1))
        # significance: overlapping h-bar outcomes leave ~OOS_DAYS/h independent periods per asset, and
        # assets are correlated, so effective sample ~ (OOS_DAYS/h) * sqrt(n_assets). Require t >= 2 for full weight.
        n_sym = te["sym"].nunique()
        n_eff = max(1.0, (OOS_DAYS / h) * np.sqrt(max(n_sym, 1)))
        t_ic = 0.0 if np.isnan(ic_oos) else ic_oos * np.sqrt(n_eff)
        k = float(k * np.clip(t_ic / 2.0, 0, 1))
        # demeaned direction skill: does the model's tilt beat the unconditional drift?
        nz = np.abs(p_te) > 1e-9
        hit = float(np.mean(np.sign(p_te[nz]) == np.sign(te["y"].values[nz]))) if nz.any() else np.nan
        base_up = float(np.mean(te["y"].values > 0))
        # relative skill: did assets/dates the model ranked above its median beat the median outcome?
        yv = te["y"].values
        hit_rel = float(np.mean(np.sign(p_te - np.median(p_te)) == np.sign(yv - np.median(yv))))
        # residual distribution (train) -> OOS coverage check of the ranges
        res_tr = ytr - k * p_tr
        q_tr = np.percentile(res_tr, [10, 25, 75, 90])
        r_te = te["y"].values - k * p_te
        cov80 = float(np.mean((r_te >= q_tr[0]) & (r_te <= q_tr[3])))
        cov50 = float(np.mean((r_te >= q_tr[1]) & (r_te <= q_tr[2])))
        # widen ranges if the held-out year was more volatile than training (never narrow them)
        med_tr = np.median(res_tr)
        widen = float(np.clip(np.percentile(np.abs(r_te - med_tr), 80) / max(np.percentile(np.abs(res_tr - med_tr), 80), 1e-9), 1.0, 1.5))
        # final model on everything; residual grid from all data
        X, y = D[FEATS].values, D["y"].values
        b = _ridge(X, y)
        p_all = _pred(b, X)
        off = float(np.mean(p_all)) if center else 0.0
        res = y - k * (p_all - off)
        g = np.percentile(res, GRID_P)
        g50 = g[GRID_P.index(50)]
        if center:
            g, g50 = g - g50, 0.0
        grid = (g50 + (g - g50) * widen).tolist()
        stats[str(h)] = {
            "n": int(len(D)), "n_oos": int(len(te)), "ic_in": None if np.isnan(ic_in) else round(ic_in, 4),
            "ic_oos": None if np.isnan(ic_oos) else round(ic_oos, 4), "k": round(k, 3),
            "hit_oos": None if np.isnan(hit) else round(hit, 4), "base_up_oos": round(base_up, 4),
            "hit_rel_oos": round(hit_rel, 4), "t_ic": round(float(t_ic), 2), "n_eff": round(float(n_eff), 1), "widen": round(widen, 3),
            "cov80_oos": round(cov80, 4), "cov50_oos": round(cov50, 4),
            "q": [round(v, 4) for v in grid], "coef": dict(zip(["const"] + FEATS, [round(float(v), 4) for v in b])),
        }
        # live prediction per symbol (last bar with complete features)
        for s, f in feat_by_sym.items():
            last = f[FEATS].dropna()
            if last.empty or last.index[-1] != f.index[-1]:
                continue
            per_sym[s]["mz"][str(h)] = round(float(k * (_pred(b, last.values[-1:])[0] - off)), 4)
        if h == 21:
            p_te_k = k * p_te
            for s in feat_by_sym:
                m = (te["sym"] == s).values
                mm = m & (np.abs(p_te_k) > 1e-9)
                if mm.sum() >= 40:
                    per_sym[s]["hit21"] = round(float(np.mean(np.sign(p_te_k[mm]) == np.sign(te["y"].values[mm]))), 4)
                    per_sym[s]["n21"] = int(mm.sum())
    for s, f in feat_by_sym.items():
        per_sym[s]["sigma"] = round(float(f["vol"].iloc[-1]), 6)
    return per_sym, {"grid_p": GRID_P, "h": stats}
