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
