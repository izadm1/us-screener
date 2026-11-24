// Tested daily signals for every asset in the screener, computed with the terminal's own maths (tmath.js).
// Only signal types that passed the walk-forward accuracy test are used; their tested stats come from data/accuracy.json.
// Usage: node signals.mjs <data_dir>   (reads data_dir/history/*.json, data_dir/screener.json, data_dir/accuracy.json; writes data_dir/signals.json)
import fs from "fs";
import path from "path";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const M = require(path.resolve(path.dirname(new URL(import.meta.url).pathname), "../tmath.js"));
const DIR = process.argv[2] || "multi/data";
const read = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f)));
const S = read("screener.json");
let A = null; try { A = read("accuracy.json"); } catch (e) { console.log("no accuracy.json — signals will carry no tested stats"); }
let META = null; try { META = read("meta.json"); if (!META.model) META = null; } catch (e) { console.log("no meta.json — no high-quality filter"); }
const TRACK = process.argv.includes("--track") ? path.join(DIR, "track.json") : null;
const COST = { equity: 0.001, crypto: 0.002, forex: 0.0004 };
// tested win rate at a given model confidence (from the unseen test period)
const winAt = (p) => { if (!META) return null; const g = META.byR[META.model.Rm].test.filter((x) => x.n >= 20 && x.t <= p + 1e-9); return g.length ? { win: g[g.length - 1].win, avgR: g[g.length - 1].avgR, n: g[g.length - 1].n, t: g[g.length - 1].t } : null; };
const safe = (s) => s.replace(/[^A-Za-z0-9\-_.]/g, "_");
const bars = (sym) => { try { const h = read(`history/${safe(sym)}.json`); return h.t.map((t, i) => ({ t, o: h.o[i], h: h.h[i], l: h.l[i], c: h.c[i], v: h.v[i] || 0 })).filter((x) => x.c != null); } catch (e) { return null; } };

const CFG = { stN: 20, stM: 3, fresh: 5 };
const D = A && A.tf && A.tf["1D"];
const stat = (x) => (x && x.valid ? { pf: x.valid.pf, win: x.valid.win, n: x.valid.n } : null);
const TRAIL = stat(D && D.improve && D.improve.half1R);
const PB = stat(D && D.improve && D.improve.pullbackRegime);
const WYV = {};
if (D && D.wyck) Object.entries(D.wyck.events).forEach(([k, v]) => { const [type, H] = k.split("|"); if (v.train.pf > 1.1 && v.valid.pf > 1.1 && v.valid.n >= 30 && v.train.n >= 30 && (!WYV[type] || v.valid.pf > WYV[type].pf)) WYV[type] = { H: +H, pf: v.valid.pf, win: v.valid.win, n: v.valid.n }; });
const WY_NAME = { SC: "Selling Climax", ST: "Secondary Test", Spring: "Spring", SOS: "Sign of Strength", LPS: "Last Point of Support", BC: "Buying Climax", UT: "Upthrust", UTAD: "Upthrust After Distribution", SOW: "Sign of Weakness", LPSY: "Last Point of Supply" };

function regimeMap(b) { const e = M.emaA(b.map((x) => x.c), 200), m = {}; b.forEach((x, i) => { if (e[i] != null) m[Math.floor(x.t / 86400) + 1] = x.c > e[i] ? 1 : -1; }); return m; }
const REG = { equity: bars("SPY") ? regimeMap(bars("SPY")) : {}, crypto: bars("BTC-USD") ? regimeMap(bars("BTC-USD")) : {} };
const regAt = (cls, t) => { if (cls === "forex") return 0; const m = REG[cls === "crypto" ? "crypto" : "equity"]; for (let k = 0; k < 6; k++) { const v = m[Math.floor(t / 86400) - k]; if (v) return v; } return 0; };
const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);

const out = { generated: S.generated, tested: { trail: TRAIL, pullback: PB, wyckoff: WYV, date: A ? A.generated : null }, quality: META ? { threshold: META.model.threshold, Rm: META.model.Rm, H: META.model.H, test: META.model.test, testBase: META.model.testBase, samples: META.samples, assets: META.assets, split: META.split, date: META.generated, grid: META.byR[META.model.Rm].test } : null, assets: {} };
for (const [cls, list] of Object.entries(S.classes)) for (const r of list) {
  const b = bars(r.sym); if (!b || b.length < 230) continue;
  const n = b.length, st = M.stA(b, CFG.stN, CFG.stM), atr = M.atrA(b, 14), r2 = M.rsiA(b, 2), wy = M.wyckoff(b);
  const cands = [];
  for (let i = 201; i < n; i++) if (st.dir[i] !== st.dir[i - 1] && st.stop[i - 1] != null && TRAIL) cands.push({ i, side: st.dir[i], type: "TRAIL", name: "ATR trail flip (20×3)", stop: st.stop[i], ...TRAIL, hold: "½ at 1R, rest until the trail flips", half: true });
  let prev = false;
  for (let i = 201; i < n; i++) { const d = st.dir[i], q = st.dir[i] === st.dir[i - 1] && r2[i] != null && ((d === 1 && r2[i] < 10) || (d === -1 && r2[i] > 90)) && (cls === "forex" || regAt(cls, b[i].t) === d); if (q && !prev && PB) cands.push({ i, side: d, type: "PULLBACK", name: "RSI(2) pullback in trend", stop: st.stop[i], ...PB, hold: "until RSI(2) recovers (max 10 days)" }); prev = q; }
  wy.events.forEach((e) => { const v = WYV[e.type]; if (v) { const lo = Math.min(...b.slice(Math.max(0, e.i - 5), e.i + 1).map((x) => x.l)), hi = Math.max(...b.slice(Math.max(0, e.i - 5), e.i + 1).map((x) => x.h)); cands.push({ i: e.i, side: e.side, type: e.type, name: `Wyckoff ${WY_NAME[e.type] || e.type}`, stop: e.side > 0 ? lo - 0.25 * atr[e.i] : hi + 0.25 * atr[e.i], pf: v.pf, win: v.win, n: v.n, hold: `about ${v.H} days` }); } });
  const fmt = (x) => { const p = b[x.i].c, R = Math.abs(p - x.stop); return { side: x.side, type: x.type, name: x.name, date: iso(b[x.i].t), bars: n - 1 - x.i, price: p, stop: x.stop, tp1: p + x.side * R, risk: R / p, pf: x.pf, win: x.win, n: x.n, hold: x.hold, half: !!x.half, now: b[n - 1].c, move: x.side * (b[n - 1].c / p - 1), stopped: x.side > 0 ? Math.min(...b.slice(x.i + 1).map((y) => y.l), Infinity) <= x.stop : Math.max(...b.slice(x.i + 1).map((y) => y.h), -Infinity) >= x.stop }; };
  const valid = cands.filter((x) => x.stop != null && (x.side > 0 ? x.stop < b[x.i].c : x.stop > b[x.i].c));
  const fresh = valid.filter((x) => n - 1 - x.i <= CFG.fresh && x.pf > 1).map(fmt).filter((x) => !x.stopped).sort((a, c) => c.pf - a.pf || a.bars - c.bars);
  const last = valid.sort((a, c) => c.i - a.i)[0];
  // ---- high-quality signals: quality model on every recent candidate ----
  let hq = [];
  const LEV = new Set(["TQQQ", "SQQQ", "SOXL", "SOXS", "UVXY"]);
  if (META && !LEV.has(r.sym)) {
    const m = META.model, ctx = M.metaPrep(b, cls, regAt);
    hq = M.metaCands(ctx, n - 1 - CFG.fresh).map((k) => {
      const p = M.metaProb(m, M.metaFeat(ctx, k)), e = b[k.i].c, risk = Math.abs(e - k.stop);
      const after = b.slice(k.i + 1), stopped = k.side > 0 ? after.some((y) => y.l <= k.stop) : after.some((y) => y.h >= k.stop), hit = k.side > 0 ? after.some((y) => y.h >= e + m.Rm * risk) : after.some((y) => y.l <= e - m.Rm * risk);
      return { side: k.side, kind: k.kind, name: k.kind === "TRAIL" ? "Trend flip (ATR 20×3)" : k.kind === "PULLBACK" ? "RSI(2) pullback in trend" : `Wyckoff ${WY_NAME[k.kind] || k.kind}`, date: iso(b[k.i].t), bars: n - 1 - k.i, price: e, stop: k.stop, target: e + k.side * m.Rm * risk, Rm: m.Rm, risk: risk / e, p, exp: winAt(p), now: b[n - 1].c, move: k.side * (b[n - 1].c / e - 1), stopped, done: hit };
    }).filter((x) => x.p >= m.threshold && !x.stopped && !x.done).sort((a, c) => c.p - a.p || a.bars - c.bars);
  }
  out.assets[r.sym] = {
    hq: hq[0] || null, hqAll: hq.slice(0, 3),
    best: fresh[0] || null, fresh: fresh.slice(0, 3), last: last ? fmt(last) : null,
    lastClose: b[n - 1].c, lastDay: Math.floor(b[n - 1].t / 86400) * 86400 + 86399,
    trail: { dir: st.dir[n - 1], stop: st.stop[n - 1] }, wyckoff: { phase: wy.phase[n - 1], bias: +wy.bias[n - 1].toFixed(2), hasVol: wy.hasVol },
  };
}
// ---------- live track record: log new high-quality signals at the CURRENT price, then resolve them ----------
if (TRACK && META) {
  let T = { started: new Date().toISOString(), signals: [] }; try { T = JSON.parse(fs.readFileSync(TRACK)); } catch (e) {}
  const now = new Date().toISOString(), seen = new Set(T.signals.map((x) => x.id)), m = META.model;
  const clsMap = {}; Object.entries(S.classes).forEach(([c, l]) => l.forEach((r) => (clsMap[r.sym] = { c, label: r.label || r.sym.replace(/\d{3,}-USD$/, "-USD"), name: r.name })));
  for (const [sym, a] of Object.entries(out.assets)) for (const x of a.hqAll || []) {
    if (x.bars > 1) continue; // only log while the signal is fresh, so the logged entry is close to the signal
    const id = `${sym}|${x.kind}|${x.side}|${x.date}`; if (seen.has(id)) continue;
    const e = a.lastClose, risk = Math.abs(e - x.stop);
    if (!(x.side > 0 ? e > x.stop : e < x.stop) || risk / e > 0.25) continue;
    T.signals.push({ id, sym, label: clsMap[sym].label, cls: clsMap[sym].c, side: x.side, kind: x.kind, name: x.name, sigDate: x.date, logged: now, loggedDay: a.lastDay, entry: e, stop: x.stop, target: e + x.side * m.Rm * risk, Rm: m.Rm, p: x.p, status: "open" });
    seen.add(id);
  }
  for (const s of T.signals.filter((x) => x.status === "open")) {
    const b = bars(s.sym); if (!b) continue;
    const after = b.filter((x) => x.t > s.loggedDay); // judge only on bars after the day it was logged
    const c0 = { stocks: "equity", etfs: "equity", indices: "equity", crypto: "crypto", forex: "forex" }[s.cls] || "equity";
    const risk = Math.abs(s.entry - s.stop), costR = (COST[c0] * s.entry) / risk;
    for (let j = 0; j < after.length; j++) {
      const x = after[j], hitS = s.side > 0 ? x.l <= s.stop : x.h >= s.stop, hitT = s.side > 0 ? x.h >= s.target : x.l <= s.target;
      if (hitS) { Object.assign(s, { status: "loss", exit: s.stop, exitDate: iso(x.t), R: -1 - costR }); break; }
      if (hitT) { Object.assign(s, { status: "win", exit: s.target, exitDate: iso(x.t), R: s.Rm - costR }); break; }
      if (j + 1 >= (m.H || 20)) { const R = (s.side * (x.c - s.entry)) / risk - costR; Object.assign(s, { status: R > 0 ? "win" : "loss", exit: x.c, exitDate: iso(x.t), R, expired: true }); break; }
    }
    if (s.status === "open") { const L = b[b.length - 1]; s.last = L.c; s.openR = (s.side * (L.c - s.entry)) / risk; s.barsHeld = after.length; }
  }
  T.updated = now;
  fs.writeFileSync(TRACK, JSON.stringify(T, null, 1));
  const cl = T.signals.filter((x) => x.status !== "open");
  console.log(`track: ${T.signals.length} logged, ${cl.length} closed, ${cl.filter((x) => x.status === "win").length} wins`);
}
const nb = Object.values(out.assets).filter((x) => x.best).length;
fs.writeFileSync(path.join(DIR, "signals.json"), JSON.stringify(out));
console.log(`signals.json: ${Object.keys(out.assets).length} assets, ${nb} with a fresh tested signal`);
