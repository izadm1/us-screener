/* Forex entry methods — shared by scripts/fxlab.mjs (walk-forward test), scripts/signals.mjs (live signals)
   and the browser. Each method returns candidate trades {i, side, stop, target, H, kind} on bar i (signal bar;
   the trade is entered at the NEXT bar's open). Needs tmath.js (emaA, atrA, rsiA, stA, adxA). */
var FX = (function () {
  const M = typeof module !== "undefined" ? require("./tmath.js") : window.TMX; // browser: exported by tmath.js
  const { emaA, atrA, rsiA, stA, adxA } = M;
  const hourUTC = (t) => new Date(t * 1000).getUTCHours();
  const dayKey = (t) => new Date(t * 1000).toISOString().slice(0, 10);

  // ---------- cost model: round-trip spread + slippage as a fraction of price ----------
  const COST = { "EURUSD=X": 0.00012, "USDJPY=X": 0.00012, "GBPUSD=X": 0.00015, "USDCHF=X": 0.00018, "AUDUSD=X": 0.00016, "USDCAD=X": 0.00016, "NZDUSD=X": 0.0002,
    "EURGBP=X": 0.0002, "EURJPY=X": 0.0002, "GBPJPY=X": 0.00028, "AUDJPY=X": 0.00025, "GC=F": 0.0003 };
  const cost = (sym) => COST[sym] || 0.00025;

  // ---------- daily context (trend + volatility) ----------
  function dailyCtx(D) {
    const st = stA(D, 20, 3), a = atrA(D, 14), e200 = emaA(D.map((x) => x.c), 200), e50 = emaA(D.map((x) => x.c), 50), adx = adxA(D, 14);
    const idx = {}; D.forEach((x, i) => (idx[dayKey(x.t)] = i));
    return { D, st, a, e200, e50, adx, idx };
  }
  // index of the last COMPLETED daily bar before hourly time t
  function prevDay(ctx, t) {
    let d = new Date(t * 1000); for (let k = 0; k < 6; k++) { d = new Date(d.getTime() - 864e5); const i = ctx.idx[d.toISOString().slice(0, 10)]; if (i != null) return i; }
    return null;
  }
  const adxVal = (adx, i) => (adx && adx[i] != null ? adx[i] : null);

  // live rule settings, chosen by the forex lab on the older half of the data (see data/fxlab.json)
  const FXRULE = { quiet: { z: 2.5, adx: 20, k: 1.5, H: 5, half: 1 }, std: { z: 2.5, k: 1, H: 5, half: 0 }, pairsExcluded: ["GC=F"] };
  // ---------- mean reversion core: fade a z-score stretch back toward the N-bar mean ----------
  const _adxc = new WeakMap();
  const adxA_cache = (B) => { if (!_adxc.has(B)) _adxc.set(B, adxA(B, 14)); return _adxc.get(B); };
  const zA = (B, n) => B.map((x, i) => { if (i < n - 1) return null; let s = 0, s2 = 0; for (let j = i - n + 1; j <= i; j++) { s += B[j].c; s2 += B[j].c * B[j].c; } const m = s / n, sd = Math.sqrt(Math.max(0, s2 / n - m * m)); return sd ? { z: (B[i].c - m) / sd, m } : null; });
  function mr(B, p, adxAt, kind, okBar) {
    const a = atrA(B, 14), Z = zA(B, p.n || 20), out = [];
    for (let i = 210; i < B.length; i++) { const q = Z[i], q1 = Z[i - 1]; if (!q || !q1) continue;
      if (okBar && !okBar(i)) continue;
      const ad = adxAt(i); if (!(ad != null && ad < p.adx)) continue;
      let side = 0;
      if (p.confirm) { if (q1.z >= p.z && q.z < q1.z && B[i].c < B[i - 1].c) side = -1; else if (q1.z <= -p.z && q.z > q1.z && B[i].c > B[i - 1].c) side = 1; }
      else if (Math.abs(q.z) >= p.z && Math.abs(q1.z) < p.z) side = q.z > 0 ? -1 : 1;
      if (!side) continue;
      const tgt = p.half ? (B[i].c + q.m) / 2 : q.m;
      out.push({ i, side, risk: p.k * a[i], tgtPx: tgt, Rmax: 3, H: p.H, kind });
    }
    return out;
  }

  // ---------- DAILY methods ----------
  const daily = {
    // RSI(2) pullback inside the ATR-trail trend
    d_pb(D, p) {
      const st = stA(D, 20, 3), r2 = rsiA(D, 2), a = atrA(D, 14), adx = adxA(D, 14), out = [];
      for (let i = 210; i < D.length; i++) { const d = st.dir[i]; if (st.dir[i - 1] !== d) continue;
        if (p.adx && !(adxVal(adx, i) > p.adx)) continue;
        if (d > 0 ? r2[i] < p.th && r2[i - 1] >= p.th : r2[i] > 100 - p.th && r2[i - 1] <= 100 - p.th) out.push({ i, side: d, risk: p.k * a[i], Rm: p.Rm, H: p.H, kind: "Trend pullback (daily)" }); }
      return out;
    },
    // ATR-trail trend flip (the site's current trend signal), for comparison
    d_trail(D, p) {
      const st = stA(D, 20, 3), a = atrA(D, 14), out = [];
      for (let i = 210; i < D.length; i++) if (st.dir[i] !== st.dir[i - 1]) out.push({ i, side: st.dir[i], risk: p.k * a[i], Rm: p.Rm, H: p.H, kind: "Trend flip (daily)" });
      return out;
    },
    // Donchian breakout with long-term trend filter
    d_brk(D, p) {
      const a = atrA(D, 14), e = emaA(D.map((x) => x.c), 200), out = [];
      for (let i = 210; i < D.length; i++) { let hi = -Infinity, lo = Infinity; for (let j = i - p.N; j < i; j++) { hi = Math.max(hi, D[j].h); lo = Math.min(lo, D[j].l); }
        const up = D[i].c > hi && D[i - 1].c <= hi, dn = D[i].c < lo && D[i - 1].c >= lo;
        if (up && (!p.tf || D[i].c > e[i])) out.push({ i, side: 1, risk: p.k * a[i], Rm: p.Rm, H: p.H, kind: `${p.N}-day breakout` });
        if (dn && (!p.tf || D[i].c < e[i])) out.push({ i, side: -1, risk: p.k * a[i], Rm: p.Rm, H: p.H, kind: `${p.N}-day breakout` }); }
      return out;
    },
    // Mean reversion in quiet (low-ADX) markets: fade 2σ stretches back toward the 20-day mean
    // live forex rule: ★ high-accuracy plan in quiet markets (ADX<20), standard plan otherwise
    d_fx(D, p) {
      const A = adxA_cache(D);
      const quiet = mr(D, { ...FXRULE.quiet, adx: FXRULE.quiet.adx }, (i) => adxVal(A, i), "★ Range reversion");
      const std = p.tier === "quiet" ? [] : mr(D, { ...FXRULE.std, adx: 999 }, (i) => { const v = adxVal(A, i); return v != null && v >= FXRULE.quiet.adx ? v : null; }, "Range reversion");
      return quiet.map((x) => ({ ...x, tier: "quiet" })).concat(p.tier === "quiet" ? [] : std.map((x) => ({ ...x, tier: "std" }))).filter((x) => !p.tier || p.tier === "all" || x.tier === p.tier).sort((a, b) => a.i - b.i);
    },
    d_mr(D, p) { return mr(D, p, (i) => adxVal(adxA_cache(D), i), "Range reversion (daily)"); },
    // Time-series momentum + pullback to the 20 EMA
    d_mom(D, p) {
      const a = atrA(D, 14), e20 = emaA(D.map((x) => x.c), 20), out = [];
      for (let i = 210; i < D.length; i++) { const mom = D[i].c / D[i - p.L].c - 1, d = Math.sign(mom); if (Math.abs(mom) < p.min * a[i] / D[i].c * Math.sqrt(p.L)) continue;
        const touch = d > 0 ? D[i].l <= e20[i] && D[i].c > e20[i] : D[i].h >= e20[i] && D[i].c < e20[i];
        if (touch) out.push({ i, side: d, risk: p.k * a[i], Rm: p.Rm, H: p.H, kind: "Momentum pullback (daily)" }); }
      return out;
    },
  };

  // ---------- HOURLY methods (need the daily context) ----------
  const hourly = {
    // 1H mean reversion in quiet daily conditions, London/NY hours
    h_mr(H, ctx, p) { return mr(H, p, (i) => { const di = prevDay(ctx, H[i].t); return di == null ? null : adxVal(ctx.adx, di); }, "Intraday reversion (1H)", (i) => { const h = hourUTC(H[i].t); return h >= p.h0 && h <= p.h1; }); },
    // RSI(2) dip on 1H in the direction of the daily trend, London/NY hours only
    h_pb(H, ctx, p) {
      const r2 = rsiA(H, 2), a = atrA(H, 14), e = emaA(H.map((x) => x.c), 200), out = [];
      for (let i = 210; i < H.length; i++) { const hr = hourUTC(H[i].t); if (hr < p.h0 || hr > p.h1) continue;
        const di = prevDay(ctx, H[i].t); if (di == null) continue; const d = ctx.st.dir[di];
        if (p.adx && !(adxVal(ctx.adx, di) > p.adx)) continue;
        if (p.e200 && (d > 0 ? H[i].c < e[i] : H[i].c > e[i])) continue;
        if (d > 0 ? r2[i] < p.th && r2[i - 1] >= p.th : r2[i] > 100 - p.th && r2[i - 1] <= 100 - p.th) out.push({ i, side: d, risk: p.k * a[i], Rm: p.Rm, H: p.H, kind: "Trend dip (1H)" }); }
      return out;
    },
    // London breakout of the Asian range, with the daily trend
    h_lbo(H, ctx, p) {
      const out = []; let day = null, hi = -Infinity, lo = Infinity, done = false;
      for (let i = 1; i < H.length; i++) { const k = dayKey(H[i].t), hr = hourUTC(H[i].t);
        if (k !== day) { day = k; hi = -Infinity; lo = Infinity; done = false; }
        if (hr < 7) { hi = Math.max(hi, H[i].h); lo = Math.min(lo, H[i].l); continue; }
        if (done || hr > p.lastH || !isFinite(hi)) continue;
        const di = prevDay(ctx, H[i].t); if (di == null) continue; const d = ctx.st.dir[di], A = ctx.a[di]; if (!A) continue;
        const width = (hi - lo) / A; if (width > p.wMax || width < 0.15) continue;
        const up = H[i].c > hi, dn = H[i].c < lo; if (!up && !dn) continue;
        const side = up ? 1 : -1; done = true;
        if (p.trend && side !== d) continue;
        const stop = p.stopMid ? (hi + lo) / 2 : side > 0 ? lo : hi;
        out.push({ i, side, stopPx: stop, Rm: p.Rm, H: Math.max(2, 20 - hr), kind: "London breakout (1H)" }); }
      return out;
    },
    // 1H trend continuation: EMA20>EMA50 aligned with the daily trend, entry on a touch of EMA20
    h_ema(H, ctx, p) {
      const c = H.map((x) => x.c), e20 = emaA(c, 20), e50 = emaA(c, 50), a = atrA(H, 14), out = [];
      for (let i = 210; i < H.length; i++) { const hr = hourUTC(H[i].t); if (hr < p.h0 || hr > p.h1) continue;
        const di = prevDay(ctx, H[i].t); if (di == null) continue; const d = ctx.st.dir[di];
        if (p.adx && !(adxVal(ctx.adx, di) > p.adx)) continue;
        if (d > 0 ? !(e20[i] > e50[i] && H[i].l <= e20[i] && H[i].c > e20[i]) : !(e20[i] < e50[i] && H[i].h >= e20[i] && H[i].c < e20[i])) continue;
        out.push({ i, side: d, risk: p.k * a[i], Rm: p.Rm, H: p.H, kind: "Trend pullback to EMA (1H)" }); }
      return out;
    },
  };

  // ---------- simulator: enter next bar open, stop first on ties, exit at time limit ----------
  function simulate(B, cands, sym, opt) {
    opt = opt || {}; const cst = cost(sym) * (opt.costMult || 1), trades = []; let busyTo = -1;
    for (const k of cands) {
      const i = k.i; if (i + 1 >= B.length || i <= busyTo) continue;
      const e = B[i + 1].o; if (!(e > 0)) continue;
      let stop = k.stopPx != null ? k.stopPx : e - k.side * k.risk;
      const risk = Math.abs(e - stop); if (!(risk > 0) || k.side * (e - stop) <= 0) continue;
      let tgt = k.tgtPx != null ? k.tgtPx : e + k.side * k.Rm * risk;
      if (k.tgtPx != null) { if (k.side * (tgt - e) <= 0.2 * risk) continue; if (k.Rmax && Math.abs(tgt - e) > k.Rmax * risk) tgt = e + k.side * k.Rmax * risk; }
      const costR = (cst * e) / risk; let R = null, exitI = null, res = null;
      for (let j = i + 1; j < B.length && j <= i + k.H; j++) {
        const x = B[j], lo = j === i + 1 ? Math.min(x.l, e) : x.l, hi = j === i + 1 ? Math.max(x.h, e) : x.h;
        const hitS = k.side > 0 ? lo <= stop : hi >= stop, hitT = k.side > 0 ? hi >= tgt : lo <= tgt;
        if (hitS) { R = -1; res = "stop"; exitI = j; break; }
        if (hitT) { R = Math.abs(tgt - e) / risk; res = "target"; exitI = j; break; }
        if (j === i + k.H) { R = (k.side * (x.c - e)) / risk; res = "time"; exitI = j; }
      }
      if (R == null) continue; // still open at the end of the data
      trades.push({ t: B[i].t, sym, side: k.side, kind: k.kind, R: R - costR, res, bars: exitI - i });
      busyTo = exitI;
    }
    return trades;
  }
  function stats(tr) {
    const n = tr.length; if (!n) return { n: 0 };
    const w = tr.filter((x) => x.R > 0), gw = w.reduce((s, x) => s + x.R, 0), gl = -tr.filter((x) => x.R <= 0).reduce((s, x) => s + x.R, 0), sum = tr.reduce((s, x) => s + x.R, 0);
    return { n, win: w.length / n, avgR: sum / n, pf: gl ? gw / gl : 99, sumR: sum };
  }
  return { FXRULE, COST, cost, dailyCtx, prevDay, daily, hourly, simulate, stats, dayKey, hourUTC };
})();
if (typeof module !== "undefined") module.exports = FX;
