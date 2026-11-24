// Signal-quality model (meta-labelling), walk-forward.
// Every candidate signal (trend flip, RSI(2) pullback, Wyckoff event) on every asset gets a triple-barrier label:
// +R target hit before the stop within H bars = win; stop first = loss; neither = closed at H. Trading costs included.
// A ridge logistic model learns P(win) from 20 features. The cut-off is chosen on the TRAIN period only (time-blocked
// cross-validation); results are reported on the later TEST period the model never saw.
// Usage: node meta.mjs <daily_data_dir> <out_json>
import fs from "fs";
import path from "path";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const M = require(path.resolve(path.dirname(new URL(import.meta.url).pathname), "../tmath.js"));
const [, , DIR = "/tmp/acc_full", OUT = "meta.json"] = process.argv;
const H = 20, COST = { equity: 0.001, crypto: 0.002, forex: 0.0004 };
const clsOf = (s) => (s.endsWith("-USD") ? "crypto" : s.endsWith("_X") || s === "GC_F" || s === "SI_F" ? "forex" : "equity");

const data = {};
for (const f of fs.readdirSync(DIR).filter((f) => f.endsWith("__1D.json"))) { const b = JSON.parse(fs.readFileSync(path.join(DIR, f))); if (b.length >= 400) data[f.replace("__1D.json", "")] = b; }
const regMap = (b) => { const e = M.emaA(b.map((x) => x.c), 200), m = {}; b.forEach((x, i) => { if (e[i] != null) m[Math.floor(x.t / 86400) + 1] = x.c > e[i] ? 1 : -1; }); return m; };
const REG = { equity: data.SPY ? regMap(data.SPY) : {}, crypto: data["BTC-USD"] ? regMap(data["BTC-USD"]) : {} };
const regAt = (c, t) => { if (c === "forex") return 0; const m = REG[c === "crypto" ? "crypto" : "equity"]; for (let k = 0; k < 6; k++) { const v = m[Math.floor(t / 86400) - k]; if (v) return v; } return 0; };

// ---------- build the labelled sample ----------
const S = [];
for (const [sym, b] of Object.entries(data)) {
  const cls = clsOf(sym), ctx = M.metaPrep(b, cls === "equity" ? "stocks" : cls, regAt);
  for (const k of M.metaCands(ctx, 252)) {
    if (k.i + 1 >= b.length) continue;
    const e = b[k.i].c, risk = Math.abs(e - k.stop), costR = (COST[cls] * e) / risk, row = { sym, cls, kind: k.kind, side: k.side, t: b[k.i].t, f: M.metaFeat(ctx, k), y: {}, r: {} };
    let ok = true;
    for (const Rm of [1, 1.5, 2]) {
      let res = null;
      for (let j = k.i + 1; j <= Math.min(b.length - 1, k.i + H); j++) {
        const x = b[j], hitS = k.side > 0 ? x.l <= k.stop : x.h >= k.stop, hitT = k.side > 0 ? x.h >= e + Rm * risk : x.l <= e - Rm * risk;
        if (hitS) { res = -1; break; }          // stop first (same-bar ties count as a loss: conservative)
        if (hitT) { res = Rm; break; }
        if (j === k.i + H) res = (k.side * (x.c - e)) / risk;
      }
      if (res == null) { ok = false; break; } // not resolved yet (too recent)
      row.r[Rm] = res - costR; row.y[Rm] = row.r[Rm] > 0 ? 1 : 0;
    }
    if (ok) S.push(row);
  }
}
S.sort((a, b) => a.t - b.t);
const cutT = S[Math.floor(S.length * 0.6)].t, TR = S.filter((s) => s.t < cutT), TE = S.filter((s) => s.t >= cutT);
console.log(`samples ${S.length} (train ${TR.length}, test ${TE.length}), assets ${Object.keys(data).length}, split ${new Date(cutT * 1000).toISOString().slice(0, 10)}`);

// ---------- ridge logistic regression (IRLS) ----------
function fit(rows, Rm, lam = 2) {
  const p = rows[0].f.length, mean = new Array(p).fill(0), std = new Array(p).fill(0);
  rows.forEach((r) => r.f.forEach((v, j) => (mean[j] += v / rows.length)));
  rows.forEach((r) => r.f.forEach((v, j) => (std[j] += (v - mean[j]) ** 2 / rows.length)));
  for (let j = 0; j < p; j++) std[j] = Math.sqrt(std[j]) || 1;
  const X = rows.map((r) => [1, ...r.f.map((v, j) => (v - mean[j]) / std[j])]), y = rows.map((r) => r.y[Rm]);
  let beta = new Array(p + 1).fill(0);
  for (let it = 0; it < 25; it++) {
    const A = [], z = [];
    X.forEach((x, i) => { const eta = x.reduce((s, v, j) => s + v * beta[j], 0), pr = 1 / (1 + Math.exp(-eta)), w = Math.max(pr * (1 - pr), 1e-6), sw = Math.sqrt(w); A.push(x.map((v) => v * sw)); z.push(sw * (eta + (y[i] - pr) / w)); });
    for (let j = 1; j <= p; j++) { const row = new Array(p + 1).fill(0); row[j] = Math.sqrt(lam); A.push(row); z.push(0); }
    const nb = M.solve(A, z), d = nb.reduce((s, v, j) => s + Math.abs(v - beta[j]), 0); beta = nb; if (d < 1e-6) break;
  }
  return { coef: beta, mean, std };
}
const prob = (m, r) => M.metaProb(m, r.f);
const stats = (rows, Rm) => { const n = rows.length; if (!n) return { n: 0, win: 0, avgR: 0, pf: 0, sumR: 0 }; let w = 0, gw = 0, gl = 0, s = 0; rows.forEach((r) => { const x = r.r[Rm]; s += x; if (x > 0) { w++; gw += x; } else gl -= x; }); return { n, win: w / n, avgR: s / n, pf: gl ? gw / gl : 0, sumR: s }; };
const GRID = []; for (let t = 0.4; t <= 0.851; t += 0.025) GRID.push(+t.toFixed(3));

// ---------- choose R multiple and cut-off on TRAIN only (time-blocked CV) ----------
const report = { generated: new Date().toISOString(), samples: S.length, assets: Object.keys(data).length, split: new Date(cutT * 1000).toISOString().slice(0, 10), H, costs: COST, byR: {} };
let best = null;
for (const Rm of [1, 1.5, 2]) {
  const K = 4, blk = Math.ceil(TR.length / K), oof = [];
  for (let k = 0; k < K; k++) { const te = TR.slice(k * blk, (k + 1) * blk), tr = TR.filter((_, i) => i < k * blk || i >= (k + 1) * blk); const m = fit(tr, Rm); te.forEach((r) => oof.push({ r, p: prob(m, r) })); }
  const base = stats(TR, Rm), cv = GRID.map((t) => ({ t, ...stats(oof.filter((o) => o.p >= t).map((o) => o.r), Rm) }));
  // accuracy-first: highest win rate that still clearly makes money after costs (avg >= +0.05R) with enough trades
  const okc = cv.filter((c) => c.n >= Math.max(150, 0.03 * TR.length) && c.avgR >= 0.05);
  const pick = okc.sort((a, b) => b.win - a.win || b.avgR - a.avgR)[0] || null;
  const m = fit(TR, Rm), pt = TE.map((r) => ({ r, p: prob(m, r) }));
  const test = GRID.map((t) => ({ t, ...stats(pt.filter((o) => o.p >= t).map((o) => o.r), Rm) }));
  const testAtPick = pick ? test.find((x) => x.t === pick.t) : null;
  const byKind = {}; if (pick) pt.filter((o) => o.p >= pick.t).forEach((o) => ((byKind[o.r.kind] ||= []).push(o.r)));
  report.byR[Rm] = { trainBase: base, testBase: stats(TE, Rm), cv, test, pick: pick && { t: pick.t, cv: pick, test: testAtPick }, testByKind: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, stats(v, Rm)])) };
  console.log(`R=${Rm}: train base win ${base.win.toFixed(3)} avgR ${base.avgR.toFixed(3)} | test base win ${report.byR[Rm].testBase.win.toFixed(3)} avgR ${report.byR[Rm].testBase.avgR.toFixed(3)} | pick t=${pick && pick.t} CV win ${pick && pick.win.toFixed(3)} avgR ${pick && pick.avgR.toFixed(3)} n ${pick && pick.n} | TEST win ${testAtPick && testAtPick.win.toFixed(3)} avgR ${testAtPick && testAtPick.avgR.toFixed(3)} pf ${testAtPick && testAtPick.pf.toFixed(2)} n ${testAtPick && testAtPick.n}`);
  if (pick && (!best || pick.win > best.cvWin)) best = { Rm, t: pick.t, cvAvgR: pick.avgR, cvWin: pick.win };
}
// ---------- production model: refit on all data with the train-chosen R and cut-off ----------
if (best) {
  const m = fit(S, best.Rm), R0 = report.byR[best.Rm];
  report.model = { feats: M.META_FEATS, ...m, Rm: best.Rm, H, threshold: best.t, test: R0.pick.test, testBase: R0.testBase, testByKind: R0.testByKind };
  console.log("MODEL", JSON.stringify({ Rm: best.Rm, t: best.t, test: R0.pick.test }));
}
fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
console.log("written", OUT);
