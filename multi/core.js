/* Shared by the screener (app.js) and the terminal (terminal.js): dates, model forecast, trade plan, formatting. */
/* Multi-Asset Screener front end. Reads data/screener.json built by scripts/build_data.py */
const S = { data: null, cls: "stocks", sort: { key: "ts", dir: -1 }, preset: null, funding: {}, chart: null, rsiChart: null, view: "forecast", fdate: null };
const $ = (id) => document.getElementById(id);

/* ---------------- forecast maths (mirrors scripts/forecast.py) ---------------- */
const DAY = 86400000;
const parseD = (s) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); };
const isoD = (ms) => new Date(ms).toISOString().slice(0, 10);
const niceD = (s) => new Date(parseD(s)).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "2-digit", timeZone: "UTC" });
function barsBetween(asof, target, cal) {
  const a = parseD(asof), b = parseD(target);
  if (b <= a) return 0;
  if (cal) return Math.round((b - a) / DAY);
  let n = 0;
  for (let t = a + DAY; t <= b; t += DAY) { const w = new Date(t).getUTCDay(); if (w && w < 6) n++; }
  return n;
}
function addBars(asof, h, cal) {
  let t = parseD(asof), n = 0;
  while (n < h) { t += DAY; const w = new Date(t).getUTCDay(); if (cal || (w && w < 6)) n++; }
  return t;
}
function Phi(x) { // standard normal CDF
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}
function cycTerm(fc, h) {
  if (!fc.use_cycle || !fc.cycle) return 0;
  const w = 2 * Math.PI / fc.cycle.period, decay = Math.exp(-h / (1.5 * fc.cycle.period));
  return decay * fc.cycle.amp * (Math.sin(fc.cycle.phase + w * h) - Math.sin(fc.cycle.phase));
}
/* Model-based forecast (scripts/model.py): mz = predicted vol-normalised return per horizon,
   q = empirical residual quantiles at GRID_P percentiles. Interpolated in log(h) between horizons. */
const HZ = [1, 5, 21, 63, 126, 252];
const GRID_P = [1, 2.5, 5, 10, 16, 25, 37.5, 50, 62.5, 75, 84, 90, 95, 97.5, 99];
const NORM_Q = [-2.326, -1.96, -1.645, -1.2816, -0.994, -0.674, -0.319, 0, 0.319, 0.674, 0.994, 1.2816, 1.645, 1.96, 2.326];
const grpH = (fc) => ((S.data.model || {})[fc.grp] || {}).h || {};
function interpH(h, get) {
  const hs = HZ.filter((x) => get(x) != null);
  if (!hs.length) return null;
  if (h <= hs[0]) return get(hs[0]);
  if (h >= hs[hs.length - 1]) return get(hs[hs.length - 1]);
  for (let i = 0; i < hs.length - 1; i++) {
    const a = hs[i], b = hs[i + 1];
    if (h >= a && h <= b) {
      const w = (Math.log(h) - Math.log(a)) / (Math.log(b) - Math.log(a)), va = get(a), vb = get(b);
      return Array.isArray(va) ? va.map((v, k) => v + w * (vb[k] - v)) : va + w * (vb - va);
    }
  }
  return get(hs[hs.length - 1]);
}
function qCdf(q, x) { // P(resid <= x) from the quantile grid
  if (x <= q[0]) return GRID_P[0] / 100 * Math.exp(x - q[0]);
  if (x >= q[q.length - 1]) return 1 - (1 - GRID_P[GRID_P.length - 1] / 100) * Math.exp(q[q.length - 1] - x);
  for (let i = 0; i < q.length - 1; i++) if (x <= q[i + 1]) return (GRID_P[i] + (GRID_P[i + 1] - GRID_P[i]) * (x - q[i]) / ((q[i + 1] - q[i]) || 1e-9)) / 100;
  return 1;
}
function model(fc, h) {
  const st = grpH(fc);
  const mz = interpH(h, (x) => (fc.mz && fc.mz[x] != null ? fc.mz[x] : null)) ?? 0;
  const q = interpH(h, (x) => (st[x] ? st[x].q : null)) || NORM_Q;
  return { mz, q, s: (fc.sigma || 0.02) * Math.sqrt(Math.max(h, 1e-9)), cyc: cycTerm(fc, h) };
}
function fcAt(fc, h) {
  if (h <= 0) { const p = fc.p0; return { h: 0, med: p, lo50: p, hi50: p, lo80: p, hi80: p, lo90: p, hi90: p, pup: 0.5, chg: 0, exp: 0 }; }
  const m = model(fc, h);
  const px = (i) => fc.p0 * Math.exp((m.mz + m.q[i]) * m.s + m.cyc);
  const med = px(7);
  return { h, med, lo50: px(5), hi50: px(9), lo80: px(3), hi80: px(11), lo90: px(2), hi90: px(12), lo98: px(0), hi98: px(14),
    pup: 1 - qCdf(m.q, -m.mz - m.cyc / m.s), chg: med / fc.p0 - 1, exp: Math.exp(m.mz * m.s + m.cyc) - 1, s: m.s };
}
function probAbove(fc, h, price) { // chance the closing price on that date is above `price`
  if (h <= 0) return fc.p0 > price ? 1 : 0;
  const m = model(fc, h);
  return 1 - qCdf(m.q, (Math.log(price / fc.p0) - m.cyc) / m.s - m.mz);
}
function modelStats(fc, h) { // nearest validated horizon for this asset group
  const st = grpH(fc); let best = null, d = 1e9;
  HZ.forEach((x) => { if (st[x] && Math.abs(Math.log(h || 1) - Math.log(x)) < d) { d = Math.abs(Math.log(h || 1) - Math.log(x)); best = { h: x, ...st[x] }; } });
  return best;
}
const fcFor = (r) => r.fc ? fcAt(r.fc, barsBetween(r.fc.asof, S.fdate, r.fc.calendar)) : null;
/* ---------------- trade plan: signal, entry, stop, targets ---------------- */
const SIG_COL = { "STRONG BUY": "sb2", BUY: "sb", NEUTRAL: "sn", SELL: "ss", "STRONG SELL": "ss2" };
const PBAR = {};
function groupPup(cls, h) {
  const key = cls + "|" + h + "|" + (S.data && S.data.generated);
  if (PBAR[key] == null) {
    const list = (S.data.classes[cls] || []).filter((x) => x.fc);
    PBAR[key] = list.length ? list.reduce((s, x) => s + fcAt(x.fc, h).pup, 0) / list.length : 0.5;
  }
  return PBAR[key];
}
function tradePlan(r, h) {
  const fc = r.fc;
  if (!fc || !r.price) return null;
  h = Math.max(1, h || 1);
  const f = fcAt(fc, h), ms = r.ms || {}, price = r.price;
  const atr = (r.atr_pct || 0.02) * price;
  const tUp = r.above200 == null ? r.st_dir === 1 : r.above200 && r.st_dir === 1;
  const tDn = r.above200 == null ? r.st_dir === -1 : r.above200 === false && r.st_dir === -1;
  const wk = ms.wk_trend || 0;
  const struct = /HH\/HL/.test(ms.structure || "") ? 1 : /LH\/LL/.test(ms.structure || "") ? -1 : 0;
  // odds term: 60% relative to the asset's own group today (pure skill, market-neutral), 40% absolute
  const pbar = groupPup(r._cls, h);
  const cl1 = (v) => Math.max(-1, Math.min(1, v));
  const prob = 0.6 * cl1((f.pup - pbar) / 0.08) + 0.4 * cl1((f.pup - 0.5) / 0.15);
  const conv = Math.round(100 * (0.5 * prob + 0.25 * (tUp ? 1 : tDn ? -1 : 0) + 0.15 * wk + 0.10 * struct));
  let sig = conv >= 55 ? "STRONG BUY" : conv >= 25 ? "BUY" : conv <= -55 ? "STRONG SELL" : conv <= -25 ? "SELL" : "NEUTRAL";
  if (sig.includes("BUY") && tDn && wk === -1) sig = "NEUTRAL";      // never buy against daily + weekly downtrend
  if (sig.includes("SELL") && tUp && wk === 1) sig = "NEUTRAL";      // never sell against daily + weekly uptrend
  const why = [];
  why.push(`${Math.round(f.pup * 100)}% chance higher by target date (group average ${Math.round(pbar * 100)}%)`);
  why.push(tUp ? "Daily trend up (above 200-day, ATR trail long)" : tDn ? "Daily trend down (below 200-day, ATR trail short)" : "Daily trend mixed");
  why.push(wk === 1 ? "Weekly trend up" : wk === -1 ? "Weekly trend down" : "Weekly trend flat/unclear");
  if (ms.structure) why.push(`Structure: ${ms.structure}${ms.bos ? ` · ${ms.bos} break of structure` : ""}`);
  const plan = { sig, conv, f, h, why, atr };
  const dir = sig.includes("BUY") ? 1 : sig.includes("SELL") ? -1 : 0;
  plan.dir = dir;
  const sup = (ms.sup || []).map((x) => x.price), res = (ms.res || []).map((x) => x.price);
  if (dir === 1) {
    const near = sup.find((p) => p > price - 1.2 * atr);
    plan.entryLo = Math.max(price - 0.5 * atr, near ? near : -Infinity); plan.entryHi = price;
    const cands = [r.st_dir === 1 ? r.st_stop : null, ms.swing_lo20 != null ? ms.swing_lo20 - 0.25 * atr : null, sup[0] != null ? sup[0] - 0.25 * atr : null]
      .filter((x) => x != null && x < price - 1.0 * atr && x > price - 3.5 * atr);
    plan.stop = cands.length ? Math.max(...cands) : price - 2 * atr;
    plan.risk = price - plan.stop;
    let t1 = f.med;
    if (t1 <= price + 0.3 * atr) t1 = res.find((p) => p > price + 0.5 * atr && p <= f.hi80) ?? Math.max(f.hi50, price + 0.5 * atr);
    const t2 = Math.max(f.hi80, t1 + 0.5 * plan.risk), t3 = Math.max(f.hi90, t2 + 0.5 * plan.risk);
    plan.targets = [t1, t2, t3].map((t) => ({ price: t, p: probAbove(fc, h, t) }));
    plan.pStop = 1 - probAbove(fc, h, plan.stop);
    plan.obstacle = res.find((p) => p > price && p < plan.targets[0].price);
  } else if (dir === -1) {
    const near = res.find((p) => p < price + 1.2 * atr);
    plan.entryLo = price; plan.entryHi = Math.min(price + 0.5 * atr, near ? near : Infinity);
    const cands = [r.st_dir === -1 ? r.st_stop : null, ms.swing_hi20 != null ? ms.swing_hi20 + 0.25 * atr : null, res[0] != null ? res[0] + 0.25 * atr : null]
      .filter((x) => x != null && x > price + 1.0 * atr && x < price + 3.5 * atr);
    plan.stop = cands.length ? Math.min(...cands) : price + 2 * atr;
    plan.risk = plan.stop - price;
    let t1 = f.med;
    if (t1 >= price - 0.3 * atr) t1 = sup.find((p) => p < price - 0.5 * atr && p >= f.lo80) ?? Math.min(f.lo50, price - 0.5 * atr);
    const t2 = Math.min(f.lo80, t1 - 0.5 * plan.risk), t3 = Math.min(f.lo90, t2 - 0.5 * plan.risk);
    plan.targets = [t1, t2, t3].map((t) => ({ price: t, p: 1 - probAbove(fc, h, t) }));
    plan.pStop = probAbove(fc, h, plan.stop);
    plan.obstacle = sup.find((p) => p < price && p > plan.targets[0].price);
  }
  if (dir) {
    plan.targets.forEach((t) => (t.R = Math.abs(t.price - price) / plan.risk));
    plan.rr = plan.targets[1].R;
    plan.size = 1 / (plan.risk / price * 100) * 100; // % of account for 1% risk
  } else {
    plan.waitLong = res[0] ?? ms.swing_hi20; plan.waitShort = sup[0] ?? ms.swing_lo20;
  }
  return plan;
}
const planFor = (r) => (r.fc ? tradePlan(r, barsBetween(r.fc.asof, S.fdate, r.fc.calendar)) : null);
const sigChip = (p) => p ? `<span class="sigchip ${SIG_COL[p.sig]}" title="Conviction ${p.conv > 0 ? "+" : ""}${p.conv}">${p.sig}</span>` : '<span class="mute">—</span>';
const nextTurn = (r) => (r.fc && r.fc.turns && r.fc.turns[0]) || null;

const disp = (r) => r.label || r.sym.replace(/\d{3,}-USD$/, "-USD");
const fmt = {
  px: (v) => v == null ? "–" : v >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : v >= 20 ? v.toFixed(2) : v >= 10 ? v.toFixed(3) : v >= 1 ? v.toFixed(4) : v.toPrecision(4),
  pct: (v, d = 1) => v == null ? "–" : (v > 0 ? "+" : "") + (v * 100).toFixed(d) + "%",
  n: (v, d = 1) => v == null ? "–" : Number(v).toFixed(d),
};
const cls = (v) => v == null ? "mute" : v > 0 ? "up" : v < 0 ? "down" : "mute";
const chipColor = { "Cycle trough due": "g", "Cycle peak due": "y", "Strong trend": "g", "Breakout": "b", "Pullback in uptrend": "g", "RSI(2) oversold": "y", "Overextended": "y", "Bullish divergence": "g", "Bearish divergence": "r", "Downtrend": "r", "Distress risk": "r" };


const safe = (s) => s.replace(/[^A-Za-z0-9\-_.]/g, "_");
function planCard(r, plan) {
  if (!plan) return "";
  const px = fmt.px, pc = (v) => fmt.pct(v / r.price - 1, 2);
  const unit = r.fc.calendar ? "days" : "trading days";
  let h = `<div class="plan ${SIG_COL[plan.sig]}">
    <div class="planhead"><div><div class="l">Signal to ${niceD(S.fdate)} (${plan.h} ${unit})</div><div class="big">${plan.sig}</div></div>
    <div class="conv"><div class="l">Conviction</div><div class="cv">${plan.conv > 0 ? "+" : ""}${plan.conv}</div><div class="bar"><i style="left:${50 + plan.conv / 2}%"></i></div></div></div>`;
  if (plan.dir) {
    const side = plan.dir === 1 ? "Buy" : "Sell";
    h += `<div class="pgrid">
      <div><div class="l">${side} zone</div><div class="v">${px(plan.entryLo)} – ${px(plan.entryHi)}</div></div>
      <div><div class="l">Stop loss</div><div class="v down">${px(plan.stop)}</div><div class="s">${pc(plan.stop)} · ${(plan.risk / plan.atr).toFixed(1)} ATR</div></div>
      ${plan.targets.map((t, i) => `<div><div class="l">Target ${i + 1}${i === 0 ? " (first)" : i === 1 ? " (good case)" : " (stretch)"}</div><div class="v up">${px(t.price)}</div><div class="s">${pc(t.price)} · ${t.R.toFixed(1)}R · ${Math.round(t.p * 100)}% chance</div></div>`).join("")}
      <div><div class="l">Reward : risk (T2)</div><div class="v">${plan.rr.toFixed(2)} : 1</div></div>
      <div><div class="l">Size for 1% account risk</div><div class="v">${Math.min(plan.size, 999).toFixed(0)}%</div><div class="s">of account (notional)</div></div>
      <div><div class="l">Chance of closing past stop</div><div class="v">${Math.round(plan.pStop * 100)}%</div><div class="s">by ${niceD(S.fdate)}</div></div>
    </div>`;
    if (plan.obstacle) h += `<p class="note">⚠ ${plan.dir === 1 ? "Resistance" : "Support"} at ${px(plan.obstacle)} sits before Target 1 — expect a reaction there.</p>`;
    if (plan.targets[0].R < 1) h += `<p class="note">⚠ Base-case target is only ${plan.targets[0].R.toFixed(1)}R — better to enter near the ${plan.dir === 1 ? "bottom" : "top"} of the zone, or use a later target date.</p>`;
  } else {
    h += `<p class="note" style="margin:8px 0 0">No trade: the odds and the trend don't line up. Watch for a close above <b>${px(plan.waitLong)}</b> (bullish trigger) or below <b>${px(plan.waitShort)}</b> (bearish trigger).</p>`;
  }
  h += `<ul class="why">${plan.why.map((w) => `<li>${w}</li>`).join("")}</ul></div>`;
  return h;
}
