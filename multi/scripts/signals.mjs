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

const out = { generated: S.generated, tested: { trail: TRAIL, pullback: PB, wyckoff: WYV, date: A ? A.generated : null }, assets: {} };
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
  out.assets[r.sym] = {
    best: fresh[0] || null, fresh: fresh.slice(0, 3), last: last ? fmt(last) : null,
    trail: { dir: st.dir[n - 1], stop: st.stop[n - 1] }, wyckoff: { phase: wy.phase[n - 1], bias: +wy.bias[n - 1].toFixed(2), hasVol: wy.hasVol },
  };
}
const nb = Object.values(out.assets).filter((x) => x.best).length;
fs.writeFileSync(path.join(DIR, "signals.json"), JSON.stringify(out));
console.log(`signals.json: ${Object.keys(out.assets).length} assets, ${nb} with a fresh tested signal`);
