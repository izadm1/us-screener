/* Forecast Terminal — multi-timeframe chart with forecast path, volatility cone, σ filter,
   σ corridor, cycle turns, levels, signals, watchlist, trade plan, derivatives/options and alerts.
   Uses core.js (model forecast + trade plan) and the data the screener publishes. */
const T = {
  r: null, tf: "1D", bars: [], charts: [], s: {}, futT: [], lastFull: 0,
  tog: { trail: 1, filter: 1, fc: 1, fvol: 1, corr: 0, turns: 1, lv: 1, sig: 1, ema: 0, wy: 1 },
  tab: "watch", hz: 21, prices: {}, ws: null, wsSubs: new Set(), opt: null, optExp: null,
};
const TF_SEC = { "15m": 900, "1H": 3600, "4H": 14400, "1D": 86400, "1W": 604800 };
const BIN_TF = { "15m": "15m", "1H": "1h", "4H": "4h", "1D": "1d", "1W": "1w" };
const BIN_MAP = { RNDR: "RENDER" };
const LS = { get: (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} } };
const DEFAULT_WL = ["BTC-USD", "ETH-USD", "SOL-USD", "EURUSD=X", "GBPUSD=X", "USDJPY=X", "GC=F", "SPY", "QQQ", "NVDA", "AAPL", "TSLA"];
T.wl = LS.get("term_wl", DEFAULT_WL);
T.alerts = LS.get("term_alerts", []);
Object.assign(T.tog, LS.get("term_tog", {}));
const fhKey = () => { try { return localStorage.getItem("fh_key") || ""; } catch (e) { return ""; } };
const binSym = (r) => (BIN_MAP[r.name] || r.name) + "USDT";
const all = () => { const o = []; Object.values(S.data.classes).forEach((l) => l.forEach((r) => o.push(r))); return o; };
const row = (sym) => all().find((r) => r.sym === sym);
const toast = (msg) => { const d = document.createElement("div"); d.className = "toast"; d.innerHTML = msg; $("toasts").appendChild(d); setTimeout(() => d.remove(), 8000); };

/* ================= maths ================= */
/* ================= maths: see tmath.js ================= */
const TURN_CACHE = {};
function turnStats(b, periods) {
  const n = b.length, key = `${T.r.sym}|${T.tf}|${n}|${periods.join(",")}`;
  if (TURN_CACHE[key]) return TURN_CACHE[key];
  const lc = b.map((x) => Math.log(x.c));
  const Pmin = Math.min(...periods), K = Math.max(3, Math.round(Pmin / 4)), tol = Math.max(2, Math.round(Pmin / 8)), H = Math.min(120, Math.round(1.5 * Math.max(...periods)));
  const hi = new Array(n).fill(false), lo = new Array(n).fill(false);
  for (let i = K; i < n - K; i++) { let H1 = true, L1 = true; for (let j = i - K; j <= i + K; j++) { if (b[j].h > b[i].h) H1 = false; if (b[j].l < b[i].l) L1 = false; } hi[i] = H1; lo[i] = L1; }
  const near = (arr, t0) => { for (let j = Math.max(0, t0 - tol); j <= Math.min(n - 1, t0 + tol); j++) if (arr[j]) return true; return false; };
  let bh = 0, bl = 0, bn = 0; for (let i = K; i < n - K; i++) { bn++; if (near(hi, i)) bh++; if (near(lo, i)) bl++; }
  const base = bn ? (bh + bl) / (2 * bn) : 0.5;
  const rank = [0, 1, 2, 3].map(() => ({ h: 0, n: 0 }));
  const start = Math.max(150, n - 300), lastOk = n - 1 - K - tol;
  for (let o = start; o < lastOk - 5; o += 4) {
    const c = multiCycle(lc.slice(0, o + 1)); if (!c) continue;
    const p = []; for (let k = 0; k <= H + 1; k++) p.push(c.at(k));
    let r = 0;
    for (let k = 1; k <= H && r < 4; k++) {
      const isH = p[k] > p[k - 1] && p[k] >= p[k + 1], isL = p[k] < p[k - 1] && p[k] <= p[k + 1];
      if (!isH && !isL) continue;
      const t0 = o + k; if (t0 + tol > lastOk) break;
      rank[r].n++; if (near(isH ? hi : lo, t0)) rank[r].h++; r++;
    }
  }
  const res = { base, tol, K, rank: rank.map((x) => ({ p: (x.h + 1) / (x.n + 2), n: x.n })), tests: rank[0].n };
  TURN_CACHE[key] = res; return res;
}
T.minProb = LS.get("term_minprob4", 0);
const cycAt = (c, k) => c.amp * Math.sin(c.phase + 2 * Math.PI * k / c.P); // k = bars from last (negative = past)

/* ================= data ================= */
const fetchJ = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(r.status); return r.json(); };
function fromCols(h) { return h.t.map((t, i) => ({ t, o: h.o[i], h: h.h[i], l: h.l[i], c: h.c[i], v: h.v[i] || 0 })).filter((x) => x.c != null); }
function resample(b, keyFn) { const out = []; b.forEach((x) => { const k = keyFn(x.t), L = out[out.length - 1]; if (L && L.t === k) { L.h = Math.max(L.h, x.h); L.l = Math.min(L.l, x.l); L.c = x.c; L.v += x.v; } else out.push({ t: k, o: x.o, h: x.h, l: x.l, c: x.c, v: x.v }); }); return out; }
const weekKey = (t) => { const d = new Date(t * 1000), dow = (d.getUTCDay() + 6) % 7; return Math.floor(t / 86400) * 86400 - dow * 86400; };
async function binKlines(r, tf, limit = 1000) {
  for (const host of ["https://data-api.binance.vision", "https://api.binance.com"]) {
    try { const j = await fetchJ(`${host}/api/v3/klines?symbol=${binSym(r)}&interval=${BIN_TF[tf]}&limit=${limit}`); return j.map((k) => ({ t: Math.floor(k[0] / 1000), o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })); } catch (e) {}
  }
  throw new Error("Binance unavailable");
}
async function getBars(r, tf) {
  if (r._cls === "crypto") { try { return await binKlines(r, tf, tf === "1W" ? 500 : 1000); } catch (e) { if (!["1D", "1W"].includes(tf)) throw e; } }
  if (tf === "1D" || tf === "1W") { const d = fromCols(await fetchJ(`data/history/${safe(r.sym)}.json?g=${encodeURIComponent(S.data.generated)}`)); return tf === "1D" ? d : resample(d, weekKey); }
  if (tf === "15m") throw new Error("15-minute bars are available for crypto only");
  const h = fromCols(await fetchJ(`data/intraday/${safe(r.sym)}.json?g=${encodeURIComponent(S.data.generated)}`));
  return tf === "1H" ? h : resample(h, (t) => Math.floor(t / 14400) * 14400);
}
function futureTimes(lastT, n, tf, r) {
  const out = []; let t = lastT; const step = TF_SEC[tf];
  const skipWk = tf === "1D" && r._cls !== "crypto";
  while (out.length < n) { t += step; if (skipWk) { const d = new Date(t * 1000).getUTCDay(); if (d === 0 || d === 6) continue; } out.push(t); }
  return out;
}

/* ================= chart ================= */
const fmtT = (t) => { const d = new Date(t * 1000); return ["1D", "1W"].includes(T.tf) ? d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }) : d.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }); };
function chartOpts(el) {
  return { width: el.clientWidth, height: el.clientHeight, layout: { background: { color: "#0b0e13" }, textColor: "#8a93a3", fontFamily: "IBM Plex Mono", fontSize: 11 },
    grid: { vertLines: { color: "#141a23" }, horzLines: { color: "#141a23" } }, rightPriceScale: { borderColor: "#232b38", minimumWidth: 86 },
    timeScale: { borderColor: "#232b38", rightOffset: 6, timeVisible: !["1D", "1W"].includes(T.tf) }, crosshair: { mode: 0 },
    localization: { timeFormatter: fmtT } };
}
function horizonBars() { const tfDays = { "15m": 1 / 26, "1H": 1 / 6.5, "4H": 0.6, "1D": 1, "1W": 5 }; return tfDays[T.tf]; }

/* Settings per timeframe, chosen by the walk-forward accuracy test (scripts/accuracy.mjs, data/accuracy.json):
   only settings profitable/positive in BOTH the older and newer halves of the test data are used. */
const TF_CFG = {
  "1W": { nCyc: 1, win: 300, stN: 20, stM: 3, filt: "none" },
  "1D": { nCyc: 1, win: 300, stN: 20, stM: 3, filt: "none" },
  "4H": { nCyc: 2, win: 300, stN: 10, stM: 5, filt: "ema200" },
  "1H": { nCyc: 2, win: 300, stN: 20, stM: 5, filt: "daily" },
  "15m": { nCyc: 2, win: 300, stN: 20, stM: 5, filt: "daily" },
};
// intraday cone calibration: the plain normal cone was too wide (50% band held ~56%, 80% held ~82.5%)
const CONE_CAL = [1, 1, 1, 0.94, 0.9, 0.87, 0.87, 1, 0.87, 0.87, 0.9, 0.94, 1, 1, 1];
function dailyTrailDir(b) { // previous completed day's ATR-trail direction for each intraday bar (no look-ahead)
  const days = []; b.forEach((x) => { const k = Math.floor(x.t / 86400), L = days[days.length - 1]; if (L && L.k === k) { L.h = Math.max(L.h, x.h); L.l = Math.min(L.l, x.l); L.c = x.c; } else days.push({ k, o: x.o, h: x.h, l: x.l, c: x.c }); });
  const s = stA(days, 10, 3), idx = {}; days.forEach((d, i) => (idx[d.k] = i));
  return b.map((x) => { const i = idx[Math.floor(x.t / 86400)]; return i > 0 ? s.dir[i - 1] : 0; });
}
function accFor(tf) { // tested results for this timeframe's settings
  const A = T.acc && T.acc.tf && T.acc.tf[tf]; if (!A) return null; const c = TF_CFG[tf];
  const tr = (A.trail || []).find((x) => x.cfg.n === c.stN && x.cfg.m === c.stM && x.cfg.filt === c.filt);
  const tu = (A.turns || []).find((x) => x.cfg.nCyc === c.nCyc && x.cfg.win === c.win);
  return { tr, tu, cone: A.cone, symbols: A.symbols, date: T.acc.generated };
}
const WY_NAME = { SC: "Selling Climax", AR: "Automatic Rally", ST: "Secondary Test", Spring: "Spring", SOS: "Sign of Strength", LPS: "Last Point of Support", BC: "Buying Climax", UT: "Upthrust", UTAD: "Upthrust After Distribution", SOW: "Sign of Weakness", LPSY: "Last Point of Supply" };
function wyValidated(tf) { // Wyckoff events that were profitable in BOTH halves of the accuracy test for this timeframe
  const E = T.acc && T.acc.tf && T.acc.tf[tf] && T.acc.tf[tf].wyck && T.acc.tf[tf].wyck.events; const out = {};
  if (!E) return out;
  Object.entries(E).forEach(([k, v]) => { const [type, H] = k.split("|"); if (v.train.pf > 1.1 && v.valid.pf > 1.1 && v.valid.n >= 30 && v.train.n >= 30) { if (!out[type] || v.valid.pf > out[type].pf) out[type] = { H: +H, pf: v.valid.pf, win: v.valid.win, n: v.valid.n }; } });
  return out;
}
function draw() {
  const r = T.r, b = T.bars;
  const CFG = TF_CFG[T.tf] || TF_CFG["1D"]; Object.assign(TM, CFG);
  T.charts.forEach((c) => c.remove()); T.charts = []; T.s = {};
  if (!b.length) return;
  const n = b.length, last = b[n - 1], price = last.c;
  const atr = atrA(b), st = stA(b, CFG.stN, CFG.stM), osc = oscA(b), rsi = rsiA(b);
  const e200s = emaA(b.map((x) => x.c), 200), dDir = CFG.filt === "daily" ? dailyTrailDir(b) : null;
  const sigOk = (i, d) => CFG.filt === "none" || (CFG.filt === "ema200" && e200s[i] != null && (d === 1 ? b[i].c > e200s[i] : b[i].c < e200s[i])) || (CFG.filt === "daily" && dDir[i] === d);
  const cyc = multiCycle(b.map((x) => Math.log(x.c)));
  const F = Math.min(180, Math.max(60, cyc ? Math.round(1.5 * Math.max(...cyc.periods)) : 60));
  const fut = futureTimes(last.t, F, T.tf, r); T.futT = fut;
  const dayPerBar = horizonBars();
  const daily = ["1D", "1W"].includes(T.tf) && r.fc;
  const sigTf = volTf(b);
  let passTurns = [], allTurns = [], tStats = null;
  if (cyc) {
    for (let k = 1; k < F - 1; k++) { const a = cyc.at(k - 1), c = cyc.at(k), d = cyc.at(k + 1); if (c > a && c >= d) allTurns.push({ k, type: "high" }); if (c < a && c <= d) allTurns.push({ k, type: "low" }); }
    tStats = turnStats(b, cyc.periods);
    allTurns.forEach((m, i) => { const rk = tStats.rank[Math.min(i, 3)]; m.prob = rk.p; m.n = rk.n; m.edge = rk.p - tStats.base; m.rank = i + 1; });
    passTurns = T.minProb === 0 ? allTurns.slice() : allTurns.filter((m) => m.n >= 6 && m.prob >= T.minProb && m.edge >= 0.05);
  }
  const useCyc = passTurns.length > 0; // low-probability cycles are excluded from the forecast entirely
  const decay = (k) => (cyc ? Math.exp(-k / (6 * Math.max(...cyc.periods))) : 0); // slow fade: cycles lose precision far out
  const path = (k) => { // centre of the forecast in log terms, k bars ahead
    let m = 0;
    if (daily) { const h = k * dayPerBar * (r.fc.calendar && T.tf === "1W" ? 7 / 5 : 1); const md = model(r.fc, h); m = md.mz * md.s; }
    if (useCyc) m += decay(k) * (cyc.at(k) - cyc.at(0));
    return m;
  };
  const band = (k, i) => { // quantile price k bars ahead, i = index in GRID_P
    if (daily) { const h = k * dayPerBar * (r.fc.calendar && T.tf === "1W" ? 7 / 5 : 1); const md = model(r.fc, h); return price * Math.exp(path(k) + md.q[i] * md.s); }
    return price * Math.exp(path(k) + NORM_Q[i] * CONE_CAL[i] * sigTf * Math.sqrt(k));
  };
  // ---------------- main chart
  const el = $("cMain"); el.innerHTML = "";
  const ch = LightweightCharts.createChart(el, chartOpts(el));
  T.charts.push(ch);
  const cs = ch.addCandlestickSeries({ upColor: "#22c38e", downColor: "#f0565b", borderVisible: false, wickUpColor: "#22c38e", wickDownColor: "#f0565b", priceFormat: { type: "price", precision: price < 2 ? 5 : price < 20 ? 4 : 2, minMove: price < 2 ? 0.00001 : price < 20 ? 0.0001 : 0.01 } });
  cs.setData(b.map((x) => ({ time: x.t, open: x.o, high: x.h, low: x.l, close: x.c })));
  T.s.cs = cs;
  if (b.some((x) => x.v)) {
    const vs = ch.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    ch.priceScale("vol").applyOptions({ scaleMargins: { top: 0.86, bottom: 0 } });
    vs.setData(b.map((x) => ({ time: x.t, value: x.v, color: x.c >= x.o ? "rgba(34,195,142,.28)" : "rgba(240,86,91,.28)" }))); T.s.vs = vs;
  }
  ch.priceScale("right").applyOptions({ scaleMargins: { top: 0.06, bottom: 0.16 } });
  const noScale = { autoscaleInfoProvider: () => null };
  const line = (pts, color, w = 1, style = 0, extra = {}) => { const s = ch.addLineSeries({ color, lineWidth: w, lineStyle: style, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, ...extra }); s.setData(pts); return s; };
  const pad = ch.addLineSeries({ visible: false }); pad.setData(fut.map((t) => ({ time: t })));
  const leg = [];
  if (T.tog.ema) { const c = b.map((x) => x.c); [[20, "#f2b33d"], [50, "#5b8cff"], [200, "#9b7bff"]].forEach(([p, col]) => { const e = emaA(c, p); line(b.map((x, i) => (e[i] == null ? { time: x.t } : { time: x.t, value: e[i] })), col); leg.push([col, `EMA ${p}`]); }); }
  if (T.tog.trail) {
    const s = line(b.map((x, i) => (st.stop[i] == null ? { time: x.t } : { time: x.t, value: st.stop[i], color: st.dir[i] === 1 ? "#22c38e" : "#f0565b" })), "#22c38e", 2, 0);
    leg.push(["#22c38e", `Trail (ATR ${CFG.stN}×${CFG.stM})`]);
  }
  if (T.tog.corr) {
    const rc = regChan(b), m = rc.m, start = n - m;
    [[0, "#8a93a3", 1, 2], [1, "rgba(91,140,255,.75)", 1, 2], [-1, "rgba(91,140,255,.75)", 1, 2], [2, "rgba(155,123,255,.6)", 1, 1], [-2, "rgba(155,123,255,.6)", 1, 1]].forEach(([k, col, w, sty]) => {
      const pts = []; for (let i = 0; i < m + 30 && i < m + fut.length; i++) { const t = i < m ? b[start + i].t : fut[i - m]; pts.push({ time: t, value: Math.exp(rc.ic + rc.sl * i + k * rc.sd) }); }
      line(pts, col, w, sty, Math.abs(k) === 2 ? noScale : {});
    });
    leg.push(["#5b8cff", "σ corridor (regression ±1σ, ±2σ, projected)"]);
  }
  const ft = [last.t].concat(fut);
  // display wave: model drift + the combined cycle, scaled so its swings reach the edge of the likely range
  const hd = (k) => k * dayPerBar * (r.fc && r.fc.calendar && T.tf === "1W" ? 7 / 5 : 1);
  const drift = (k) => { if (!daily || !k) return 0; const md = model(r.fc, hd(k)); return md.mz * md.s; };
  const halfW = (k) => { if (!k) return 0; if (daily) { const md = model(r.fc, hd(k)); return (md.q[9] - md.q[5]) / 2 * md.s; } return 0.674 * sigTf * Math.sqrt(k); };
  let cM = 1e-12; if (cyc) for (let j = 1; j <= F; j++) cM = Math.max(cM, Math.abs(cyc.at(j) - cyc.at(0)));
  const coneAt = (k, i) => { if (!k) return price; if (daily) { const md = model(r.fc, hd(k)); return price * Math.exp(drift(k) + md.q[i] * md.s); } return price * Math.exp(NORM_Q[i] * CONE_CAL[i] * sigTf * Math.sqrt(k)); };
  const waveAt = (k) => (!k ? price : price * Math.exp(drift(k) + (cyc ? 1.3 * halfW(k) * (cyc.at(k) - cyc.at(0)) / cM : 0)));
  if (T.tog.fvol) {
    // shaded cone between the 80% edges
    const up = ch.addAreaSeries({ lineColor: "rgba(0,0,0,0)", topColor: "rgba(91,140,255,.13)", bottomColor: "rgba(91,140,255,.13)", priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, ...noScale });
    up.setData(ft.map((t, k) => ({ time: t, value: coneAt(k, 11) })));
    const dn = ch.addAreaSeries({ lineColor: "rgba(0,0,0,0)", topColor: "#0b0e13", bottomColor: "#0b0e13", priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, ...noScale });
    dn.setData(ft.map((t, k) => ({ time: t, value: coneAt(k, 3) })));
    [[3, 11, "#5fb8ff", 2, 1, noScale], [5, 9, "rgba(91,140,255,.35)", 1, 2, {}]].forEach(([lo, hi, col, w, sty, ex]) => {
      line(ft.map((t, k) => ({ time: t, value: coneAt(k, hi) })), col, w, sty, ex);
      line(ft.map((t, k) => ({ time: t, value: coneAt(k, lo) })), col, w, sty, ex);
    });
    leg.push(["#5fb8ff", daily ? "Forecast vol — shaded 80% range (dotted), 50% (dashed)" : "Forecast vol — shaded ±σ cone from recent volatility"]);
  }
  let fcS = null, futMarks = []; T.allTurns = []; T.turnStats = null;
  if (T.tog.fc) {
    fcS = line(ft.map((t, k) => ({ time: t, value: waveAt(k) })), "#f2b33d", 2, 2);
    leg.push(["#f2b33d", useCyc ? (daily ? "Forecast — model + high-probability cycle" : "Forecast — high-probability cycle") : daily ? "Forecast — model centre (no cycle passed the probability test)" : "Forecast — centre (no cycle passed the probability test)"]);
    T.allTurns = allTurns; T.turnStats = tStats;
    if (useCyc && T.tog.turns) {
      futMarks = passTurns;
      fcS.setMarkers(futMarks.map((m) => ({ time: fut[m.k - 1], position: m.type === "high" ? "aboveBar" : "belowBar", color: m.type === "high" ? "#f0565b" : "#22c38e", shape: "circle", size: 0.6 })));
    }
  }
  // candle markers: signals + past turns
  const mk = []; T.trailSigs = [];
  for (let i = 1; i < n; i++) if (st.dir[i] !== st.dir[i - 1] && st.stop[i - 1] != null && sigOk(i, st.dir[i])) T.trailSigs.push({ i, side: st.dir[i] });
  if (T.tog.sig) { // entry signals only: BUY when the ATR trail flips up, SELL when it flips down
    for (let i = 1; i < n; i++) {
      if (st.dir[i] !== st.dir[i - 1] && st.stop[i - 1] != null && sigOk(i, st.dir[i])) mk.push({ time: b[i].t, position: st.dir[i] === 1 ? "belowBar" : "aboveBar", color: st.dir[i] === 1 ? "#22c38e" : "#f0565b", shape: st.dir[i] === 1 ? "arrowUp" : "arrowDown", text: st.dir[i] === 1 ? "BUY" : "SELL" });
    }
  }
  // Wyckoff: range, phase, events; ★ = event type validated by the accuracy test on this timeframe
  const wy = wyckoff(b), VAL = wyValidated(T.tf);
  T.wy = wy; T.wyVal = VAL;
  if (T.tog.wy) {
    wy.events.forEach((e) => {
      if (e.type === "AR") { mk.push({ time: b[e.i].t, position: "aboveBar", color: "#8a93a3", shape: "circle", size: 0.4, text: "AR" }); return; }
      const v = VAL[e.type];
      if (v) mk.push({ time: b[e.i].t, position: e.side > 0 ? "belowBar" : "aboveBar", color: e.side > 0 ? "#2ee6a6" : "#ff6b70", shape: e.side > 0 ? "arrowUp" : "arrowDown", text: `★ ${e.side > 0 ? "BUY" : "SELL"} ${e.type}` });
      else mk.push({ time: b[e.i].t, position: e.side > 0 ? "belowBar" : "aboveBar", color: "rgba(138,147,163,.8)", shape: "circle", size: 0.4, text: e.type });
    });
    // most recent trading range box
    let ri = n - 1; while (ri > 0 && !wy.rangeAt[ri]) ri--;
    const R0 = wy.rangeAt[ri];
    if (R0 && n - 1 - ri < 120) {
      const col = R0.ctx === "acc" ? "rgba(46,230,166,.75)" : R0.ctx === "dist" ? "rgba(255,107,112,.75)" : "rgba(242,179,61,.7)";
      const tE = b[Math.min(n - 1, ri)].t, tS = b[R0.start].t;
      [R0.hi, R0.lo].forEach((p) => line([{ time: tS, value: p }, { time: tE, value: p }], col, 2, 0));
      T.wyRange = { ...R0, end: ri, live: ri === n - 1 };
    } else T.wyRange = null;
  }
  if (T.tog.turns && useCyc) {
    for (let k = -Math.min(cyc.m - 2, n - 2); k < 0; k++) { const a = cyc.at(k - 1), c = cyc.at(k), d = cyc.at(k + 1), i = n - 1 + k; if (i < 1) continue; if (c > a && c >= d) mk.push({ time: b[i].t, position: "aboveBar", color: "rgba(240,86,91,.6)", shape: "circle", size: 0.5 }); if (c < a && c <= d) mk.push({ time: b[i].t, position: "belowBar", color: "rgba(34,195,142,.6)", shape: "circle", size: 0.5 }); }
  }
  mk.sort((a, c) => a.time - c.time); cs.setMarkers(mk);
  // levels
  const A = atr[n - 1] || price * 0.01, LV = levels(b, A);
  if (T.tog.lv) {
    LV.res.forEach((l, i) => cs.createPriceLine({ price: l.p, color: "rgba(240,86,91,.5)", lineWidth: 1, lineStyle: 1, axisLabelVisible: true, title: `R${i + 1}` }));
    LV.sup.forEach((l, i) => cs.createPriceLine({ price: l.p, color: "rgba(34,195,142,.5)", lineWidth: 1, lineStyle: 1, axisLabelVisible: true, title: `S${i + 1}` }));
  }
  if (r.fc && T.tog.fc) { const p = planNow(); if (p && p.dir) { cs.createPriceLine({ price: p.stop, color: "#f0565b", lineWidth: 1, lineStyle: 0, axisLabelVisible: true, title: "STOP" }); p.targets.forEach((t, i) => cs.createPriceLine({ price: t.price, color: "#22c38e", lineWidth: 1, lineStyle: 0, axisLabelVisible: true, title: `T${i + 1}` })); } }
  const AC = accFor(T.tf);
  if (T.tog.sig) leg.push(["#22c38e", `BUY/SELL${CFG.filt === "ema200" ? " (with 200-EMA trend)" : CFG.filt === "daily" ? " (with daily trend)" : ""}` + (AC && AC.tr ? ` — tested on ${AC.symbols} assets: profit factor ${AC.tr.valid.pf.toFixed(2)}, ${Math.round(AC.tr.valid.win * 100)}% wins, ${AC.tr.valid.n} trades` : " — not tested on this timeframe")]);
  if (T.tog.wy) { const vk = Object.keys(VAL); leg.push(["#2ee6a6", `Wyckoff — ★ tested signals on ${T.tf}: ${vk.length ? vk.map((k) => `${k} (PF ${VAL[k].pf.toFixed(2)})`).join(", ") : "none passed on this timeframe"} · grey = context only`]); }
  $("tLeg").innerHTML = leg.map(([c, t]) => `<span style="--c:${c}">${t}</span>`).join("");

  // ---------------- oscillator pane
  const eo = $("cOsc"); eo.innerHTML = "";
  $("oscLabel").hidden = eo.hidden = !T.tog.filter;
  if (T.tog.filter) {
    const oc = LightweightCharts.createChart(eo, chartOpts(eo)); T.charts.push(oc);
    const op = oc.addLineSeries({ visible: false }); op.setData(b.map((x) => ({ time: x.t })).concat(fut.map((t) => ({ time: t }))));
    const os = oc.addLineSeries({ color: "#f2b33d", lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
    os.setData(b.map((x, i) => (osc[i] == null ? { time: x.t } : { time: x.t, value: osc[i], color: osc[i] > 2 ? "#f0565b" : osc[i] < -2 ? "#22c38e" : "#f2b33d" })));
    [[2, "rgba(240,86,91,.6)"], [1, "rgba(240,86,91,.25)"], [0, "#3a4352"], [-1, "rgba(34,195,142,.25)"], [-2, "rgba(34,195,142,.6)"]].forEach(([v, c]) => os.createPriceLine({ price: v, color: c, lineWidth: 1, lineStyle: 2, axisLabelVisible: Math.abs(v) === 2, title: v ? `${v > 0 ? "+" : ""}${v}σ` : "" }));
    // projected oscillator cycle: sine of the price cycle's period fitted to the oscillator
    if (cyc && useCyc && T.tog.fc) {
      const m = Math.min(300, n - 20), y = osc.slice(-m).map((v) => v ?? 0), W = cyc.periods.map((p) => 2 * Math.PI / p), P = Math.max(...cyc.periods);
      const beta = solve(y.map((_, t) => [1, ...W.flatMap((w) => [Math.sin(w * t), Math.cos(w * t)])]), y);
      const at = (t) => W.reduce((s, w, i) => s + beta[1 + 2 * i] * Math.sin(w * t) + beta[2 + 2 * i] * Math.cos(w * t), 0);
      const pp = oc.addLineSeries({ color: "rgba(242,179,61,.75)", lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false });
      pp.setData([{ time: last.t, value: osc[n - 1] }].concat(fut.map((t, k) => ({ time: t, value: osc[n - 1] + (at(m - 1 + k + 1) - at(m - 1)) * Math.exp(-(k + 1) / (6 * P)) }))));
    }
    T.s.os = os;
  }
  // sync + range
  let sync = false;
  T.charts.forEach((c) => c.timeScale().subscribeVisibleLogicalRangeChange((rg) => { if (sync || !rg) return; sync = true; T.charts.forEach((o) => o !== c && o.timeScale().setVisibleLogicalRange(rg)); sync = false; }));
  const show = Math.min(n, 180);
  T.charts.forEach((c) => c.timeScale().setVisibleLogicalRange({ from: n - show, to: n - 1 + F }));
  // crosshair readout
  const ro = (i) => { const x = b[i], ch1 = i ? x.c / b[i - 1].c - 1 : 0; $("tOhlc").innerHTML = `<span>${fmtT(x.t)}</span><span>O <b>${fmt.px(x.o)}</b></span><span>H <b>${fmt.px(x.h)}</b></span><span>L <b>${fmt.px(x.l)}</b></span><span>C <b>${fmt.px(x.c)}</b></span><span class="${cls(ch1)}">${fmt.pct(ch1, 2)}</span>${osc[i] != null ? `<span>σ <b>${osc[i].toFixed(2)}</b></span>` : ""}${rsi[i] != null ? `<span>RSI <b>${rsi[i].toFixed(0)}</b></span>` : ""}`; };
  ro(n - 1);
  ch.subscribeCrosshairMove((p) => {
    if (!p || p.time == null) return ro(n - 1);
    const i = b.findIndex((x) => x.t === p.time); if (i >= 0) return ro(i);
    const k = fut.indexOf(p.time) + 1; if (k > 0) $("tOhlc").innerHTML = `<span>${fmtT(p.time)} · forecast</span><span>Centre <b>${fmt.px(price * Math.exp(path(k)))}</b></span><span>50% <b>${fmt.px(band(k, 5))} – ${fmt.px(band(k, 9))}</b></span><span>80% <b>${fmt.px(band(k, 3))} – ${fmt.px(band(k, 11))}</b></span>`;
  });
  // boxed date labels at each projected turning point (HTML overlay that follows zoom/scroll)
  if (fcS && futMarks.length) {
    el.style.position = "relative";
    const ov = document.createElement("div"); ov.className = "turnlab"; el.appendChild(ov);
    const labs = futMarks.map((m) => { const d = document.createElement("span"); d.className = m.type === "high" ? "th" : "tl"; d.textContent = fmtT(fut[m.k - 1]); d.title = `${m.type === "high" ? "Projected high" : "Projected low"} · tested probability ${Math.round(m.prob * 100)}% (chance ${Math.round(tStats.base * 100)}%)`; ov.appendChild(d); return { m, d, t: fut[m.k - 1], p: waveAt(m.k) }; });
    const place = () => labs.forEach(({ m, d, t, p }) => { const x = ch.timeScale().timeToCoordinate(t), y = fcS.priceToCoordinate(p); if (x == null || y == null || x < 0 || x > el.clientWidth - 90) { d.style.display = "none"; return; } d.style.display = ""; d.style.left = x + "px"; d.style.top = (m.type === "high" ? y - 24 : y + 8) + "px"; });
    ch.timeScale().subscribeVisibleLogicalRangeChange(() => requestAnimationFrame(place));
    ch.subscribeCrosshairMove(() => {}); setTimeout(place, 60); setTimeout(place, 300);
    T.placeLabels = place;
  }
  if (T.tog.fc && cyc && !useCyc) {
    el.style.position = "relative";
    const nb = document.createElement("div"); nb.className = "fcnote";
    const best = allTurns.length ? Math.max(...allTurns.map((m) => m.prob)) : 0;
    nb.innerHTML = `No turning date reaches ${Math.round((T.minProb || 0) * 100)}% probability on ${T.tf} (best ${Math.round(best * 100)}%, chance ${Math.round((tStats ? tStats.base : 0) * 100)}%).<br>Showing the tested forecast only: centre line + calibrated ranges.`;
    el.appendChild(nb);
  }
  T.cyc = cyc; T.futMarks = futMarks; T.LV = LV; T.path = (k) => Math.log(waveAt(k) / price); T.band = (k, i) => coneAt(k, i); T.price = price;
  const ph = wy.phase[n - 1];
  $("tNote").innerHTML = (T.tog.wy ? `Wyckoff phase: <b>${ph === "none" ? "trending / no range" : ph}</b>${wy.hasVol ? "" : " (price-only, no volume)"} · ` : "") + (cyc ? `Showing ${futMarks.length} of ${(T.allTurns || []).length} projected turns${T.minProb ? ` (≥ ${Math.round(T.minProb * 100)}% probability)` : " (all milestones · hover a date for its tested probability)"} · cycles ≈ ${cyc.periods.join(" / ")} bars · fit ${(cyc.strength * 100).toFixed(0)}%` : "No cycle detected") +
    (daily ? " · Forecast centre and ranges from the validated daily model" : ` · ${T.tf} forecast uses this timeframe's cycle and volatility (no directional model intraday)`) + ` · ${n} bars`;
  T.lastFull = Date.now();
  if (T.tab === "fc" || T.tab === "signal") side();
}
const m_tol = (ts) => `within ±${ts.tol} bar${ts.tol > 1 ? "s" : ""}`;
function bestSignal() { // freshest signal with the strongest tested record (ATR-trail BUY/SELL or ★ Wyckoff event)
  const b = T.bars, n = b.length, AC = accFor(T.tf), cands = [];
  const fresh = { "15m": 16, "1H": 12, "4H": 6, "1D": 5, "1W": 2 }[T.tf] || 5;
  (T.trailSigs || []).forEach((s) => { if (AC && AC.tr) cands.push({ ...s, src: "ATR trail flip" + (TF_CFG[T.tf].filt === "daily" ? " with daily trend" : TF_CFG[T.tf].filt === "ema200" ? " with 200-EMA trend" : ""), pf: AC.tr.valid.pf, win: AC.tr.valid.win, n: AC.tr.valid.n, hold: "until the trail flips" }); });
  if (T.wy) T.wy.events.forEach((e) => { const v = T.wyVal && T.wyVal[e.type]; if (v) cands.push({ i: e.i, side: e.side, src: `Wyckoff ${WY_NAME[e.type]} (${e.type})`, pf: v.pf, win: v.win, n: v.n, hold: `about ${v.H} bars` }); });
  const recent = cands.filter((c) => n - 1 - c.i <= fresh && c.pf > 1).sort((a, b) => b.pf - a.pf || b.i - a.i);
  const last = cands.sort((a, b) => b.i - a.i)[0];
  return { best: recent[0] || null, last, fresh };
}
function bestCard() {
  const r = T.r, B = bestSignal(), b = T.bars, x = B.best;
  const ago = (i) => { const k = b.length - 1 - i; return k === 0 ? "this bar" : `${k} bar${k > 1 ? "s" : ""} ago`; };
  if (x) {
    const p = b[x.i].c, atr = atrA(b)[b.length - 1], stop = x.side > 0 ? Math.min(...b.slice(Math.max(0, x.i - 5), x.i + 1).map((y) => y.l)) - 0.25 * atr : Math.max(...b.slice(Math.max(0, x.i - 5), x.i + 1).map((y) => y.h)) + 0.25 * atr;
    return `<div class="plan ${x.side > 0 ? "sb2" : "ss2"}"><div class="planhead"><div><div class="l">★ Best signal now · ${T.tf}</div><div class="big">${x.side > 0 ? "BUY" : "SELL"}</div></div><div class="conv"><div class="l">Tested profit factor</div><div class="cv">${x.pf.toFixed(2)}</div><div class="s" style="font:11px var(--mono);color:var(--mute)">${Math.round(x.win * 100)}% wins · ${x.n} trades</div></div></div>
      <div class="pgrid"><div><div class="l">Trigger</div><div class="v" style="font-size:13px">${x.src}</div><div class="s">${fmtT(b[x.i].t)} · ${ago(x.i)}</div></div><div><div class="l">Signal price</div><div class="v">${fmt.px(p)}</div><div class="s">now ${fmt.px(b[b.length - 1].c)} (${fmt.pct(b[b.length - 1].c / p - 1, 2)})</div></div>
      <div><div class="l">Invalidation</div><div class="v down">${fmt.px(stop)}</div><div class="s">beyond the signal swing</div></div><div><div class="l">Typical hold</div><div class="v" style="font-size:13px">${x.hold}</div></div></div>
      <p class="note">Ranked by out-of-sample profit factor from the accuracy test. Profit factor above 1 = made money; these signals still lose often, so always use the invalidation level.</p></div>`;
  }
  return `<div class="plan sn"><div class="l">★ Best signal now · ${T.tf}</div><div class="big">NO FRESH SIGNAL</div><p class="note" style="margin:6px 0 0">No tested signal in the last ${B.fresh} bars.${B.last ? ` Latest: <b class="${B.last.side > 0 ? "up" : "down"}">${B.last.side > 0 ? "BUY" : "SELL"}</b> — ${B.last.src}, ${fmtT(b[B.last.i].t)} (${ago(B.last.i)}).` : ""}</p></div>`;
}
function wyCard() {
  const wy = T.wy; if (!wy) return "";
  const n = T.bars.length, ph = wy.phase[n - 1], R0 = T.wyRange, VAL = T.wyVal || {};
  const evs = wy.events.slice(-8).reverse();
  const desc = { accumulation: "Trading range after a decline — smart money may be absorbing supply. Watch for SOS (breakout) or a successful test.", distribution: "Trading range after an advance — supply may be entering. Watch for SOW (breakdown) or an upthrust.", markup: "Price broke out of a range — uptrend phase. Pullbacks to the old range top (LPS) are the classic entries.", markdown: "Price broke down from a range — downtrend phase. Rallies to the old range bottom (LPSY) are the classic shorts.", range: "Sideways range without a clear prior trend.", none: "No trading range detected — market is trending." }[ph];
  return `<h4>Wyckoff analysis · ${T.tf}${wy.hasVol ? "" : " · price-only (no volume)"}</h4>
    <div class="metric"><div class="m"><div class="l">Phase</div><div class="v" style="font-size:15px;text-transform:capitalize">${ph === "none" ? "Trending" : ph}</div></div><div class="m"><div class="l">Bias</div><div class="v ${wy.bias[n - 1] > 0.1 ? "up" : wy.bias[n - 1] < -0.1 ? "down" : ""}">${wy.bias[n - 1] > 0 ? "+" : ""}${wy.bias[n - 1].toFixed(2)}</div></div>
    ${R0 ? `<div class="m"><div class="l">Range ${R0.live ? "(active)" : "(last)"}</div><div class="v" style="font-size:13px">${fmt.px(R0.lo)} – ${fmt.px(R0.hi)}</div><div class="s">${R0.ctx === "acc" ? "accumulation" : R0.ctx === "dist" ? "distribution" : "neutral"}</div></div>` : ""}</div>
    <p class="note">${desc}</p>
    ${evs.length ? evs.map((e) => { const v = VAL[e.type]; return `<div class="alrow"><span class="${e.side > 0 ? "up" : "down"}">${v ? "★ " : ""}${e.type}</span><span style="font-family:var(--sans);font-size:12px">${WY_NAME[e.type]}</span><span>${fmtT(T.bars[e.i].t)}</span>${v ? `<b class="up">PF ${v.pf.toFixed(2)}</b>` : `<span class="mute">context</span>`}</div>`; }).join("") : `<p class="note">No Wyckoff events in view.</p>`}
    <p class="note">★ = this event type made money in both halves of the accuracy test on ${T.tf} (shown: newer-half profit factor). Unstarred events did not, so they are shown for context only.</p>`;
}
function planNow() { if (!T.r || !T.r.fc) return null; const p = tradePlan(T.r, T.hz); S.fdate = isoD(addBars(T.r.fc.asof, T.hz, T.r.fc.calendar)); return p; }

/* ================= load symbol / timeframe ================= */
async function load(sym, tf) {
  const r = row(sym) || row("BTC-USD") || all()[0];
  T.r = r; if (tf) T.tf = tf;
  if (T.tf === "15m" && r._cls !== "crypto") T.tf = "1H";
  if (["1H", "4H"].includes(T.tf) && r._cls === "indices") T.tf = "1D";
  [...$("tTf").children].forEach((x) => { x.classList.toggle("on", x.dataset.tf === T.tf); x.disabled = (x.dataset.tf === "15m" && r._cls !== "crypto") || (["15m", "1H", "4H"].includes(x.dataset.tf) && r._cls === "indices"); x.title = x.disabled ? "Not available for this asset" : ""; });
  $("tSymName").textContent = `${disp(r)}`;
  document.title = `${disp(r)} · ${T.tf} — Forecast Terminal`;
  history.replaceState(null, "", `?s=${encodeURIComponent(r.sym)}&tf=${T.tf}`);
  $("tOhlc").textContent = "Loading…";
  try { T.bars = await getBars(r, T.tf); } catch (e) { T.bars = []; $("tOhlc").textContent = `No ${T.tf} data: ${e.message}`; T.charts.forEach((c) => c.remove()); T.charts = []; return; }
  const live = T.prices[r.sym]; if (live) applyTick(live.p, live.t, false);
  header(); draw(); side(); subs();
}
function header() {
  const r = T.r, b = T.bars, p = b.length ? b[b.length - 1].c : r.price;
  $("tPx").textContent = fmt.px(p);
  const ref = r._cls === "crypto" || T.tf !== "1D" ? (b.length > 1 ? b[b.length - 2].c : null) : null;
  const ch1 = T.prices[r.sym] && T.prices[r.sym].chg != null ? T.prices[r.sym].chg : ref ? p / ref - 1 : r.chg1d;
  $("tChg").innerHTML = `<span class="${cls(ch1)}">${fmt.pct(ch1, 2)}</span>`;
}

/* ================= live prices ================= */
function applyTick(p, t, redraw = true) {
  const r = T.r, b = T.bars; if (!b.length || !(p > 0)) return;
  const L = b[b.length - 1], step = TF_SEC[T.tf], ts = Math.floor((t || Date.now()) / 1000);
  let key = ts - (ts % step); if (T.tf === "1W") key = weekKey(ts); if (T.tf === "1D") key = Math.floor(ts / 86400) * 86400;
  if (r._cls !== "crypto" && T.tf === "1D") key = Math.max(key, L.t);
  if (key > L.t) { b.push({ t: key, o: L.c, h: Math.max(L.c, p), l: Math.min(L.c, p), c: p, v: 0 }); if (redraw) return draw(); }
  else { L.c = p; L.h = Math.max(L.h, p); L.l = Math.min(L.l, p); }
  if (!redraw || !T.s.cs) return;
  const X = b[b.length - 1]; T.s.cs.update({ time: X.t, open: X.o, high: X.h, low: X.l, close: X.c });
  r.price = p; if (r.fc) r.fc.p0 = p;
  header();
  if (Date.now() - T.lastFull > 20000) draw();
}
function onPrice(sym, p, t, chg) {
  T.prices[sym] = { p, t: t || Date.now(), chg };
  if (T.r && sym === T.r.sym) applyTick(p, t);
  checkAlerts(sym, p);
}
async function pollCrypto() {
  if (!S.data) return;
  try {
    let j = null;
    const syms = encodeURIComponent(JSON.stringify((S.data.classes.crypto || []).map(binSym)));
    for (const h of ["https://data-api.binance.vision", "https://api.binance.com"]) {
      try { j = await fetchJ(`${h}/api/v3/ticker/24hr?type=MINI&symbols=${syms}`); break; } catch (e) {}
      try { j = await fetchJ(`${h}/api/v3/ticker/24hr?type=MINI`); break; } catch (e) {}
    }
    if (!j) throw 0;
    const m = {}; j.forEach((x) => (m[x.symbol] = x));
    (S.data.classes.crypto || []).forEach((r) => { const x = m[binSym(r)]; if (x) onPrice(r.sym, +x.lastPrice, Date.now(), +x.lastPrice / +x.openPrice - 1); });
    T.cryptoOk = Date.now();
  } catch (e) { T.cryptoOk = 0; }
  liveStatus(); if (T.tab === "watch") side(true);
}
const fhSym = (r) => (r._cls === "forex" ? "OANDA:" + r.label.replace("/", "_") : r.sym.replace("-", "."));
function subs() {
  if (!T.ws || T.ws.readyState !== 1) return;
  const want = new Set();
  const add = (r) => { if (r && ["stocks", "etfs", "forex"].includes(r._cls) && want.size < 50) want.add(fhSym(r)); };
  add(T.r); T.wl.forEach((s) => add(row(s))); T.alerts.filter((a) => !a.done).forEach((a) => add(row(a.sym)));
  T.wsSubs.forEach((s) => { if (!want.has(s)) { T.ws.send(JSON.stringify({ type: "unsubscribe", symbol: s })); T.wsSubs.delete(s); } });
  want.forEach((s) => { if (!T.wsSubs.has(s)) { T.ws.send(JSON.stringify({ type: "subscribe", symbol: s })); T.wsSubs.add(s); } });
}
function connectWs() {
  const key = fhKey(); if (!key) { liveStatus(); return; }
  const ws = new WebSocket(`wss://ws.finnhub.io?token=${key}`); T.ws = ws; T.wsSubs = new Set();
  const map = {}; all().forEach((r) => { if (["stocks", "etfs", "forex"].includes(r._cls)) map[fhSym(r)] = r; });
  ws.onopen = () => { T.wsOk = true; subs(); liveStatus(); };
  ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } if (m.type === "trade" && m.data) { const last = {}; m.data.forEach((d) => (last[d.s] = d)); Object.values(last).forEach((d) => { const r = map[d.s]; if (r) { onPrice(r.sym, d.p, d.t); T.fhLast = Date.now(); } }); } };
  ws.onclose = () => { T.wsOk = false; liveStatus(); if (T.ws === ws) setTimeout(connectWs, 5000); };
}
function liveStatus() {
  const ago = (t) => (t ? Math.round((Date.now() - t) / 1000) + "s" : "—");
  $("tLive").innerHTML = `<i class="dot ${T.cryptoOk ? "on" : ""}"></i>Crypto ${T.cryptoOk ? ago(T.cryptoOk) : "off"} · <i class="dot ${T.wsOk ? "on" : ""}"></i>Stocks/FX ${T.wsOk ? (T.fhLast ? ago(T.fhLast) : "waiting") : fhKey() ? "connecting" : '<a href="./" title="Add your Finnhub key on the screener page">no key</a>'} · model ${new Date(S.data.generated).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

/* ================= side panel ================= */
function side(light) {
  const B = $("sBody"), r = T.r; if (!r) return;
  if (T.tab === "watch") {
    B.innerHTML = `<table class="wl"><tbody>${T.wl.map((s) => { const x = row(s); if (!x) return ""; const lp = T.prices[s], p = lp ? lp.p : x.price, c = lp && lp.chg != null ? lp.chg : x.chg1d; const pl = x.fc ? tradePlan(x, 21) : null; return `<tr data-s="${s}" class="${s === r.sym ? "cur" : ""}"><td><b>${disp(x)}</b><br><span class="mute" style="font-size:11px">${x._cls}</span></td><td>${fmt.px(p)}<br><span class="${cls(c)}" style="font-size:11px">${fmt.pct(c, 2)}</span></td><td>${pl ? sigChip(pl) : ""}</td><td><button class="x" data-rm="${s}" title="Remove">×</button></td></tr>`; }).join("")}</tbody></table><button class="addbtn" id="wlAdd">+ Add symbol</button><p class="note">Signals are 1-month model signals. Prices update live (crypto every 5 s; stocks/ETFs/forex in real time with a Finnhub key).</p>`;
    B.querySelectorAll("tr[data-s]").forEach((tr) => (tr.onclick = (e) => { if (e.target.dataset.rm) { T.wl = T.wl.filter((s) => s !== e.target.dataset.rm); LS.set("term_wl", T.wl); side(); subs(); return; } load(tr.dataset.s); }));
    $("wlAdd").onclick = () => openSearch("add");
    return;
  }
  if (light) return;
  if (T.tab === "signal") {
    if (!r.fc) { B.innerHTML = `<p class="note">No model forecast for this asset.</p>`; return; }
    const p = planNow();
    B.innerHTML = bestCard() + wyCard() + `<h4>Model trade plan</h4><div class="hzsel" id="hz">${[[5, "1W"], [21, "1M"], [63, "3M"], [126, "6M"]].map(([h, l]) => `<button data-h="${h}" class="${h === T.hz ? "on" : ""}">${l}</button>`).join("")}</div>${planCard(r, p)}
      <h4>Key levels (${T.tf})</h4>${(T.LV ? T.LV.res.slice().reverse().map((l, i) => `<div class="alrow"><span>Resistance · ${l.n} touch${l.n > 1 ? "es" : ""}</span><span class="down">${fmt.px(l.p)}</span></div>`).join("") + `<div class="alrow"><span><b>Price</b></span><b>${fmt.px(T.price)}</b></div>` + T.LV.sup.map((l) => `<div class="alrow"><span>Support · ${l.n} touch${l.n > 1 ? "es" : ""}</span><span class="up">${fmt.px(l.p)}</span></div>`).join("") : "")}`;
    B.querySelectorAll("#hz button").forEach((x) => (x.onclick = () => { T.hz = +x.dataset.h; side(); draw(); }));
    return;
  }
  if (T.tab === "fc") {
    let h = "";
    if (r.fc) {
      const hs = [[1, "1 day"], [5, "1 week"], [21, "1 month"], [63, "3 months"], [126, "6 months"], [252, "12 months"]].map(([k, l]) => [r.fc.calendar ? Math.round(k * 365 / 252) : k, l]);
      h += `<h4>Daily model forecast</h4><table class="wl"><tbody><tr><td class="mute">Horizon</td><td class="mute">Base</td><td class="mute">50% range</td><td class="mute">P↑</td></tr>${hs.map(([k, l]) => { const x = fcAt(r.fc, k); return `<tr><td>${l}<br><span class="mute" style="font-size:11px">${niceD(isoD(addBars(r.fc.asof, k, r.fc.calendar)))}</span></td><td><b>${fmt.px(x.med)}</b><br><span class="${cls(x.chg)}" style="font-size:11px">${fmt.pct(x.chg, 1)}</span></td><td style="font-size:11px">${fmt.px(x.lo50)}<br>${fmt.px(x.hi50)}</td><td class="${x.pup >= 0.55 ? "up" : x.pup <= 0.45 ? "down" : ""}">${Math.round(x.pup * 100)}%</td></tr>`; }).join("")}</tbody></table>`;
      const ms = modelStats(r.fc, 21);
      if (ms) h += `<p class="note">Model check (last 12 months, unseen data): IC ${ms.ic_oos?.toFixed(3)}, t ${ms.t_ic?.toFixed(1)}, ranges held ${Math.round(ms.cov80_oos * 100)}% inside the 80% band. Weight used ${Math.round(ms.k * 100)}%.</p>`;
    }
    if (T.cyc) {
      const ts = T.turnStats, allT = T.allTurns || [], shown = T.futMarks || [];
      h += `<h4>High-probability turning points (${T.tf})</h4><div class="hzsel" id="mp">${[0, 0.40, 0.55, 0.65].map((v) => `<button data-v="${v}" class="${Math.abs(v - T.minProb) < 0.001 ? "on" : ""}">${v ? "≥ " + Math.round(v * 100) + "%" : "All"}</button>`).join("")}</div>`;
      h += shown.length ? shown.map((m) => `<div class="alrow"><span class="${m.type === "low" ? "up" : "down"}">${m.type === "low" ? "▼ Low" : "▲ High"}</span><span>${fmtT(T.futT[m.k - 1])}</span><span>~${fmt.px(T.price * Math.exp(T.path(m.k)))}</span><b class="${m.prob >= 0.75 ? "up" : ""}">${Math.round(m.prob * 100)}%</b></div>`).join("")
        : `<p class="note"><b>No high-probability turns</b> on this timeframe right now — the projected dates for ${disp(T.r)} haven't been reliable enough in testing. Try another timeframe or a lower threshold.</p>`;
      const hidden = allT.filter((m) => !shown.includes(m));
      if (hidden.length) h += `<p class="note">Hidden (low probability): ${hidden.map((m) => `${m.type} ${fmtT(T.futT[m.k - 1])} (${Math.round(m.prob * 100)}%)`).join(", ")}.</p>`;
      if (ts) h += `<p class="note">Probability = how often the 1st, 2nd, 3rd… projected turn matched a real swing ${m_tol(ts)} in ${ts.tests} replayed forecasts on this asset's ${T.tf} history (chance level ${Math.round(ts.base * 100)}%). A turn is shown only if it reaches your threshold <i>and</i> beats chance by 5+ points. Cycles ≈ ${T.cyc.periods.join(", ")} bars · fit ${(T.cyc.strength * 100).toFixed(0)}%.</p>`;
      const AC = accFor(T.tf);
      if (AC && AC.tu) h += `<h4>Accuracy test · ${T.tf} · ${AC.symbols} assets</h4><div class="metric"><div class="m"><div class="l">Dates that matched a real swing</div><div class="v">${Math.round(AC.tu.valid.hit * 100)}%</div><div class="s">vs ${Math.round(AC.tu.valid.base * 100)}% by chance</div></div><div class="m"><div class="l">Wave direction right</div><div class="v">${Math.round(AC.tu.valid.dir * 100)}%</div><div class="s">50% = coin flip</div></div>${AC.tr ? `<div class="m"><div class="l">BUY/SELL profit factor</div><div class="v ${AC.tr.valid.pf > 1 ? "up" : "down"}">${AC.tr.valid.pf.toFixed(2)}</div><div class="s">${Math.round(AC.tr.valid.win * 100)}% wins · ${AC.tr.valid.n} trades</div></div>` : ""}${AC.cone && AC.cone[20] ? `<div class="m"><div class="l">Cone check (raw)</div><div class="v" style="font-size:14px">${Math.round(AC.cone[20].c50 * 100)}% / ${Math.round(AC.cone[20].c80 * 100)}%</div><div class="s">inside 50% / 80% bands → now calibrated</div></div>` : ""}</div><p class="note">Out-of-sample: settings chosen on the older half of ${AC.date.slice(0, 10)}'s test data, results shown for the newer half. Re-run weekly.</p>`;
    }
    B.innerHTML = h;
    B.querySelectorAll("#mp button").forEach((x) => (x.onclick = () => { T.minProb = +x.dataset.v; LS.set("term_minprob4", T.minProb); draw(); side(); }));
    return;
  }
  if (T.tab === "deriv") return deriv(B);
  if (T.tab === "alerts") {
    const p = T.prices[r.sym] ? T.prices[r.sym].p : T.price;
    B.innerHTML = `<h4>New alert · ${disp(r)}</h4><div class="alform"><select id="aDir"><option value="above">Price above</option><option value="below">Price below</option></select><input id="aPx" type="number" step="any" value="${(p || 0).toPrecision(6)}" style="width:120px"><button id="aAdd">Add</button></div>
      <p class="note">Quick: ${[...(T.LV ? T.LV.res.slice(0, 1).map((l) => ["above", l.p, "R1"]) : []), ...(T.LV ? T.LV.sup.slice(0, 1).map((l) => ["below", l.p, "S1"]) : [])].map(([d, v, n]) => `<a href="#" data-q="${d}|${v}">${d} ${n} ${fmt.px(v)}</a>`).join(" · ")}</p>
      <h4>Active alerts</h4>${T.alerts.length ? T.alerts.map((a, i) => { const x = row(a.sym); return `<div class="alrow ${a.done ? "done" : ""}"><span>${x ? disp(x) : a.sym} ${a.dir} ${fmt.px(a.px)}</span><span>${a.done ? "triggered" : ""}</span><button class="x" data-del="${i}">×</button></div>`; }).join("") : `<p class="note">No alerts yet.</p>`}
      <p class="note">Alerts fire while this page is open (any tab). <a href="#" id="aPerm">Enable desktop notifications</a></p>`;
    const add = (dir, px) => { T.alerts.push({ sym: r.sym, dir, px: +px, done: false }); LS.set("term_alerts", T.alerts); side(); subs(); };
    $("aAdd").onclick = () => add($("aDir").value, $("aPx").value);
    B.querySelectorAll("[data-q]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); const [d, v] = a.dataset.q.split("|"); add(d, v); }));
    B.querySelectorAll("[data-del]").forEach((x) => (x.onclick = () => { T.alerts.splice(+x.dataset.del, 1); LS.set("term_alerts", T.alerts); side(); }));
    $("aPerm").onclick = (e) => { e.preventDefault(); try { Notification.requestPermission(); } catch (er) {} };
  }
}
function checkAlerts(sym, p) {
  let hit = false;
  T.alerts.forEach((a) => {
    if (a.done || a.sym !== sym) return;
    if ((a.dir === "above" && p >= a.px) || (a.dir === "below" && p <= a.px)) {
      a.done = true; hit = true; const x = row(sym), msg = `🔔 ${x ? disp(x) : sym} is ${a.dir} ${fmt.px(a.px)} — now ${fmt.px(p)}`;
      toast(msg);
      try { if (Notification.permission === "granted") new Notification("Price alert", { body: msg.replace("🔔 ", "") }); } catch (e) {}
      try { const ac = new (window.AudioContext || window.webkitAudioContext)(), o = ac.createOscillator(); o.connect(ac.destination); o.frequency.value = 880; o.start(); o.stop(ac.currentTime + 0.25); } catch (e) {}
    }
  });
  if (hit) { LS.set("term_alerts", T.alerts); if (T.tab === "alerts") side(); }
}

/* ================= derivatives (crypto): Binance futures + Deribit options ================= */
async function deriv(B) {
  const r = T.r;
  if (r._cls !== "crypto") { B.innerHTML = `<p class="note">Derivatives data (funding, open interest, long/short, options) is available for crypto. For ${disp(r)}, see the Signal and Forecast tabs.</p>`; return; }
  B.innerHTML = `<p class="note">Loading derivatives…</p>`;
  const fsym = ({ PEPE: "1000PEPEUSDT", SHIB: "1000SHIBUSDT", RNDR: "RENDERUSDT" })[r.name] || `${r.name}USDT`;
  const F = "https://fapi.binance.com";
  const safeJ = async (u) => { try { return await fetchJ(u); } catch (e) { return null; } };
  const [pi, oi, ls, top, oih] = await Promise.all([
    safeJ(`${F}/fapi/v1/premiumIndex?symbol=${fsym}`), safeJ(`${F}/fapi/v1/openInterest?symbol=${fsym}`),
    safeJ(`${F}/futures/data/globalLongShortAccountRatio?symbol=${fsym}&period=1h&limit=1`), safeJ(`${F}/futures/data/topLongShortPositionRatio?symbol=${fsym}&period=1h&limit=1`),
    safeJ(`${F}/futures/data/openInterestHist?symbol=${fsym}&period=1d&limit=8`),
  ]);
  if (T.tab !== "deriv" || T.r !== r) return;
  let h = "";
  if (pi) {
    const fr = +pi.lastFundingRate, ann = fr * 3 * 365, oiv = oi ? +oi.openInterest * +pi.markPrice : null, oiChg = oih && oih.length > 1 ? +oih[oih.length - 1].sumOpenInterestValue / +oih[0].sumOpenInterestValue - 1 : null;
    h += `<h4>Perpetual futures · Binance</h4><div class="metric">
      <div class="m"><div class="l">Funding (8h)</div><div class="v ${fr > 0.0003 ? "warn" : fr < 0 ? "up" : ""}">${(fr * 100).toFixed(4)}%</div><div class="s">${(ann * 100).toFixed(1)}% annualised</div></div>
      <div class="m"><div class="l">Open interest</div><div class="v">${oiv ? "$" + (oiv / 1e9 >= 1 ? (oiv / 1e9).toFixed(2) + "B" : (oiv / 1e6).toFixed(0) + "M") : "–"}</div><div class="s">${oiChg != null ? fmt.pct(oiChg, 1) + " in 7 days" : ""}</div></div>
      <div class="m"><div class="l">Long/short (accounts)</div><div class="v">${ls && ls[0] ? (+ls[0].longShortRatio).toFixed(2) : "–"}</div><div class="s">${ls && ls[0] ? Math.round(+ls[0].longAccount * 100) + "% long" : ""}</div></div>
      <div class="m"><div class="l">Top traders (positions)</div><div class="v">${top && top[0] ? (+top[0].longShortRatio).toFixed(2) : "–"}</div><div class="s">${top && top[0] ? Math.round(+top[0].longAccount * 100) + "% long" : ""}</div></div>
      <div class="m"><div class="l">Mark / index</div><div class="v" style="font-size:14px">${fmt.px(+pi.markPrice)}</div><div class="s">basis ${fmt.pct(+pi.markPrice / +pi.indexPrice - 1, 3)}</div></div>
      </div><p class="note">High positive funding + rising OI = crowded longs (squeeze risk down); negative funding = crowded shorts.</p>`;
  } else h += `<p class="note">Binance futures data unavailable from your network.</p>`;
  if (["BTC", "ETH"].includes(r.name)) h += `<div id="optBox"><p class="note">Loading options…</p></div>`;
  B.innerHTML = h;
  if (["BTC", "ETH"].includes(r.name)) options(r.name);
}
async function options(cur) {
  const D = "https://www.deribit.com/api/v2/public";
  const box = () => document.getElementById("optBox");
  try {
    if (!T.opt || T.opt.cur !== cur || Date.now() - T.opt.ts > 120000) {
      const now = Date.now();
      const [bk, dv] = await Promise.all([fetchJ(`${D}/get_book_summary_by_currency?currency=${cur}&kind=option`), fetchJ(`${D}/get_volatility_index_data?currency=${cur}&start_timestamp=${now - 366 * DAY}&end_timestamp=${now}&resolution=1D`).catch(() => null)]);
      const rows = bk.result.map((x) => { const [, exp, k, t] = x.instrument_name.split("-"); return { exp, k: +k, t, oi: x.open_interest || 0, vol: x.volume || 0, iv: x.mark_iv, u: x.underlying_price }; });
      const exps = [...new Set(rows.map((x) => x.exp))].sort((a, b) => Date.parse(a.replace(/(\d+)([A-Z]+)(\d+)/, "$1 $2 20$3")) - Date.parse(b.replace(/(\d+)([A-Z]+)(\d+)/, "$1 $2 20$3")));
      T.opt = { cur, ts: Date.now(), rows, exps, dv: dv && dv.result ? dv.result.data : null };
      T.optExp = exps.find((e) => rows.filter((x) => x.exp === e).reduce((s, x) => s + x.oi, 0) > 0) || exps[0];
    }
    if (!box() || T.tab !== "deriv") return;
    const O = T.opt, sel = T.optExp, R = O.rows.filter((x) => O.scope === "all" || x.exp === sel);
    const spot = (R.find((x) => x.u) || O.rows.find((x) => x.u) || {}).u || T.price;
    const strikes = [...new Set(R.map((x) => x.k))].sort((a, b) => a - b).filter((k) => k > spot * 0.6 && k < spot * 1.5);
    const by = strikes.map((k) => ({ k, c: R.filter((x) => x.k === k && x.t === "C").reduce((s, x) => s + x.oi, 0), p: R.filter((x) => x.k === k && x.t === "P").reduce((s, x) => s + x.oi, 0) }));
    const mx = Math.max(1, ...by.map((x) => Math.max(x.c, x.p)));
    const cOI = R.filter((x) => x.t === "C").reduce((s, x) => s + x.oi, 0), pOI = R.filter((x) => x.t === "P").reduce((s, x) => s + x.oi, 0);
    const cV = R.filter((x) => x.t === "C").reduce((s, x) => s + x.vol, 0), pV = R.filter((x) => x.t === "P").reduce((s, x) => s + x.vol, 0);
    // max pain: strike where option holders' total payoff is smallest
    let mp = null, best = Infinity; strikes.forEach((S0) => { const pay = R.reduce((s, x) => s + x.oi * (x.t === "C" ? Math.max(0, S0 - x.k) : Math.max(0, x.k - S0)), 0); if (pay < best) { best = pay; mp = S0; } });
    const atm = R.filter((x) => x.iv && x.exp === sel).sort((a, b) => Math.abs(a.k - spot) - Math.abs(b.k - spot)).slice(0, 2);
    const atmIv = atm.length ? atm.reduce((s, x) => s + x.iv, 0) / atm.length : null;
    let gauge = "";
    if (O.dv && O.dv.length) {
      const cl = O.dv.map((x) => x[4]), cur2 = cl[cl.length - 1], lo = Math.min(...cl), hi = Math.max(...cl), rank = (cur2 - lo) / (hi - lo || 1), pct = cl.filter((v) => v < cur2).length / cl.length;
      const ang = Math.PI * (1 - rank), cx = 90, cy = 80, rr = 62;
      gauge = `<h4>Implied volatility (DVOL 30-day)</h4><svg class="gauge" width="180" height="96" viewBox="0 0 180 96"><path d="M28 80 A62 62 0 0 1 152 80" fill="none" stroke="#232b38" stroke-width="10"/><path d="M28 80 A62 62 0 0 1 59 26" fill="none" stroke="#22c38e" stroke-width="10" opacity=".7"/><path d="M121 26 A62 62 0 0 1 152 80" fill="none" stroke="#f0565b" stroke-width="10" opacity=".7"/><line x1="${cx}" y1="${cy}" x2="${cx + rr * Math.cos(ang)}" y2="${cy - rr * Math.sin(ang)}" stroke="#e6e9ef" stroke-width="2.5"/><circle cx="${cx}" cy="${cy}" r="4" fill="#e6e9ef"/></svg>
        <div class="metric"><div class="m"><div class="l">DVOL now</div><div class="v">${cur2.toFixed(1)}%</div><div class="s">1-yr range ${lo.toFixed(1)}–${hi.toFixed(1)}%</div></div><div class="m"><div class="l">IV rank / percentile</div><div class="v">${Math.round(rank * 100)}%</div><div class="s">percentile ${Math.round(pct * 100)}%</div></div></div>
        <p class="note">Implied ±1σ move: ±${(cur2 / Math.sqrt(365)).toFixed(2)}%/day · ±${(cur2 / Math.sqrt(12)).toFixed(1)}%/month.</p>`;
    }
    box().innerHTML = `<h4>Options · Deribit</h4><div class="alform"><select id="oExp">${O.exps.map((e) => `<option ${e === sel ? "selected" : ""}>${e}</option>`).join("")}</select><label class="mute" style="font-size:12px"><input type="checkbox" id="oAll" ${O.scope === "all" ? "checked" : ""}> all expiries</label></div>
      <h4>Open interest by strike <span class="mute" style="text-transform:none">· <span class="up">calls</span> / <span class="down">puts</span></span></h4>
      <div class="oibars">${by.map((x) => `<i class="c" style="height:${(x.c / mx) * 100}%" title="${x.k} calls ${x.c.toFixed(0)}"></i><i class="p" style="height:${(x.p / mx) * 100}%" title="${x.k} puts ${x.p.toFixed(0)}"></i>`).join("")}${strikes.length ? `<span class="oispot" style="left:${((spot - strikes[0]) / (strikes[strikes.length - 1] - strikes[0] || 1)) * 100}%" title="spot"></span>` : ""}</div>
      <div class="oiaxis"><span>${strikes[0] ?? ""}</span><span>spot ${fmt.px(spot)}</span><span>${strikes[strikes.length - 1] ?? ""}</span></div>
      <h4>Put/call ratio</h4><div class="metric"><div class="m"><div class="l">By open interest</div><div class="v">${(pOI / (cOI || 1)).toFixed(2)}</div></div><div class="m"><div class="l">By 24h volume</div><div class="v">${(pV / (cV || 1)).toFixed(2)}</div></div></div>
      <div class="pcbar"><i style="width:${(cOI / (cOI + pOI || 1)) * 100}%"></i></div><div class="oiaxis"><span class="up">Calls ${Math.round((cOI / (cOI + pOI || 1)) * 100)}% · ${Math.round(cOI).toLocaleString()}</span><span class="down">Puts ${Math.round(pOI).toLocaleString()}</span></div>
      <div class="metric" style="margin-top:8px"><div class="m"><div class="l">Max pain</div><div class="v">${mp ? fmt.px(mp) : "–"}</div><div class="s">${mp ? fmt.pct(mp / spot - 1, 1) + " vs spot" : ""}</div></div><div class="m"><div class="l">ATM IV (${sel})</div><div class="v">${atmIv ? atmIv.toFixed(1) + "%" : "–"}</div></div></div>${gauge}`;
    $("oExp").onchange = (e) => { T.optExp = e.target.value; options(cur); };
    $("oAll").onchange = (e) => { T.opt.scope = e.target.checked ? "all" : null; options(cur); };
  } catch (e) { if (box()) box().innerHTML = `<p class="note">Options data unavailable (${e.message || "network"}).</p>`; }
}

/* ================= search ================= */
let SR = { mode: "go", list: [], hl: 0 };
function openSearch(mode) { SR.mode = mode; $("search").hidden = false; $("sIn").value = ""; renderSearch(); $("sIn").focus(); }
function renderSearch() {
  const q = $("sIn").value.trim().toLowerCase();
  SR.list = all().filter((r) => !q || r.sym.toLowerCase().includes(q) || (r.label || "").toLowerCase().includes(q) || (r.name || "").toLowerCase().includes(q)).slice(0, 40); SR.hl = 0;
  $("sRes").innerHTML = SR.list.map((r, i) => `<div data-s="${r.sym}" class="${i === 0 ? "hl" : ""}"><span><b>${disp(r)}</b> <span class="n">${r.name || ""}</span></span><span class="n">${r._cls}</span></div>`).join("");
  $("sRes").querySelectorAll("div").forEach((d) => (d.onclick = () => pick(d.dataset.s)));
}
function pick(sym) { $("search").hidden = true; if (SR.mode === "add") { if (!T.wl.includes(sym)) T.wl.push(sym); LS.set("term_wl", T.wl); side(); subs(); } else load(sym); }
$("sIn").addEventListener("input", renderSearch);
$("sIn").addEventListener("keydown", (e) => { if (e.key === "Enter" && SR.list[SR.hl]) pick(SR.list[SR.hl].sym); if (e.key === "Escape") $("search").hidden = true; if (e.key === "ArrowDown" || e.key === "ArrowUp") { SR.hl = Math.max(0, Math.min(SR.list.length - 1, SR.hl + (e.key === "ArrowDown" ? 1 : -1))); [...$("sRes").children].forEach((d, i) => d.classList.toggle("hl", i === SR.hl)); e.preventDefault(); } });
$("search").addEventListener("click", (e) => { if (e.target.id === "search") $("search").hidden = true; });
document.addEventListener("keydown", (e) => { if (e.key === "/" && $("search").hidden && document.activeElement.tagName !== "INPUT") { e.preventDefault(); openSearch("go"); } });

/* ================= wiring ================= */
$("tSym").onclick = () => openSearch("go");
$("tTf").onclick = (e) => { const tf = e.target.dataset.tf; if (tf && !e.target.disabled) load(T.r.sym, tf); };
$("tTog").onclick = (e) => { const k = e.target.dataset.k; if (!k) return; T.tog[k] = T.tog[k] ? 0 : 1; e.target.classList.toggle("on", !!T.tog[k]); LS.set("term_tog", T.tog); draw(); };
$("sTabs").onclick = (e) => { const t = e.target.dataset.t; if (!t) return; T.tab = t; [...$("sTabs").children].forEach((x) => x.classList.toggle("on", x.dataset.t === t)); side(); };
$("tFull").onclick = () => { try { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen(); } catch (e) {} };
let rsT; window.addEventListener("resize", () => { clearTimeout(rsT); rsT = setTimeout(draw, 200); });
document.addEventListener("fullscreenchange", () => setTimeout(draw, 200));

async function boot() {
  S.data = await fetchJ("data/screener.json?" + Date.now());
  T.acc = await fetchJ("data/accuracy.json?" + Date.now()).catch(() => null);
  Object.entries(S.data.classes).forEach(([c, l]) => l.forEach((x) => (x._cls = c)));
  [...$("tTog").children].forEach((x) => x.classList.toggle("on", !!T.tog[x.dataset.k]));
  const q = new URLSearchParams(location.search);
  await load(q.get("s") || "BTC-USD", q.get("tf") || "1D");
  pollCrypto(); setInterval(pollCrypto, 5000);
  connectWs();
  setInterval(liveStatus, 2000);
  // crypto candle refresh for the open chart (keeps intraday bars exact)
  setInterval(async () => { if (T.r && T.r._cls === "crypto") { try { const k = await binKlines(T.r, T.tf, 2); k.forEach((x) => { const L = T.bars[T.bars.length - 1]; if (x.t === L.t) Object.assign(L, x); else if (x.t > L.t) T.bars.push(x); }); const L = T.bars[T.bars.length - 1]; if (T.s.cs) T.s.cs.update({ time: L.t, open: L.o, high: L.h, low: L.l, close: L.c }); header(); } catch (e) {} } }, 3000);
  // newer server snapshot (model refresh every ~15 min)
  setInterval(async () => { try { const d = await fetchJ("data/screener.json?" + Date.now()); if (d.generated !== S.data.generated) { const keep = T.prices; S.data = d; Object.entries(S.data.classes).forEach(([c, l]) => l.forEach((x) => (x._cls = c))); T.prices = keep; load(T.r.sym); } } catch (e) {} }, 5 * 60 * 1000);
  // self-update when a new build is published
  setInterval(async () => { try { const t = await (await fetch("terminal.html?ts=" + Date.now(), { cache: "no-store" })).text(); const m = t.match(/<meta name="build" content="([^"]+)"/), mine = document.querySelector('meta[name="build"]').content; if (m && m[1] !== mine && !/__V__/.test(m[1])) location.replace(location.pathname + `?s=${encodeURIComponent(T.r.sym)}&tf=${T.tf}&v=${m[1]}`); } catch (e) {} }, 10 * 60 * 1000);
}
boot();
