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
    const o = []; b.forEach((x) => { const k = Math.floor(x.t / 14400) * 14400, L = o[o.length - 1]; if (L && L.t === k) { L.h = Math.max(L.h, x.h); L.l = Math.min(L.l, x.l); L.c = x.c; } else o.push({ ...x, t: k }); });
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
fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
console.log("written", OUT);
