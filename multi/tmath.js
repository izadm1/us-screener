/* Terminal maths — shared by terminal.js (browser) and scripts/accuracy.mjs (walk-forward tests).
   TM holds the tunable settings; values are chosen by the accuracy test (scripts/accuracy.mjs). */
var TM = { nCyc: 3, win: 300, pmin: 8, pmaxCap: 120, sep: 1.3, stN: 10, stM: 3 };
const emaA = (a, n) => { const k = 2 / (n + 1), o = []; let m = null; a.forEach((v, i) => { m = m == null ? v : m + k * (v - m); o.push(i >= n - 1 ? m : null); }); return o; };
const wild = (a, n) => { const o = []; let m = null; a.forEach((v) => { if (v == null) { o.push(null); return; } m = m == null ? v : m + (v - m) / n; o.push(m); }); return o; };
function atrA(b, n = 14) { return wild(b.map((x, i) => (i ? Math.max(x.h - x.l, Math.abs(x.h - b[i - 1].c), Math.abs(x.l - b[i - 1].c)) : null)), n); }
function rsiA(b, n = 14) { const up = [null], dn = [null]; for (let i = 1; i < b.length; i++) { const d = b[i].c - b[i - 1].c; up.push(Math.max(d, 0)); dn.push(Math.max(-d, 0)); } const u = wild(up, n), d = wild(dn, n); return u.map((x, i) => (x == null || d[i] == null ? null : d[i] === 0 ? 100 : 100 - 100 / (1 + x / d[i]))); }
function stA(b, n = TM.stN, m = TM.stM) {
  const a = atrA(b, n), stop = [], dir = []; let fu = NaN, fl = NaN, d = 1;
  b.forEach((x, i) => {
    if (a[i] == null) { stop.push(null); dir.push(1); return; }
    const hl = (x.h + x.l) / 2, ub = hl + m * a[i], lb = hl - m * a[i], pc = i ? b[i - 1].c : x.c;
    fu = Number.isNaN(fu) || ub < fu || pc > fu ? ub : fu; fl = Number.isNaN(fl) || lb > fl || pc < fl ? lb : fl;
    d = d === 1 ? (x.c < fl ? -1 : 1) : x.c > fu ? 1 : -1;
    stop.push(d === 1 ? fl : fu); dir.push(d);
  });
  return { stop, dir };
}
function oscA(b) { // σ filter: z-score of close vs 20-bar mean, lightly smoothed
  const z = b.map((x, i) => { if (i < 19) return null; const w = b.slice(i - 19, i + 1).map((y) => y.c), m = w.reduce((s, v) => s + v, 0) / 20, sd = Math.sqrt(w.reduce((s, v) => s + (v - m) ** 2, 0) / 20); return sd ? (x.c - m) / sd : 0; });
  return emaA(z.map((v) => v ?? 0), 3).map((v, i) => (z[i] == null ? null : v));
}
function cycleFit(vals, pmin = 8, pmax = 64) { // dominant cycle (periodogram) + local sine fit on the latest 3 cycles
  const x = vals.slice(-256), n = x.length;
  pmax = Math.min(pmax, Math.floor(n / 3));
  if (n < 48 || pmax <= pmin) return null;
  const detr = (y) => { const m = y.length, xm = (m - 1) / 2, ym = y.reduce((s, v) => s + v, 0) / m; let sxy = 0, sxx = 0; y.forEach((v, i) => { sxy += (i - xm) * (v - ym); sxx += (i - xm) ** 2; }); const b = sxy / sxx; return y.map((v, i) => v - (ym + b * (i - xm))); };
  const res = detr(x); let best = pmin, bp = 0;
  for (let p = pmin; p <= pmax; p++) { const w = 2 * Math.PI / p; let c = 0, s = 0; res.forEach((v, t) => { c += v * Math.cos(w * t); s += v * Math.sin(w * t); }); const pw = (c * c + s * s) / n; if (pw > bp) { bp = pw; best = p; } }
  const P = best, m = Math.min(n, 3 * P), rl = detr(x.slice(-m)), w = 2 * Math.PI / P;
  let ss = 0, sc = 0, cc = 0, ys = 0, yc = 0;
  rl.forEach((v, t) => { const s = Math.sin(w * t), c = Math.cos(w * t); ss += s * s; sc += s * c; cc += c * c; ys += v * s; yc += v * c; });
  const det = ss * cc - sc * sc || 1e-12, a = (ys * cc - yc * sc) / det, bb = (yc * ss - ys * sc) / det;
  const amp = Math.hypot(a, bb), phi = Math.atan2(bb, a);
  let sse = 0, sst = 0; rl.forEach((v, t) => { const f = a * Math.sin(w * t) + bb * Math.cos(w * t); sse += (v - f) ** 2; sst += v * v; });
  return { P, amp, phase: (w * (m - 1) + phi) % (2 * Math.PI), strength: Math.max(0, 1 - sse / (sst || 1e-12)), m };
}
function solve(A, y) { // small dense least squares via normal equations + Gaussian elimination
  const p = A[0].length, M = Array.from({ length: p }, () => new Array(p + 1).fill(0));
  A.forEach((row, i) => { for (let a = 0; a < p; a++) { M[a][p] += row[a] * y[i]; for (let b = 0; b < p; b++) M[a][b] += row[a] * row[b]; } });
  for (let a = 0; a < p; a++) M[a][a] += 1e-9;
  for (let c = 0; c < p; c++) { let piv = c; for (let r = c + 1; r < p; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r; [M[c], M[piv]] = [M[piv], M[c]]; for (let r = 0; r < p; r++) { if (r === c || !M[c][c]) continue; const f = M[r][c] / M[c][c]; for (let k = c; k <= p; k++) M[r][k] -= f * M[c][k]; } }
  return M.map((r, i) => r[p] / (r[i] || 1e-12));
}
function multiCycle(vals, nCyc = TM.nCyc) { // superposition of the strongest cycles (periodogram peaks), fitted jointly
  const x = vals.slice(-TM.win), n = x.length;
  if (n < 60) return null;
  const xm = (n - 1) / 2, ym = x.reduce((s, v) => s + v, 0) / n; let sxy = 0, sxx = 0; x.forEach((v, i) => { sxy += (i - xm) * (v - ym); sxx += (i - xm) ** 2; });
  const sl = sxy / sxx, res = x.map((v, i) => v - (ym + sl * (i - xm)));
  const pmax = Math.min(TM.pmaxCap, Math.floor(n / 2.5)), pw = [];
  for (let p = TM.pmin; p <= pmax; p++) { const w = 2 * Math.PI / p; let c = 0, s = 0; res.forEach((v, t) => { c += v * Math.cos(w * t); s += v * Math.sin(w * t); }); pw.push({ p, pw: (c * c + s * s) / n }); }
  const peaks = pw.filter((q, i) => (i === 0 || q.pw >= pw[i - 1].pw) && (i === pw.length - 1 || q.pw >= pw[i + 1].pw)).sort((a, b) => b.pw - a.pw);
  const P = [];
  for (const q of peaks) { if (P.every((p) => Math.max(p, q.p) / Math.min(p, q.p) > TM.sep)) P.push(q.p); if (P.length >= nCyc) break; }
  if (!P.length) return null;
  const W = P.map((p) => 2 * Math.PI / p);
  const A = res.map((_, t) => [1, ...W.flatMap((w) => [Math.sin(w * t), Math.cos(w * t)])]);
  const beta = solve(A, res);
  const at = (t) => W.reduce((s, w, i) => s + beta[1 + 2 * i] * Math.sin(w * t) + beta[2 + 2 * i] * Math.cos(w * t), 0);
  let sse = 0, sst = 0; res.forEach((v, t) => { sse += (v - beta[0] - at(t)) ** 2; sst += v * v; });
  const amps = W.map((_, i) => Math.hypot(beta[1 + 2 * i], beta[2 + 2 * i]));
  return { P: P[0], periods: P, amps, strength: Math.max(0, 1 - sse / (sst || 1e-12)), m: n, at: (k) => at(n - 1 + k), fitAt: at, amp: amps[0] };
}
/* Turn reliability: walk-forward replay of the cycle projection on this asset/timeframe's own history.
   A projected high (low) counts as a hit if a major swing high (low) actually formed within ±tol bars.
   Base rate = chance a random bar has such a swing within ±tol — a turn must beat luck to be shown. */
function swings(b, k = 3) { const hi = [], lo = []; for (let i = k; i < b.length - k; i++) { let H = true, L = true; for (let j = i - k; j <= i + k; j++) { if (b[j].h > b[i].h) H = false; if (b[j].l < b[i].l) L = false; } if (H) hi.push(i); if (L) lo.push(i); } return { hi, lo }; }
function levels(b, atr) {
  const t = b.slice(-180), { hi, lo } = swings(t), price = b[b.length - 1].c;
  const pts = hi.map((i) => t[i].h).concat(lo.map((i) => t[i].l)).sort((x, y) => x - y), cl = [];
  pts.forEach((p) => { const c = cl[cl.length - 1]; if (c && Math.abs(p - c.s / c.n) <= 0.6 * atr) { c.s += p; c.n++; } else cl.push({ s: p, n: 1 }); });
  const lv = cl.map((c) => ({ p: c.s / c.n, n: c.n }));
  return { res: lv.filter((v) => v.p > price + 0.1 * atr).sort((a, c) => a.p - c.p).slice(0, 3), sup: lv.filter((v) => v.p < price - 0.1 * atr).sort((a, c) => c.p - a.p).slice(0, 3) };
}
function regChan(b, n = 120) { const y = b.slice(-n).map((x) => Math.log(x.c)), m = y.length, xm = (m - 1) / 2, ym = y.reduce((s, v) => s + v, 0) / m; let sxy = 0, sxx = 0; y.forEach((v, i) => { sxy += (i - xm) * (v - ym); sxx += (i - xm) ** 2; }); const sl = sxy / sxx, ic = ym - sl * xm; const sd = Math.sqrt(y.reduce((s, v, i) => s + (v - (ic + sl * i)) ** 2, 0) / m); return { m, sl, ic, sd }; }
function volTf(b) { const r = []; for (let i = Math.max(1, b.length - 200); i < b.length; i++) r.push(Math.log(b[i].c / b[i - 1].c)); let v = null; r.forEach((x) => { v = v == null ? x * x : v + 0.06 * (x * x - v); }); const m = r.reduce((s, x) => s + x, 0) / r.length, rv = r.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, r.length - 1); return Math.sqrt(0.5 * (v || rv) + 0.5 * rv); }
if (typeof module !== 'undefined') module.exports = { TM, emaA, wild, atrA, rsiA, stA, oscA, solve, multiCycle, swings, levels, regChan, volTf };

/* ---------------- Wyckoff analysis (mechanical approximation, no look-ahead) ----------------
   Trading ranges are classified by the trend before them (accumulation after a decline, distribution
   after an advance). Events: SC/BC climaxes, AR, ST, Spring, UT/UTAD, SOS/SOW breakouts, LPS/LPSY
   retests. Volume is used when the asset has it (stocks, ETFs, crypto); forex uses price/range only.
   Returns per-bar phase and a bias score in [-1, 1] built only from information available at that bar. */
function wyckoff(b, o = {}) {
  const n = b.length, W = o.win || 30, atr = atrA(b, 14);
  const hasVol = b.filter((x) => x.v > 0).length > 0.8 * n;
  const sma = (f, i, k) => { let s = 0, c = 0; for (let j = Math.max(0, i - k + 1); j <= i; j++) { s += f(b[j]); c++; } return c ? s / c : 0; };
  const ev = [], phase = new Array(n).fill("none"), bias = new Array(n).fill(0), rangeAt = new Array(n).fill(null);
  let mode = "trend", lo = 0, hi = 0, rs = 0, ctx = "neutral", lvl = 0, since = 0, sc = null;
  const add = (i, type, side) => { ev.push({ i, type, side }); };
  for (let i = Math.max(W + 60, 80); i < n; i++) {
    const A = atr[i] || (b[i].h - b[i].l) || 1e-9, va = sma((x) => x.v || 0, i - 1, 20), ra = sma((x) => x.h - x.l, i - 1, 20);
    const big = (b[i].h - b[i].l) >= 1.8 * ra, volHi = hasVol ? (b[i].v || 0) >= 2 * va : true, volUp = hasVol ? (b[i].v || 0) >= 1.3 * va : (b[i].h - b[i].l) >= 1.2 * ra, volLo = hasVol ? (b[i].v || 0) < va : true;
    let lo40 = Infinity, hi40 = -Infinity; for (let j = i - 40; j < i; j++) { lo40 = Math.min(lo40, b[j].l); hi40 = Math.max(hi40, b[j].h); }
    // climaxes
    if (big && volHi && b[i].l <= lo40 && b[i].c < b[i - 20].c && b[i].c > (b[i].h + b[i].l) / 2 - 0.25 * (b[i].h - b[i].l)) { add(i, "SC", 1); sc = { i, l: b[i].l, v: b[i].v || 0 }; }
    if (big && volHi && b[i].h >= hi40 && b[i].c > b[i - 20].c && b[i].c < (b[i].h + b[i].l) / 2 + 0.25 * (b[i].h - b[i].l)) add(i, "BC", -1);
    if (sc && i === sc.i + 10) { let k = sc.i + 1; for (let j = sc.i + 1; j <= i; j++) if (b[j].h > b[k].h) k = j; add(k, "AR", 1); }
    if (sc && i > sc.i + 10 && i < sc.i + 60 && Math.abs(b[i].l - sc.l) <= A && b[i].c > sc.l && (!hasVol || (b[i].v || 0) < sc.v) && b[i].l <= b[i - 1].l) { add(i, "ST", 1); sc = null; }
    if (mode === "trend") {
      let l = Infinity, h = -Infinity; for (let j = i - W + 1; j <= i; j++) { l = Math.min(l, b[j].l); h = Math.max(h, b[j].h); }
      if (h - l <= 7 * A && Math.abs(b[i].c - b[i - W + 1].c) <= 2.5 * A) {
        mode = "range"; lo = l; hi = h; rs = i - W + 1;
        const pre = b[rs].c - b[Math.max(0, rs - 60)].c;
        ctx = pre < -3 * A ? "acc" : pre > 3 * A ? "dist" : "neutral";
      }
    } else if (mode === "range") {
      if (b[i].l < lo - 0.1 * A && b[i].l > lo - 1.5 * A && b[i].c >= lo) add(i, "Spring", 1);
      else if (b[i].h > hi + 0.1 * A && b[i].h < hi + 1.5 * A && b[i].c <= hi) add(i, ctx === "dist" ? "UTAD" : "UT", -1);
      if (b[i].c > hi + 0.25 * A) { if (volUp) add(i, "SOS", 1); mode = "markup"; lvl = hi; since = i; }
      else if (b[i].c < lo - 0.25 * A) { if (volUp) add(i, "SOW", -1); mode = "markdown"; lvl = lo; since = i; }
      else if (i - rs > 150) mode = "trend";
    } else if (mode === "markup") {
      const last = ev.length ? ev[ev.length - 1] : null;
      if (b[i].l <= lvl + 1.5 * A && b[i].l >= lvl - A && b[i].c > lvl && b[i].c > b[i].o && volLo && b[i].l < b[i - 1].l && !(last && last.type === "LPS" && i - last.i < 10)) add(i, "LPS", 1);
      if (b[i].c < lvl - A || i - since > 120) mode = "trend";
    } else if (mode === "markdown") {
      const last = ev.length ? ev[ev.length - 1] : null;
      if (b[i].h >= lvl - 1.5 * A && b[i].h <= lvl + A && b[i].c < lvl && b[i].c < b[i].o && volLo && b[i].h > b[i - 1].h && !(last && last.type === "LPSY" && i - last.i < 10)) add(i, "LPSY", -1);
      if (b[i].c > lvl + A || i - since > 120) mode = "trend";
    }
    phase[i] = mode === "range" ? (ctx === "acc" ? "accumulation" : ctx === "dist" ? "distribution" : "range") : mode === "markup" ? "markup" : mode === "markdown" ? "markdown" : "none";
    if (mode === "range") rangeAt[i] = { lo, hi, start: rs, ctx };
    let s = { markup: 0.6, markdown: -0.6, accumulation: 0.2, distribution: -0.2 }[phase[i]] || 0;
    const W8 = { Spring: 0.6, SOS: 0.6, LPS: 0.5, ST: 0.3, SC: 0.2, UTAD: -0.6, UT: -0.5, SOW: -0.6, LPSY: -0.5, BC: -0.2 };
    for (let k = ev.length - 1; k >= 0 && i - ev[k].i <= 15; k--) if (ev[k].type !== "AR" && ev[k].i <= i) s += W8[ev[k].type] || 0;
    bias[i] = Math.max(-1, Math.min(1, s));
  }
  ev.sort((a, c) => a.i - c.i);
  return { events: ev, phase, bias, rangeAt, hasVol };
}
/* ADX (trend strength) and Kaufman efficiency ratio (0 = pure chop, 1 = straight line) */
function adxA(b, n = 14) {
  const pdm = [null], mdm = [null];
  for (let i = 1; i < b.length; i++) { const up = b[i].h - b[i - 1].h, dn = b[i - 1].l - b[i].l; pdm.push(up > dn && up > 0 ? up : 0); mdm.push(dn > up && dn > 0 ? dn : 0); }
  const a = atrA(b, n), sp = wild(pdm, n), sm = wild(mdm, n);
  const dx = sp.map((v, i) => { if (v == null || !a[i]) return null; const p = 100 * v / a[i], m = 100 * sm[i] / a[i]; return p + m ? 100 * Math.abs(p - m) / (p + m) : 0; });
  return wild(dx, n);
}
function erA(b, n = 20) { return b.map((x, i) => { if (i < n) return null; let path = 0; for (let j = i - n + 1; j <= i; j++) path += Math.abs(b[j].c - b[j - 1].c); return path ? Math.abs(x.c - b[i - n].c) / path : 0; }); }
if (typeof module !== 'undefined') module.exports.wyckoff = wyckoff;
if (typeof module !== 'undefined') { module.exports.adxA = adxA; module.exports.erA = erA; }

/* ---------------- Signal-quality model (meta-labelling) — shared by tests, server and terminal ----------------
   metaPrep: indicator arrays for one asset; metaCands: every candidate signal (trend flip, RSI(2) pullback,
   Wyckoff event) with its stop; metaFeat: the feature vector the quality model scores. No look-ahead. */
var META_FEATS = ["side", "isTrail", "isPull", "isWyBull", "isWyBear", "adx", "er", "rsiS", "zS", "e200S", "e50S", "volPct", "regS", "wkS", "wyS", "riskAtr", "volRatio", "mom20S", "isCrypto", "isFx"];
function metaPrep(b, cls, regAt) {
  const n = b.length, c = b.map((x) => x.c);
  const ctx = { b, n, cls, st: stA(b, 20, 3), atr: atrA(b, 14), adx: adxA(b, 14), er: erA(b, 20), rsi: rsiA(b, 14), r2: rsiA(b, 2), e50: emaA(c, 50), e200: emaA(c, 200), wy: wyckoff(b), hasVol: b.filter((x) => x.v > 0).length > 0.8 * n };
  // weekly trail direction of the previous completed week
  const wk = []; b.forEach((x) => { const d = new Date(x.t * 1000), k = Math.floor(x.t / 86400) - ((d.getUTCDay() + 6) % 7), L = wk[wk.length - 1]; if (L && L.k === k) { L.h = Math.max(L.h, x.h); L.l = Math.min(L.l, x.l); L.c = x.c; } else wk.push({ k, o: x.o, h: x.h, l: x.l, c: x.c }); });
  const ws = stA(wk, 10, 3), wi = {}; wk.forEach((w, i) => (wi[w.k] = i));
  ctx.wk = b.map((x) => { const d = new Date(x.t * 1000), i = wi[Math.floor(x.t / 86400) - ((d.getUTCDay() + 6) % 7)]; return i > 0 ? ws.dir[i - 1] : 0; });
  ctx.reg = b.map((x) => (regAt ? regAt(cls, x.t) : 0));
  const atrp = ctx.atr.map((a, i) => (a && c[i] ? a / c[i] : null));
  ctx.volPct = atrp.map((v, i) => { if (v == null || i < 60) return 0.5; let k = 0, m = 0; for (let j = Math.max(0, i - 251); j <= i; j++) if (atrp[j] != null) { m++; if (atrp[j] < v) k++; } return m ? k / m : 0.5; });
  return ctx;
}
function metaCands(ctx, from) {
  const { b, n, st, atr, r2, wy, cls } = ctx, out = [];
  const W8 = { SOS: 1, LPS: 1, SC: 1, ST: 1, Spring: 1, SOW: -1, LPSY: -1, UT: -1, UTAD: -1, BC: -1 };
  for (let i = Math.max(from || 0, 201); i < n; i++) {
    if (st.dir[i] !== st.dir[i - 1] && st.stop[i - 1] != null) out.push({ i, side: st.dir[i], kind: "TRAIL", stop: st.stop[i] });
    const d = st.dir[i];
    if (st.dir[i] === st.dir[i - 1] && r2[i] != null && r2[i - 1] != null && ((d === 1 && r2[i] < 10 && r2[i - 1] >= 10) || (d === -1 && r2[i] > 90 && r2[i - 1] <= 90))) out.push({ i, side: d, kind: "PULLBACK", stop: st.stop[i] });
  }
  wy.events.forEach((e) => { if (e.type === "AR" || e.i < Math.max(from || 0, 201) || !W8[e.type]) return; const lo = Math.min(...b.slice(Math.max(0, e.i - 5), e.i + 1).map((x) => x.l)), hi = Math.max(...b.slice(Math.max(0, e.i - 5), e.i + 1).map((x) => x.h)); out.push({ i: e.i, side: e.side, kind: e.type, stop: e.side > 0 ? lo - 0.25 * atr[e.i] : hi + 0.25 * atr[e.i] }); });
  return out.filter((x) => { const p = b[x.i].c; return x.stop != null && (x.side > 0 ? x.stop < p : x.stop > p) && Math.abs(p - x.stop) / p < 0.25; }).sort((a, c) => a.i - c.i);
}
function metaFeat(ctx, k) {
  const { b, i, side } = { b: ctx.b, i: k.i, side: k.side }, x = b[i], A = ctx.atr[i] || (x.h - x.l) || 1e-9, s = side;
  let va = 0; for (let j = Math.max(0, i - 20); j < i; j++) va += b[j].v || 0; va /= 20;
  let sd = 0; for (let j = Math.max(1, i - 19); j <= i; j++) sd += Math.log(b[j].c / b[j - 1].c) ** 2; sd = Math.sqrt(sd / 20) || 1e-9;
  const m20 = i >= 20 ? Math.log(x.c / b[i - 20].c) / (sd * Math.sqrt(20)) : 0;
  let z = 0; if (i >= 19) { const w = b.slice(i - 19, i + 1).map((y) => y.c), m = w.reduce((a, v) => a + v, 0) / 20, d = Math.sqrt(w.reduce((a, v) => a + (v - m) ** 2, 0) / 20); z = d ? (x.c - m) / d : 0; }
  const cl = (v) => Math.max(-5, Math.min(5, v));
  const bull = ["SOS", "LPS", "SC", "ST", "Spring"].includes(k.kind), bear = ["SOW", "LPSY", "UT", "UTAD", "BC"].includes(k.kind);
  return [s, k.kind === "TRAIL" ? 1 : 0, k.kind === "PULLBACK" ? 1 : 0, bull ? 1 : 0, bear ? 1 : 0,
    (ctx.adx[i] || 0) / 25, ctx.er[i] || 0, ((ctx.rsi[i] || 50) - 50) / 25 * s, cl(z) * s,
    ctx.e200[i] ? cl((x.c - ctx.e200[i]) / A / 5) * s : 0, ctx.e50[i] && ctx.e200[i] ? Math.sign(ctx.e50[i] - ctx.e200[i]) * s : 0,
    ctx.volPct[i], ctx.reg[i] * s, ctx.wk[i] * s, (ctx.wy.bias[i] || 0) * s, cl(Math.abs(x.c - k.stop) / A), ctx.hasVol && va ? cl(Math.log(((x.v || 0) + 1) / (va + 1))) : 0, cl(m20) * s,
    ctx.cls === "crypto" ? 1 : 0, ctx.cls === "forex" ? 1 : 0];
}
function metaProb(m, f) { let z = m.coef[0]; for (let j = 0; j < f.length; j++) z += m.coef[j + 1] * ((f[j] - m.mean[j]) / (m.std[j] || 1)); return 1 / (1 + Math.exp(-z)); }
if (typeof module !== 'undefined') Object.assign(module.exports, { META_FEATS, metaPrep, metaCands, metaFeat, metaProb });
