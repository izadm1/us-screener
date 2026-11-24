// Walk-forward accuracy test of the Forecast Terminal (uses the terminal's own maths, tmath.js).
// Settings are selected on the TRAIN half (older origins / first 60% of bars) and reported on VALIDATE.
// Usage: node accuracy.mjs <data_dir> <out_json>
import fs from "fs";
import path from "path";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const M = require(path.resolve(path.dirname(new URL(import.meta.url).pathname), "../tmath.js"));
const [, , DIR = "/tmp/acc", OUT = "accuracy.json"] = process.argv;

const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json"));
const series = {};
for (const f of files) {
  const [sym, tf] = f.replace(".json", "").split("__");
  let b = JSON.parse(fs.readFileSync(path.join(DIR, f)));
  if (b.length < 300) continue;
  (series[tf] ||= {})[sym] = b;
  if (tf === "1H") { // 4H by resampling
    const o = []; b.forEach((x) => { const k = Math.floor(x.t / 14400) * 14400, L = o[o.length - 1]; if (L && L.t === k) { L.h = Math.max(L.h, x.h); L.l = Math.min(L.l, x.l); L.c = x.c; L.v = (L.v || 0) + (x.v || 0); } else o.push({ ...x, t: k }); });
    if (o.length >= 300) (series["4H"] ||= {})[sym] = o;
  }
}
const cls = (s) => (s.endsWith("-USD") ? "crypto" : s.includes("_X") || s === "GC_F" ? "fx" : "equity");

/* ---------- 1. turning dates + wave direction ---------- */
function pivots(b, K) { const n = b.length, hi = new Array(n).fill(false), lo = new Array(n).fill(false); for (let i = K; i < n - K; i++) { let H = true, L = true; for (let j = i - K; j <= i + K; j++) { if (b[j].h > b[i].h) H = false; if (b[j].l < b[i].l) L = false; } hi[i] = H; lo[i] = L; } return { hi, lo }; }
function turnTest(b, cfg) {
  Object.assign(M.TM, cfg);
  const n = b.length, lc = b.map((x) => Math.log(x.c)), piv = {}, out = { tr: { hit: 0, n: 0, base: 0, dir: 0, dn: 0, r: [[0, 0], [0, 0], [0, 0]] }, va: { hit: 0, n: 0, base: 0, dir: 0, dn: 0, r: [[0, 0], [0, 0], [0, 0]] } };
  const start = Math.max(cfg.win + 20, 200), end = n - 160;
  if (end - start < 40) return null;
  const NO = 160, step = Math.max(1, Math.floor((end - start) / NO));
  const mid = start + (end - start) / 2;
  for (let o = start; o < end; o += step) {
    const c = M.multiCycle(lc.slice(0, o + 1), cfg.nCyc); if (!c) continue;
    const Pmin = Math.min(...c.periods), K = Math.max(3, Math.round(Pmin / 4)), tol = Math.max(2, Math.round(Pmin / 8)), H = Math.min(120, Math.round(1.5 * Math.max(...c.periods)));
    const pv = (piv[K] ||= pivots(b, K));
    const seg = o < mid ? out.tr : out.va;
    // base rate around this origin's future window
    let bh = 0, bn = 0; for (let t0 = o + 1; t0 <= Math.min(n - K - 1, o + H); t0++) { bn++; let hh = false, ll = false; for (let j = t0 - tol; j <= t0 + tol; j++) { if (pv.hi[j]) hh = true; if (pv.lo[j]) ll = true; } bh += (hh + ll) / 2; }
    const base = bn ? bh / bn : 0.5;
    let r = 0;
    for (let k = 1; k <= H && r < 3; k++) {
      const a = c.at(k - 1), m = c.at(k), d = c.at(k + 1), isH = m > a && m >= d, isL = m < a && m <= d;
      if (!isH && !isL) continue;
      const t0 = o + k; if (t0 + tol >= n - K) break;
      let hit = false; for (let j = t0 - tol; j <= t0 + tol; j++) if ((isH ? pv.hi : pv.lo)[j]) hit = true;
      seg.hit += hit; seg.n++; seg.base += base; seg.r[r][0] += hit; seg.r[r][1]++; r++;
    }
    // wave direction over a quarter of the shortest cycle
    const h = Math.max(2, Math.round(Pmin / 4));
    if (o + h < n) { const pred = Math.sign(c.at(h) - c.at(0)), act = Math.sign(lc[o + h] - lc[o]); if (pred && act) { seg.dir += pred === act; seg.dn++; } }
  }
  return out;
}

/* ---------- 2. cone calibration (σ cone from recent volatility) ---------- */
function coneTest(b) {
  const lc = b.map((x) => Math.log(x.c)), res = { 5: [0, 0, 0], 20: [0, 0, 0] };
  for (let o = 250; o < b.length - 21; o += 3) {
    const s = M.volTf(b.slice(0, o + 1));
    for (const k of [5, 20]) { const z = (lc[o + k] - lc[o]) / (s * Math.sqrt(k)); res[k][0] += Math.abs(z) <= 0.674; res[k][1] += Math.abs(z) <= 1.2816; res[k][2]++; }
  }
  return res;
}

/* ---------- 3. BUY/SELL trail signals ---------- */
function trailTest(b, n, m, filt) {
  Object.assign(M.TM, { stN: n, stM: m });
  const st = M.stA(b, n, m), e200 = M.emaA(b.map((x) => x.c), 200), N = b.length, cut = Math.floor(N * 0.6);
  const seg = { tr: [], va: [] };
  let pos = 0, entry = 0, ei = 0;
  const close = (i) => { if (!pos) return; const r = pos * Math.log(b[i].c / entry); (ei < cut ? seg.tr : seg.va).push(r); pos = 0; };
  for (let i = 201; i < N; i++) {
    if (st.dir[i] !== st.dir[i - 1]) {
      close(i);
      const d = st.dir[i];
      const ok = filt === "none" || (filt === "ema200" && ((d === 1 && b[i].c > e200[i]) || (d === -1 && b[i].c < e200[i])));
      if (ok) { pos = d; entry = b[i].c; ei = i; }
    }
  }
  close(N - 1);
  const stat = (a) => { const w = a.filter((x) => x > 0), l = a.filter((x) => x <= 0), gw = w.reduce((s, x) => s + x, 0), gl = -l.reduce((s, x) => s + x, 0); return { n: a.length, win: a.length ? w.length / a.length : 0, pf: gl ? gw / gl : gw ? 9 : 0, tot: a.reduce((s, x) => s + x, 0), avg: a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0 }; };
  return { tr: stat(seg.tr), va: stat(seg.va) };
}

/* ---------- run ---------- */
const report = { generated: new Date().toISOString(), tf: {} };
const TURN_GRID = []; for (const nCyc of [1, 2, 3]) for (const win of [150, 300, 500]) TURN_GRID.push({ nCyc, win, pmin: 8, pmaxCap: 120, sep: 1.3 });
const trailGrid = (tf) => { const g = []; for (const n of [7, 10, 14, 20, 30]) for (const m of [2, 2.5, 3, 3.5, 4, 5]) for (const filt of tf === "1D" ? ["none", "ema200"] : ["none", "ema200", "daily"]) g.push({ n, m, filt }); return g; };
function dailyDir(b) { // daily ATR-trail direction of the previous completed UTC day, mapped onto each intraday bar (no look-ahead)
  const days = []; b.forEach((x) => { const k = Math.floor(x.t / 86400), L = days[days.length - 1]; if (L && L.k === k) { L.h = Math.max(L.h, x.h); L.l = Math.min(L.l, x.l); L.c = x.c; } else days.push({ k, o: x.o, h: x.h, l: x.l, c: x.c }); });
  const st = M.stA(days, 10, 3), idx = {}; days.forEach((d, i) => (idx[d.k] = i));
  return b.map((x) => { const i = idx[Math.floor(x.t / 86400)]; return i > 0 ? st.dir[i - 1] : 0; });
}

for (const [tf, syms] of Object.entries(series)) {
  const R = (report.tf[tf] = { symbols: Object.keys(syms).length, turns: [], cone: null, trail: [] });
  // turns
  for (const cfg of TURN_GRID) {
    const agg = { tr: { hit: 0, n: 0, base: 0, dir: 0, dn: 0 }, va: { hit: 0, n: 0, base: 0, dir: 0, dn: 0 }, byCls: {} };
    for (const [s, b] of Object.entries(syms)) {
      const r = turnTest(b, cfg); if (!r) continue;
      for (const k of ["tr", "va"]) for (const f of ["hit", "n", "base", "dir", "dn"]) agg[k][f] += r[k][f];
      const c = (agg.byCls[cls(s)] ||= { hit: 0, n: 0, base: 0 }); c.hit += r.va.hit; c.n += r.va.n; c.base += r.va.base;
    }
    const sum = (x) => ({ hit: x.n ? x.hit / x.n : 0, base: x.n ? x.base / x.n : 0, edge: x.n ? (x.hit - x.base) / x.n : 0, n: x.n, dir: x.dn ? x.dir / x.dn : 0, dn: x.dn });
    R.turns.push({ cfg: { nCyc: cfg.nCyc, win: cfg.win }, train: sum(agg.tr), valid: sum(agg.va), byCls: Object.fromEntries(Object.entries(agg.byCls).map(([k, v]) => [k, sum(v)])) });
    console.log(tf, "turns", JSON.stringify(R.turns[R.turns.length - 1].cfg), "train edge", R.turns.at(-1).train.edge.toFixed(3), "valid edge", R.turns.at(-1).valid.edge.toFixed(3), "dir", R.turns.at(-1).valid.dir.toFixed(3));
  }
  R.turns.sort((a, b) => b.train.edge - a.train.edge);
  R.bestTurn = R.turns[0];
  // cone
  const cone = { 5: [0, 0, 0], 20: [0, 0, 0] };
  for (const b of Object.values(syms)) { const c = coneTest(b); for (const k of [5, 20]) for (let i = 0; i < 3; i++) cone[k][i] += c[k][i]; }
  R.cone = { 5: { c50: cone[5][0] / cone[5][2], c80: cone[5][1] / cone[5][2] }, 20: { c50: cone[20][0] / cone[20][2], c80: cone[20][1] / cone[20][2] } };
  console.log(tf, "cone", JSON.stringify(R.cone));
  // trail
  for (const g of trailGrid(tf)) {
    const all = { tr: [], va: [] }, agg = { tr: { n: 0, w: 0, gw: 0, gl: 0, tot: 0 }, va: { n: 0, w: 0, gw: 0, gl: 0, tot: 0 } };
    // recompute pf properly
    let tr = { n: 0, w: 0, gw: 0, gl: 0, tot: 0 }, va = { n: 0, w: 0, gw: 0, gl: 0, tot: 0 };
    for (const b of Object.values(syms)) { const r = trailRaw(b, g); for (const [k, acc] of [["tr", tr], ["va", va]]) r[k].forEach((x) => { acc.n++; acc.tot += x; if (x > 0) { acc.w++; acc.gw += x; } else acc.gl -= x; }); }
    const f = (a) => ({ n: a.n, win: a.n ? a.w / a.n : 0, pf: a.gl ? a.gw / a.gl : 0, avg: a.n ? a.tot / a.n : 0 });
    R.trail.push({ cfg: g, train: f(tr), valid: f(va) });
  }
  R.trail.sort((a, b) => b.train.pf - a.train.pf);
  R.byFilter = {}; for (const f of ["none", "ema200", "daily"]) { const x = R.trail.filter((t) => t.cfg.filt === f); if (x.length) R.byFilter[f] = x[0]; }
  R.bestTrail = R.trail[0];
  const LIVE_CFG = { "1D": { n: 20, m: 3, filt: "none" }, "4H": { n: 10, m: 5, filt: "ema200" }, "1H": { n: 20, m: 5, filt: "daily" } }[tf];
  R.currentTrail = R.trail.find((x) => LIVE_CFG && x.cfg.n === LIVE_CFG.n && x.cfg.m === LIVE_CFG.m && x.cfg.filt === LIVE_CFG.filt);
  console.log(tf, "best trail", JSON.stringify(R.bestTrail), "current", JSON.stringify(R.currentTrail));
}
function trailRaw(b, g) {
  const st = M.stA(b, g.n, g.m), e200 = M.emaA(b.map((x) => x.c), 200), N = b.length, cut = Math.floor(N * 0.6), seg = { tr: [], va: [] };
  const dd = g.filt === "daily" ? (b._dd ||= dailyDir(b)) : null;
  let pos = 0, entry = 0, ei = 0;
  const close = (i) => { if (!pos) return; (ei < cut ? seg.tr : seg.va).push(pos * Math.log(b[i].c / entry)); pos = 0; };
  for (let i = 201; i < N; i++) if (st.dir[i] !== st.dir[i - 1]) { close(i); const d = st.dir[i]; if (g.filt === "none" || (g.filt === "ema200" && ((d === 1 && b[i].c > e200[i]) || (d === -1 && b[i].c < e200[i]))) || (g.filt === "daily" && dd[i] === d)) { pos = d; entry = b[i].c; ei = i; } }
  close(N - 1);
  return seg;
}
/* ---------- 4. Wyckoff: confirmation filter for BUY/SELL, and Wyckoff events as stand-alone trades ---------- */
const LIVE = { "1D": { n: 20, m: 3, filt: "none" }, "4H": { n: 10, m: 5, filt: "ema200" }, "1H": { n: 20, m: 5, filt: "daily" } };
function trailWy(b, g, wy, thr) {
  const st = M.stA(b, g.n, g.m), e200 = M.emaA(b.map((x) => x.c), 200), N = b.length, cut = Math.floor(N * 0.6), seg = { tr: [], va: [] };
  const dd = g.filt === "daily" ? (b._dd ||= dailyDir(b)) : null;
  let pos = 0, entry = 0, ei = 0;
  const close = (i) => { if (!pos) return; (ei < cut ? seg.tr : seg.va).push(pos * Math.log(b[i].c / entry)); pos = 0; };
  for (let i = 201; i < N; i++) if (st.dir[i] !== st.dir[i - 1]) {
    close(i); const d = st.dir[i];
    const base = g.filt === "none" || (g.filt === "ema200" && ((d === 1 && b[i].c > e200[i]) || (d === -1 && b[i].c < e200[i]))) || (g.filt === "daily" && dd[i] === d);
    const wok = !wy || (d === 1 ? wy.bias[i] >= thr : wy.bias[i] <= -thr);
    if (base && wok) { pos = d; entry = b[i].c; ei = i; }
  }
  close(N - 1); return seg;
}
const statOf = (a) => { let w = 0, gw = 0, gl = 0, t = 0; a.forEach((x) => { t += x; if (x > 0) { w++; gw += x; } else gl -= x; }); return { n: a.length, win: a.length ? w / a.length : 0, pf: gl ? gw / gl : 0, avg: a.length ? t / a.length : 0 }; };
for (const [tf, syms] of Object.entries(series)) {
  const R = report.tf[tf], g = LIVE[tf]; if (!g) continue;
  const W = {}; for (const [s, b] of Object.entries(syms)) W[s] = M.wyckoff(b);
  R.wyck = { trail: {}, events: {} };
  for (const thr of [0, 0.2, 0.4]) {
    const tr = [], va = [], trB = [], vaB = [];
    for (const [s, b] of Object.entries(syms)) { const r = trailWy(b, g, W[s], thr); tr.push(...r.tr); va.push(...r.va); }
    R.wyck.trail["bias>=" + thr] = { train: statOf(tr), valid: statOf(va) };
  }
  { const tr = [], va = []; for (const b of Object.values(syms)) { const r = trailWy(b, g, null, 0); tr.push(...r.tr); va.push(...r.va); } R.wyck.trail.base = { train: statOf(tr), valid: statOf(va) }; }
  for (const H of [10, 20]) for (const [s, b] of Object.entries(syms)) {
    const N = b.length, cut = Math.floor(N * 0.6);
    for (const e of W[s].events) { if (e.type === "AR" || e.i + H >= N) continue; const k = e.type + "|" + H; const E = (R.wyck.events[k] ||= { tr: [], va: [] }); (e.i < cut ? E.tr : E.va).push(e.side * Math.log(b[e.i + H].c / b[e.i].c)); }
  }
  for (const k of Object.keys(R.wyck.events)) { const E = R.wyck.events[k]; R.wyck.events[k] = { train: statOf(E.tr), valid: statOf(E.va) }; }
  console.log(tf, "wyckoff trail", JSON.stringify(R.wyck.trail));
  console.log(tf, "wyckoff events", JSON.stringify(R.wyck.events));
}
/* ---------- 5. Improvement round: filters, exits and pullback entries on top of the live BUY/SELL ---------- */
const dKey = (t) => Math.floor(t / 86400);
function regimeMap(b) { const e = M.emaA(b.map((x) => x.c), 200), m = {}; b.forEach((x, i) => { if (e[i] != null) m[dKey(x.t) + 1] = x.c > e[i] ? 1 : -1; }); return m; }
const REG = { equity: series["1D"] && series["1D"]["SPY"] ? regimeMap(series["1D"]["SPY"]) : {}, crypto: series["1D"] && series["1D"]["BTC-USD"] ? regimeMap(series["1D"]["BTC-USD"]) : {} };
const regAt = (c, t) => { const m = REG[c]; if (!m) return 0; for (let k = 0; k < 6; k++) { const v = m[dKey(t) - k]; if (v) return v; } return 0; };
function htfDir(b, tf) { // previous completed higher-timeframe bar's trail direction (1D→weekly, 4H/1H→daily)
  const key = tf === "1D" ? (t) => { const d = new Date(t * 1000), dow = (d.getUTCDay() + 6) % 7; return dKey(t) - dow; } : (t) => dKey(t);
  const H = []; b.forEach((x) => { const k = key(x.t), L = H[H.length - 1]; if (L && L.k === k) { L.h = Math.max(L.h, x.h); L.l = Math.min(L.l, x.l); L.c = x.c; } else H.push({ k, o: x.o, h: x.h, l: x.l, c: x.c }); });
  const st = M.stA(H, 10, 3), idx = {}; H.forEach((h, i) => (idx[h.k] = i));
  return b.map((x) => { const i = idx[key(x.t)]; return i > 0 ? st.dir[i - 1] : 0; });
}
function simulate(b, sym, tf, v) {
  const g = LIVE[tf], c = cls(sym), N = b.length, cut = Math.floor(N * 0.6);
  const st = M.stA(b, g.n, g.m), e200 = M.emaA(b.map((x) => x.c), 200), dd = g.filt === "daily" ? (b._dd ||= dailyDir(b)) : null;
  const adx = v.adx ? (b._adx ||= M.adxA(b, 14)) : null, er = v.er ? (b._er ||= M.erA(b, 20)) : null;
  const hd = v.htf ? (b["_htf" + tf] ||= htfDir(b, tf)) : null, r2 = v.pull ? (b._r2 ||= M.rsiA(b, 2)) : null;
  const vAvg = (i) => { let s0 = 0; for (let j = i - 20; j < i; j++) s0 += b[j].v || 0; return s0 / 20; };
  const ok = (i, d) => {
    if (!(g.filt === "none" || (g.filt === "ema200" && ((d === 1 && b[i].c > e200[i]) || (d === -1 && b[i].c < e200[i]))) || (g.filt === "daily" && dd[i] === d))) return false;
    if (v.adx && !(adx[i] >= v.adx)) return false;
    if (v.er && !(er[i] >= v.er)) return false;
    if (v.regime && c !== "fx" && regAt(c, b[i].t) !== d) return false;
    if (v.htf && hd[i] !== d) return false;
    if (v.session && c === "fx" && tf !== "1D") { const h = new Date(b[i].t * 1000).getUTCHours(); if (h < 7 || h > 20) return false; }
    if (v.vol && c !== "fx" && !((b[i].v || 0) >= 1.2 * vAvg(i))) return false;
    return true;
  };
  const out = { tr: [], va: [] };
  const push = (i, r) => (i < cut ? out.tr : out.va).push(r);
  let busyUntil = 0;
  for (let i = 201; i < N - 1; i++) {
    if (i <= busyUntil) continue;
    let d = 0, kind = "";
    if (!v.pull && st.dir[i] !== st.dir[i - 1]) { d = st.dir[i]; kind = "trail"; }
    if (v.pull && st.dir[i] === st.dir[i - 1] && r2[i] != null) { const dd0 = st.dir[i]; if ((dd0 === 1 && r2[i] < 10) || (dd0 === -1 && r2[i] > 90)) { d = dd0; kind = "pull"; } }
    if (!d || !ok(i, d)) continue;
    const entry = b[i].c, stop0 = st.stop[i]; const R = Math.abs(entry - stop0) / entry;
    let half = false, j = i + 1, ret = null;
    for (; j < N; j++) {
      const x = b[j];
      if (kind === "pull") { if ((d === 1 && r2[j] > 70) || (d === -1 && r2[j] < 30) || st.dir[j] !== d || j - i >= 10) { ret = d * (x.c / entry - 1); break; } continue; }
      if (v.exit === "half1R" && R > 0) {
        if (half && (d === 1 ? x.l <= entry : x.h >= entry)) { ret = 0.5 * R; break; }
        if (!half && (d === 1 ? x.h >= entry * (1 + R) : x.l <= entry * (1 - R))) half = true;
      }
      if (st.dir[j] !== d) { const rem = d * (x.c / entry - 1); ret = half ? 0.5 * R + 0.5 * rem : rem; break; }
    }
    if (ret == null) { const rem = d * (b[N - 1].c / entry - 1); ret = half ? 0.5 * R + 0.5 * rem : rem; j = N - 1; }
    push(i, ret); busyUntil = j - 1;
  }
  return out;
}
const VARIANTS = { base: {}, adx20: { adx: 20 }, adx25: { adx: 25 }, er30: { er: 0.3 }, er40: { er: 0.4 }, regime: { regime: true }, htf: { htf: true }, session: { session: true }, volume: { vol: true }, half1R: { exit: "half1R" }, pullback: { pull: true }, pullbackRegime: { pull: true, regime: true }, pullbackHtf: { pull: true, htf: true } };
const runV = (syms, tf, v) => { const tr = [], va = []; for (const [s, b] of Object.entries(syms)) { const r = simulate(b, s, tf, v); tr.push(...r.tr); va.push(...r.va); } return { train: statOf(tr), valid: statOf(va) }; };
for (const [tf, syms] of Object.entries(series)) {
  if (!LIVE[tf]) continue;
  const R = report.tf[tf]; R.improve = {};
  for (const [k, v] of Object.entries(VARIANTS)) R.improve[k] = { v, ...runV(syms, tf, v) };
  const base = R.improve.base, better = (x) => x.train.pf > base.train.pf && x.valid.pf > base.valid.pf && x.train.win >= base.train.win - 0.005 && x.valid.win >= base.valid.win - 0.005 && x.valid.n >= 80;
  const filt = ["adx20", "adx25", "er30", "er40", "regime", "htf", "session", "volume"].filter((k) => better(R.improve[k]));
  // combine the winning filters (one ADX/ER threshold max), with and without the half-at-1R exit
  const pick = filt.filter((k) => !(k === "adx20" && filt.includes("adx25") && R.improve.adx25.valid.pf >= R.improve.adx20.valid.pf) && !(k === "adx25" && filt.includes("adx20") && R.improve.adx20.valid.pf > R.improve.adx25.valid.pf) && !(k === "er30" && filt.includes("er40") && R.improve.er40.valid.pf >= R.improve.er30.valid.pf) && !(k === "er40" && filt.includes("er30") && R.improve.er30.valid.pf > R.improve.er40.valid.pf));
  const combo = Object.assign({}, ...pick.map((k) => VARIANTS[k]));
  R.improve.combo = { v: combo, picked: pick, ...runV(syms, tf, combo) };
  R.improve.comboHalf = { v: { ...combo, exit: "half1R" }, picked: pick, ...runV(syms, tf, { ...combo, exit: "half1R" }) };
  const pbBest = ["pullback", "pullbackRegime", "pullbackHtf"].map((k) => [k, R.improve[k]]).sort((a, b) => b[1].train.pf - a[1].train.pf)[0];
  R.improve.pullbackPick = { name: pbBest[0], ...pbBest[1] };
  for (const [k, x] of Object.entries(R.improve)) console.log(tf, "improve", k.padEnd(15), "train pf %s win %s n %s | valid pf %s win %s n %s".replace(/%s/g, () => "") , x.train.pf.toFixed(2), x.train.win.toFixed(2), x.train.n, "|", x.valid.pf.toFixed(2), x.valid.win.toFixed(2), x.valid.n, x.picked ? x.picked.join("+") : "");
}
fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
console.log("written", OUT);
