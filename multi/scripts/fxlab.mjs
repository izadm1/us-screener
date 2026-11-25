// Forex lab: walk-forward test of forex-specific entry methods on 12 pairs + gold.
// Settings are chosen on the OLDER half of the data and judged on the NEWER half (never seen during selection).
// Usage: node fxlab.mjs <dataDir> <out.json>
import fs from "fs";
import path from "path";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const FX = require("../fxmethods.js");

const DIR = process.argv[2] || "/tmp/fx", OUT = process.argv[3] || "multi/data/fxlab.json";
const SYMS = ["EURUSD=X", "USDJPY=X", "GBPUSD=X", "USDCHF=X", "AUDUSD=X", "USDCAD=X", "NZDUSD=X", "EURGBP=X", "EURJPY=X", "GBPJPY=X", "AUDJPY=X", "GC=F"];
const load = (s, tf) => { try { return JSON.parse(fs.readFileSync(path.join(DIR, `${s.replace("=", "_")}__${tf}.json`))).filter((x) => x.o > 0 && x.h >= x.l); } catch (e) { return null; } };
const data = {}; for (const s of SYMS) { const D = load(s, "1D"), H = load(s, "1H"); if (D && D.length > 400) data[s] = { D, H: H && H.length > 500 ? H : null, ctx: FX.dailyCtx(D) }; }
console.log("pairs", Object.keys(data).length, Object.entries(data).map(([s, v]) => `${s}:${v.D.length}/${v.H ? v.H.length : 0}`).join(" "));

const grid = (o) => Object.entries(o).reduce((acc, [k, vs]) => acc.flatMap((a) => vs.map((v) => ({ ...a, [k]: v }))), [{}]);
const METHODS = {
  d_pb: { tf: "1D", grid: grid({ th: [5, 10, 20], k: [1, 1.5, 2], Rm: [1, 1.5, 2], H: [10], adx: [0, 20] }) },
  d_trail: { tf: "1D", grid: grid({ k: [1.5, 2, 3], Rm: [1, 1.5, 2], H: [20] }) },
  d_brk: { tf: "1D", grid: grid({ N: [20, 55], tf: [0, 1], k: [1.5, 2, 3], Rm: [1, 2, 3], H: [40] }) },
  d_mr: { tf: "1D", grid: grid({ z: [2, 2.5], adx: [18, 22], k: [1, 1.5, 2], H: [10, 20] }) },
  d_mom: { tf: "1D", grid: grid({ L: [60, 120], min: [0, 0.5], k: [1, 1.5, 2], Rm: [1, 1.5, 2], H: [20] }) },
  h_pb: { tf: "1H", grid: grid({ th: [5, 10], k: [1, 1.5, 2, 3], Rm: [1, 1.5, 2], H: [12, 24], adx: [0, 20], e200: [0, 1], h0: [7], h1: [16] }) },
  h_lbo: { tf: "1H", grid: grid({ wMax: [0.5, 0.8, 1.2], trend: [0, 1], stopMid: [0, 1], Rm: [1, 1.5, 2], lastH: [10, 12] }) },
  h_ema: { tf: "1H", grid: grid({ k: [1, 1.5, 2], Rm: [1, 1.5, 2], H: [12, 24], adx: [0, 20], h0: [7], h1: [16] }) },
};
// split points: middle of each timeframe's history
const span = (tf) => { const ts = Object.values(data).flatMap((v) => (tf === "1D" ? [v.D[0].t, v.D[v.D.length - 1].t] : v.H ? [v.H[0].t, v.H[v.H.length - 1].t] : [])); return (Math.min(...ts) + Math.max(...ts)) / 2; };
const SPLIT = { "1D": span("1D"), "1H": span("1H") };
const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);

function run(name, p, costMult) {
  const M = METHODS[name], all = [];
  for (const [s, v] of Object.entries(data)) {
    const B = M.tf === "1D" ? v.D : v.H; if (!B) continue;
    const c = M.tf === "1D" ? FX.daily[name](B, p) : FX.hourly[name](B, v.ctx, p);
    FX.simulate(B, c, s, { costMult }).forEach((x) => all.push(x));
  }
  const tr = all.filter((x) => x.t < SPLIT[M.tf]), te = all.filter((x) => x.t >= SPLIT[M.tf]);
  return { all, train: FX.stats(tr), test: FX.stats(te), teTrades: te };
}

const report = { generated: new Date().toISOString(), split: { "1D": iso(SPLIT["1D"]), "1H": iso(SPLIT["1H"]) }, costs: FX.COST, methods: {} };
for (const [name, M] of Object.entries(METHODS)) {
  const minN = 80, rows = [];
  for (const p of M.grid) { const r = run(name, p); rows.push({ p, train: r.train, test: r.test }); }
  const ok = rows.filter((r) => r.train.n >= minN);
  const byExp = ok.slice().sort((a, b) => b.train.avgR - a.train.avgR);
  const byWin = ok.filter((r) => r.train.avgR > 0.05).sort((a, b) => b.train.win - a.train.win);
  const best = byExp[0], top5 = byExp.slice(0, 5);
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
  const out = { tf: M.tf, configs: rows.length, best: best && { p: best.p, train: best.train, test: best.test }, accuracyFirst: byWin[0] && { p: byWin[0].p, train: byWin[0].train, test: byWin[0].test },
    top5TestMedianAvgR: med(top5.map((r) => r.test.avgR || 0)), top5TestMedianWin: med(top5.map((r) => r.test.win || 0)) };
  if (best) {
    const r1 = run(name, best.p), r2 = run(name, best.p, 2);
    out.best.test2xCost = r2.test;
    const per = {}; r1.teTrades.forEach((x) => (per[x.sym] = per[x.sym] || []).push(x));
    out.best.perPair = Object.fromEntries(Object.entries(per).map(([s, t]) => [s, FX.stats(t)]));
    const ys = {}; r1.all.forEach((x) => (ys[iso(x.t).slice(0, 4)] = ys[iso(x.t).slice(0, 4)] || []).push(x));
    out.best.byYear = Object.fromEntries(Object.entries(ys).map(([y, t]) => [y, FX.stats(t)]));
  }
  report.methods[name] = out;
  const f = (s) => (s && s.n ? `n ${s.n} win ${(s.win * 100).toFixed(0)}% avgR ${s.avgR.toFixed(3)} PF ${s.pf.toFixed(2)}` : "–");
  console.log(`${name.padEnd(6)} best ${JSON.stringify(best && best.p)}\n   train ${f(best && best.train)}\n   TEST  ${f(best && best.test)}  (2x cost: ${f(out.best && out.best.test2xCost)})  top5 median test avgR ${out.top5TestMedianAvgR?.toFixed(3)}`);
  if (out.accuracyFirst) console.log(`   acc-first ${JSON.stringify(out.accuracyFirst.p)} TEST ${f(out.accuracyFirst.test)}`);
}
fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
console.log("wrote", OUT);
