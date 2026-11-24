const PRESETS = {
  "Strong buys": { plan: "STRONG BUY" },
  "All buys": { plan: "BUY" },
  "Sells": { plan: "SELL" },
  "Highest P(up)": { sort: "pup" },
  "Biggest est. gain": { sort: "fchg" },
  "Cycle trough due": { sig: "Cycle trough due" },
  "Reliable forecasts (≥60% hit)": { acc: 0.6 },
  "Trend leaders": { minScore: 70, upOnly: true, noExt: true },
  "Pullback buys": { sig: "Pullback in uptrend" },
  "Breakouts": { sig: "Breakout" },
  "RSI(2) dip-buys": { sig: "RSI(2) oversold" },
  "Bullish divergence": { sig: "Bullish divergence" },
  "Quality + trend": { minScore: 60, upOnly: true, quality: true },
  "Avoid list": { sig: "Downtrend" },
};

const COLS = [
  { k: "sym", t: "Symbol", f: (r) => `<span class="sym">${disp(r)}</span><span class="nm">${r.name || ""}${r.group ? " · " + r.group : ""}</span>` },
  { k: "price", t: "Price", f: (r) => fmt.px(r.price) },
  { k: "chg1d", t: "1D", f: (r) => `<span class="${cls(r.chg1d)}">${fmt.pct(r.chg1d)}</span>` },
  { k: "bs", t: "Signal", f: (r) => sigChip(r._p) },
  { k: "fmed", t: "Base case", v: "forecast", f: (r) => r._f ? `<b>${fmt.px(r._f.med)}</b>` : "–" },
  { k: "fchg", t: "Est. Δ", v: "forecast", f: (r) => r._f ? `<span class="${cls(r._f.chg)}">${fmt.pct(r._f.chg)}</span>` : "–" },
  { k: "frng", t: "Likely range (50%)", v: "forecast", sortable: false, f: (r) => r._f ? `<span class="rng">${fmt.px(r._f.lo50)} – ${fmt.px(r._f.hi50)}</span>` : "–" },
  { k: "pup", t: "P(higher)", v: "forecast", f: (r) => r._f ? `<span class="${r._f.pup >= 0.6 ? "up" : r._f.pup <= 0.4 ? "down" : ""}">${(r._f.pup * 100).toFixed(0)}%</span>` : "–" },
  { k: "turn", t: "Next cycle turn", v: "forecast", f: (r) => turnCell(r) },
  { k: "acc", t: "Model hit rate", v: "forecast", f: (r) => accCell(r) },
  { k: "chg5d", v: "tech", t: "5D", f: (r) => `<span class="${cls(r.chg5d)}">${fmt.pct(r.chg5d)}</span>` },
  { k: "chg1m", v: "tech", t: "1M", f: (r) => `<span class="${cls(r.chg1m)}">${fmt.pct(r.chg1m)}</span>` },
  { k: "score", t: "Score", f: (r) => scoreBar(r.score) },
  { k: "st_dir", t: "Trend", f: (r) => trendCell(r) },
  { k: "rsi14", v: "tech", t: "RSI", f: (r) => `<span class="${r.rsi14 > 70 ? "warn" : r.rsi14 < 30 ? "up" : ""}">${fmt.n(r.rsi14, 0)}</span>` },
  { k: "adx", v: "tech", t: "ADX", f: (r) => `<span class="${r.adx > 25 ? "" : "mute"}">${fmt.n(r.adx, 0)}</span>` },
  { k: "z20", v: "tech", t: "σ-zone", f: (r) => `<span class="${Math.abs(r.z20) > 2 ? "warn" : ""}">${fmt.n(r.z20, 2)}</span>` },
  { k: "relvol", v: "tech", t: "Rel Vol", f: (r) => `<span class="${r.relvol > 1.5 ? "up" : "mute"}">${fmt.n(r.relvol, 2)}</span>` },
  { k: "dist52h", v: "tech", t: "vs 52W Hi", f: (r) => `<span class="${r.dist52h > -0.03 ? "up" : "mute"}">${fmt.pct(r.dist52h)}</span>` },
  { k: "fscore", v: "tech", t: "F-Score", only: "stocks", f: (r) => r.fscore == null ? "–" : `<span class="${r.fscore >= 7 ? "up" : r.fscore <= 3 ? "down" : ""}">${r.fscore}/9</span>` },
  { k: "altz", v: "tech", t: "Altman Z", only: "stocks", f: (r) => r.altz == null ? "–" : `<span class="${r.altz < 1.81 ? "down" : r.altz > 2.99 ? "up" : "warn"}">${fmt.n(r.altz, 1)}</span>` },
  { k: "funding", v: "tech", t: "Funding 8h", only: "crypto", f: (r) => fundingCell(r) },
  { k: "signals", t: "Signals", sortable: false, cl: "sigs", f: (r) => `<div class="chips">${(r.signals || []).map((s) => `<span class="chip ${chipColor[s] || ""}">${s}</span>`).join("")}</div>` },
];

function turnCell(r) {
  const t = nextTurn(r);
  if (!t) return '<span class="mute">no clear cycle</span>';
  const st = r.fc.cycle ? r.fc.cycle.strength : 0;
  const c = t.type === "trough" ? "up" : "down";
  return `<span class="${c}">${t.type === "trough" ? "▼ low" : "▲ high"}</span> ${niceD(t.date)} <span class="mute">${st < 0.3 ? "(weak)" : ""}</span>`;
}
function accCell(r) {
  const a = r.fc && r.fc.acc;
  if (!a) return "–";
  return `<span class="acc ${a.dir >= 0.6 ? "up" : a.dir < 0.5 ? "down" : "warn"}" title="Out-of-sample test over the last year: the model's 1-month direction call for this asset was right ${(a.dir * 100).toFixed(0)}% of the time (${a.n} daily calls)">${(a.dir * 100).toFixed(0)}%</span>`;
}
function scoreBar(s) {
  if (s == null) return "–";
  const c = s >= 70 ? "var(--up)" : s >= 50 ? "var(--warn)" : "var(--down)";
  return `<span class="scorebar"><i style="--w:${s}%;--c:${c}"></i>${s.toFixed(0)}</span>`;
}
function trendCell(r) {
  const a = r.st_dir === 1 ? '<span class="up">▲</span>' : '<span class="down">▼</span>';
  const e = r.above200 == null ? '<span class="mute">n/a</span>' : r.above200 ? '<span class="up">>200</span>' : '<span class="down"><200</span>';
  return `${a} ${e}`;
}

/* ---------------- crypto futures (live from Binance, in the browser) ---------------- */
const FUT_MAP = { PEPE: "1000PEPEUSDT", SHIB: "1000SHIBUSDT", RNDR: "RENDERUSDT" };
const futSym = (r) => FUT_MAP[r.name] || `${r.name}USDT`;
function fundingCell(r) {
  const f = S.funding[futSym(r)];
  if (f == null) return '<span class="mute">–</span>';
  return `<span class="${f > 0.0005 ? "warn" : f < 0 ? "up" : ""}">${(f * 100).toFixed(4)}%</span>`;
}
async function loadFunding() {
  try {
    const res = await fetch("https://fapi.binance.com/fapi/v1/premiumIndex");
    if (!res.ok) return;
    const j = await res.json();
    j.forEach((x) => (S.funding[x.symbol] = parseFloat(x.lastFundingRate)));
    if (S.cls === "crypto") render();
  } catch (e) { /* blocked region or offline: column shows – */ }
}

/* ---------------- load + regime ---------------- */
async function load() {
  try {
    const res = await fetch("data/screener.json?" + Date.now());
    S.data = await res.json();
  } catch (e) {
    $("screen").innerHTML = `<div class="err">Could not load <code>data/screener.json</code>. Run the "Update screener data" GitHub Action (or <code>python scripts/build_data.py</code>) first.</div>`;
    return;
  }
  Object.entries(S.data.classes).forEach(([c, list]) => list.forEach((x) => (x._cls = c)));
  const g = new Date(S.data.generated);
  $("updated").textContent = "data as of " + g.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  renderRegime();
  buildControls();
  initForecastControls();
  render();
  loadFunding();
}

function badge(state) {
  const c = state === "Risk-on" ? "b-on" : state === "Risk-off" ? "b-off" : "b-neu";
  return `<span class="badge ${c}">${state}</span>`;
}
function renderRegime() {
  const { macro = {}, regime = {}, crypto_sentiment: cs = {} } = S.data;
  let h = "";
  if (regime.equity) h += `<div class="rcard big"><div class="l">Equity regime</div><div class="v">${badge(regime.equity[0])}</div><div class="c mute" style="font-family:var(--sans);white-space:normal">${regime.equity[1]}</div></div>`;
  if (regime.crypto) h += `<div class="rcard big"><div class="l">Crypto regime</div><div class="v">${badge(regime.crypto[0])}</div><div class="c mute" style="font-family:var(--sans);white-space:normal">${regime.crypto[1]}</div></div>`;
  for (const [, m] of Object.entries(macro)) {
    h += `<div class="rcard"><div class="l">${m.label}</div><div class="v">${fmt.px(m.price)}</div><div class="c ${cls(m.chg1d)}">${fmt.pct(m.chg1d, 2)} <span class="mute">1D</span></div></div>`;
  }
  if (cs.fear_greed) {
    const v = cs.fear_greed.value;
    h += `<div class="rcard"><div class="l">Crypto Fear &amp; Greed</div><div class="v ${v < 25 ? "down" : v > 75 ? "up" : ""}">${v}</div><div class="c mute">${cs.fear_greed.label}</div></div>`;
  }
  if (cs.btc_dominance != null) h += `<div class="rcard"><div class="l">BTC dominance</div><div class="v">${cs.btc_dominance.toFixed(1)}%</div><div class="c ${cls(cs.mcap_chg24h)}">${cs.mcap_chg24h != null ? "mkt cap " + cs.mcap_chg24h.toFixed(2) + "%" : ""}</div></div>`;
  $("regime").innerHTML = h;
}

/* ---------------- controls ---------------- */
function buildControls() {
  $("presets").innerHTML = Object.keys(PRESETS).map((p) => `<button data-p="${p}">${p}</button>`).join("") + `<button data-p="">Reset</button>`;
  $("presets").onclick = (e) => {
    const p = e.target.dataset.p;
    if (p === undefined) return;
    resetFilters();
    S.preset = p || null;
    if (p) {
      const cfg = PRESETS[p];
      if (cfg.minScore) { $("minScore").value = cfg.minScore; }
      if (cfg.upOnly) $("upOnly").checked = true;
      if (cfg.noExt) $("noExt").checked = true;
      if (cfg.sig) $("sig").value = cfg.sig;
      if (cfg.sort) { S.sort = { key: cfg.sort, dir: -1 }; setView("forecast"); }
      if (cfg.acc) setView("forecast");
      if (cfg.plan) { setView("forecast"); S.sort = { key: "bs", dir: cfg.plan === "SELL" ? 1 : -1 }; }
    }
    [...$("presets").children].forEach((b) => b.classList.toggle("on", b.dataset.p === p && p !== ""));
    render();
  };
  const sigs = Object.keys(chipColor);
  $("sig").innerHTML = `<option value="">Any signal</option>` + sigs.map((s) => `<option>${s}</option>`).join("");
  ["q", "minScore", "rsiMin", "rsiMax", "sig", "upOnly", "noExt"].forEach((id) => $(id).addEventListener("input", render));
}
function setView(v) {
  S.view = v;
  [...$("view").children].forEach((b) => b.classList.toggle("on", b.dataset.v === v));
}
function setDate(iso) {
  S.fdate = iso;
  $("fdate").value = iso;
  render();
  if (!$("drawer").hidden && S.openSym) openDetail(S.openSym, true);
  if (S.view === "tech" && TV.sym) drawTV(TV.sym);
}
function initForecastControls() {
  const today = new Date();
  const todayIso = isoD(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  $("fdate").min = isoD(parseD(todayIso) + DAY);
  $("fdate").max = isoD(parseD(todayIso) + 366 * DAY);
  S.fdate = isoD(parseD(todayIso) + 30 * DAY);
  $("fdate").value = S.fdate;
  $("fdate").addEventListener("change", () => $("fdate").value && setDate($("fdate").value));
  $("quick").onclick = (e) => { const d = e.target.dataset.d; if (d) setDate(isoD(parseD(todayIso) + d * DAY)); };
  $("view").onclick = (e) => { const v = e.target.dataset.v; if (!v) return; setView(v); if (v === "tech" && ["fchg", "fmed", "pup", "acc", "turn"].includes(S.sort.key)) S.sort = { key: "score", dir: -1 }; render(); syncTV(); };
}
function resetFilters() {
  $("q").value = ""; $("minScore").value = 0; $("rsiMin").value = 0; $("rsiMax").value = 100;
  $("sig").value = ""; $("upOnly").checked = false; $("noExt").checked = false; S.preset = null;
}

/* ---------------- table ---------------- */
function rows() {
  let r = (S.data.classes[S.cls] || []).slice();
  r.forEach((x) => { x._f = fcFor(x); x._p = planFor(x); });
  const q = $("q").value.trim().toLowerCase();
  const min = +$("minScore").value, rmin = +$("rsiMin").value, rmax = +$("rsiMax").value, sig = $("sig").value;
  $("minScoreV").textContent = min;
  r = r.filter((x) =>
    (!q || x.sym.toLowerCase().includes(q) || (x.name || "").toLowerCase().includes(q)) &&
    (x.score ?? 0) >= min &&
    (x.rsi14 == null || (x.rsi14 >= rmin && x.rsi14 <= rmax)) &&
    (!sig || (x.signals || []).includes(sig)) &&
    (!$("upOnly").checked || x.above200 === true) &&
    (!$("noExt").checked || !(x.signals || []).includes("Overextended")) &&
    (!(S.preset && PRESETS[S.preset].quality) || (x.fscore ?? 0) >= 6) &&
    (!(S.preset && PRESETS[S.preset].acc) || ((x.fc && x.fc.acc && x.fc.acc.dir) || 0) >= PRESETS[S.preset].acc) &&
    (!(S.preset && PRESETS[S.preset].plan) || (x._p && (PRESETS[S.preset].plan === "STRONG BUY" ? x._p.sig === "STRONG BUY" : x._p.sig.includes(PRESETS[S.preset].plan)))));
  const { key, dir } = S.sort;
  const val = (x) => {
    switch (key) {
      case "funding": return S.funding[futSym(x)];
      case "bs": return x._p ? x._p.conv : null;
      case "fmed": case "fchg": return x._f ? x._f.chg : null;
      case "pup": return x._f ? x._f.pup : null;
      case "acc": return x.fc && x.fc.acc ? x.fc.acc.dir : null;
      case "turn": { const t = nextTurn(x); return t ? -t.bars : null; }
      default: return x[key];
    }
  };
  r.sort((a, b) => {
    const va = val(a), vb = val(b);
    if (va == null) return 1; if (vb == null) return -1;
    return (typeof va === "string" ? va.localeCompare(vb) : va - vb) * dir;
  });
  return r;
}
function render() {
  if (!S.data) return;
  const cols = COLS.filter((c) => (!c.only || [].concat(c.only).includes(S.cls)) && (!c.v || c.v === S.view));
  $("tbl").querySelector("thead").innerHTML = "<tr>" + cols.map((c) => `<th data-k="${c.k}" class="${S.sort.key === c.k ? "sorted" : ""}">${c.t}${S.sort.key === c.k ? (S.sort.dir < 0 ? " ↓" : " ↑") : ""}</th>`).join("") + "</tr>";
  const list = rows();
  $("tbl").querySelector("tbody").innerHTML = list.map((r) => `<tr data-s="${r.sym}">` + cols.map((c) => `<td class="${c.cl || ""}">${c.f(r)}</td>`).join("") + "</tr>").join("");
  if (S.view === "tech" && TV.sym) document.querySelectorAll("#tbl tbody tr").forEach((tr) => tr.classList.toggle("sel", tr.dataset.s === TV.sym));
  $("count").textContent = `${list.length} of ${(S.data.classes[S.cls] || []).length}`;
}
$("tbl").addEventListener("click", (e) => {
  const th = e.target.closest("th");
  if (th) {
    const c = COLS.find((x) => x.k === th.dataset.k);
    if (c && c.sortable === false) return;
    S.sort = S.sort.key === th.dataset.k ? { key: th.dataset.k, dir: -S.sort.dir } : { key: th.dataset.k, dir: th.dataset.k === "sym" ? 1 : -1 };
    render(); return;
  }
  const tr = e.target.closest("tr[data-s]");
  if (!tr) return;
  if (S.view === "tech") { drawTV(tr.dataset.s); $("tv").scrollIntoView({ behavior: "smooth", block: "start" }); }
  else openDetail(tr.dataset.s);
});

/* ---------------- tabs ---------------- */
$("tabs").onclick = (e) => {
  const b = e.target.closest("button"); if (!b) return;
  [...$("tabs").children].forEach((x) => x.classList.toggle("on", x === b));
  S.cls = b.dataset.cls;
  const m = S.cls === "method", pk = S.cls === "picks";
  $("screen").hidden = m || pk; $("method").hidden = !m; $("picks").hidden = !pk;
  $("regime").hidden = m;
  if (m) { $("method").innerHTML = METHOD; return; }
  if (pk) { renderPicks(); return; }
  render();
  syncTV();
};

function findRow(sym) {
  const here = (S.data.classes[S.cls] || []).find((x) => x.sym === sym);
  if (here) return here;
  for (const list of Object.values(S.data.classes)) { const x = list.find((y) => y.sym === sym); if (x) return x; }
  return null;
}

/* ---------------- top picks ---------------- */
const LEVERAGED = new Set(["TQQQ", "SQQQ", "SOXL", "SOXS", "UVXY"]);
const HORIZONS = [
  { id: "d", t: "Daily", sub: "next trading day", h: 1, w: { timing: .30, trend: .25, volume: .15, pup: .15, acc: .15 }, noExt: true },
  { id: "w", t: "Weekly", sub: "next 5 trading days", h: 5, w: { timing: .25, trend: .25, momentum: .15, pup: .15, acc: .10, cycle: .10 }, noExt: true },
  { id: "m", t: "Monthly", sub: "next ~1 month", h: 21, w: { score: .30, momentum: .20, pup: .20, acc: .15, relstr: .15 }, longOnly: true },
  { id: "q", t: "3 Months", sub: "next ~3 months", h: 63, w: { momentum: .35, trend: .25, relstr: .20, qual: .20 }, longOnly: true },
  { id: "h", t: "6 Months", sub: "next ~6 months", h: 126, w: { momentum: .35, trend: .25, relstr: .15, qual: .25 }, longOnly: true },
  { id: "y", t: "12 Months", sub: "next ~12 months", h: 252, w: { momentum: .30, trend: .25, relstr: .15, qual: .30 }, longOnly: true },
];
const PK = { universe: "tradeable", bsCls: "forex", bsH: "w" };
function pickComponents(r, H) {
  const b = r.buckets || {}, fc = r.fc;
  const steps = fc ? (fc.calendar ? Math.round(H.h * 365 / 252) : H.h) : H.h;
  const f = fc ? fcAt(fc, steps) : null;
  const t = nextTurn(r);
  const cyc = fc && fc.cycle && fc.cycle.strength >= 0.3 && t ? (t.type === "trough" && t.bars <= Math.max(3, H.h) ? 100 : t.type === "peak" && t.bars <= Math.max(3, H.h) ? 0 : 50) : 50;
  return {
    f, steps,
    c: {
      timing: b.timing, trend: b.trend, volume: b.volume, momentum: b.momentum, relstr: b.relstr,
      score: r.score, qual: b.quality ?? r.score,
      pup: f ? Math.max(0, Math.min(100, (f.pup - 0.5) * 400 + 50)) : null,
      acc: fc && fc.acc ? Math.max(0, Math.min(100, (fc.acc.dir - 0.5) * 500 + 50)) : null,
      cycle: cyc,
    },
  };
}
function reasons(r, H, pc) {
  const out = [], b = r.buckets || {};
  if (H.h <= 5 && (r.signals || []).includes("Pullback in uptrend")) out.push("Pullback in uptrend");
  if (H.h <= 5 && (r.signals || []).includes("RSI(2) oversold")) out.push("Short-term oversold");
  if (H.h <= 5 && (r.signals || []).includes("Breakout")) out.push("Breakout on volume");
  if (pc.c.cycle === 100) out.push("Cycle low due");
  if ((b.trend ?? 0) >= 85) out.push("Strong uptrend");
  if ((b.momentum ?? 0) >= 80) out.push("Top momentum");
  if ((b.relstr ?? 0) >= 80) out.push("Beating benchmark");
  if (r.fscore != null && r.fscore >= 7 && H.h >= 21) out.push(`F-score ${r.fscore}/9`);
  if (r.fc && r.fc.acc && r.fc.acc.dir >= 0.6) out.push(`${Math.round(r.fc.acc.dir * 100)}% past hit rate`);
  if (pc.f && pc.f.pup >= 0.6) out.push(`${Math.round(pc.f.pup * 100)}% chance higher`);
  return out.slice(0, 3);
}
const clamp = (v) => Math.max(0, Math.min(100, v));
function sellTiming(r) { // sell rallies inside downtrends; avoid shorting washed-out moves
  let tm = 50;
  if (r.z20 >= -0.5 && r.z20 <= 2) tm += 20;
  if (r.rsi14 >= 35 && r.rsi14 <= 60) tm += 15;
  if (r.rsi2 > 90) tm += 15;
  if (r.rsi14 < 25 || r.z20 < -2.2) tm = 15;
  return Math.min(tm, 100);
}
function sellComponents(r, H) {
  const pc = pickComponents(r, H), b = r.buckets || {};
  const inv = (v) => (v == null ? null : 100 - v);
  const t = nextTurn(r), near = t && t.bars <= Math.max(3, H.h) && r.fc.cycle && r.fc.cycle.strength >= 0.3;
  return { f: pc.f, steps: pc.steps, c: {
    timing: sellTiming(r), trend: inv(b.trend), volume: inv(b.volume), momentum: inv(b.momentum), relstr: inv(b.relstr),
    score: inv(r.score), qual: inv(b.quality ?? r.score), pup: pc.f ? clamp((0.5 - pc.f.pup) * 400 + 50) : null,
    acc: pc.c.acc, cycle: near ? (t.type === "peak" ? 100 : 0) : 50 } };
}
function rankSide(r, H, side) {
  const sig = r.signals || [];
  if (r.sym === "^VIX") return null;
  if (side === "buy") {
    if (sig.includes("Downtrend") || sig.includes("Distress risk")) return null;
    if (H.noExt && sig.includes("Overextended")) return null;
    if (H.longOnly && LEVERAGED.has(r.sym)) return null;
    if (!(r.above200 || (r.above200 == null && r.st_dir === 1))) return null;
  } else {
    if (!(r.above200 === false || (r.above200 == null && r.st_dir === -1))) return null;
    if (H.noExt && (r.rsi14 < 25 || r.z20 < -2.2)) return null;
  }
  const pc = side === "buy" ? pickComponents(r, H) : sellComponents(r, H);
  let num = 0, den = 0;
  for (const [k, w] of Object.entries(H.w)) { const v = pc.c[k]; if (v != null && !Number.isNaN(v)) { num += w * v; den += w; } }
  return den ? { r, pc, ps: num / den, side } : null;
}
function sidePicks(classes, H, side, n = 5) {
  const out = [];
  classes.forEach((c) => (S.data.classes[c] || []).forEach((r) => { const x = rankSide(r, H, side); if (x) out.push(x); }));
  return out.sort((a, b) => b.ps - a.ps).slice(0, n);
}
function topPicks(H) {
  const classes = PK.universe === "tradeable" ? ["stocks", "etfs", "crypto"] : PK.universe === "all" ? ["stocks", "etfs", "crypto", "forex"] : [PK.universe];
  return sidePicks(classes, H, "buy");
}
function signalOf(r) { // weekly-horizon buy/sell call used in the Forex & Crypto tables
  const H = HORIZONS[1], b = rankSide(r, H, "buy"), s = rankSide(r, H, "sell");
  if (b && b.ps >= 65 && (!s || b.ps >= s.ps)) return { side: "BUY", ps: b.ps };
  if (s && s.ps >= 65) return { side: "SELL", ps: s.ps };
  return null;
}
function sellReasons(r, H, pc) {
  const out = [], b = r.buckets || {};
  if (H.h <= 5 && pc.c.timing >= 80) out.push("Rally into downtrend");
  if (r.rsi2 > 90 && H.h <= 5) out.push("Short-term overbought");
  if (pc.c.cycle === 100) out.push("Cycle high due");
  if ((b.trend ?? 100) <= 20) out.push("Strong downtrend");
  if ((b.momentum ?? 100) <= 25) out.push("Weak momentum");
  if ((r.signals || []).includes("Bearish divergence")) out.push("Bearish divergence");
  if (r.fc && r.fc.acc && r.fc.acc.dir >= 0.6) out.push(`${Math.round(r.fc.acc.dir * 100)}% past hit rate`);
  if (pc.f && pc.f.pup <= 0.4) out.push(`${Math.round((1 - pc.f.pup) * 100)}% chance lower`);
  return out.slice(0, 3);
}
function pickRow(p, i, H) {
  const r = p.r, f = p.pc.f, fc = r.fc, sell = p.side === "sell";
  const clsLabel = { stocks: "Stock", etfs: "ETF", crypto: "Crypto", indices: "Index", forex: "Forex" };
  const tgt = fc ? niceD(isoD(addBars(fc.asof, p.pc.steps, fc.calendar))) : "";
  const rs = sell ? sellReasons(r, H, p.pc) : reasons(r, H, p.pc);
  return `<div class="pk" data-s="${r.sym}">
    <div class="pkrank ${sell ? "rs" : "rb"}">${i + 1}</div>
    <div class="pkmain">
      <div class="pkline"><span class="sym">${disp(r)}</span><span class="chip">${clsLabel[r._cls]}</span><span class="pkname">${r.name || ""}</span></div>
      <div class="pkline mono"><span>${fmt.px(r.price)}</span>${f ? `<span class="mute">→ ${tgt}</span><b>${fmt.px(f.med)}</b><span class="${cls(f.chg)}">${fmt.pct(f.chg, 2)}</span><span class="mute">80%: ${fmt.px(f.lo80)}–${fmt.px(f.hi80)}</span>` : ""}</div>
      ${sell && r.st_stop ? `<div class="pkline mono mute">stop above ${fmt.px(r.st_stop)} (ATR trail)</div>` : !sell && r.st_stop && r.st_dir === 1 ? `<div class="pkline mono mute">stop below ${fmt.px(r.st_stop)} (ATR trail)</div>` : ""}
      <div class="chips">${rs.map((x) => `<span class="chip ${sell ? "r" : "g"}">${x}</span>`).join("")}</div>
    </div>
    <div class="pkscore"><div class="v ${sell ? "down" : "up"}">${p.ps.toFixed(0)}</div><div class="l">${sell ? "sell" : "buy"} score</div></div>
  </div>`;
}
function renderBuySell() {
  const H = HORIZONS.find((x) => x.id === PK.bsH);
  const classes = [PK.bsCls];
  const buys = sidePicks(classes, H, "buy"), sells = sidePicks(classes, H, "sell");
  const col = (list, side) => `<section class="pkcard ${side}"><div class="pkt"><h3>${side === "buy" ? "▲ Top 5 BUY" : "▼ Top 5 SELL"}</h3><span>${H.t.toLowerCase()} · ${H.sub}</span></div>${list.length ? list.map((p, i) => pickRow(p, i, H)).join("") : `<p class="note">No ${PK.bsCls} currently qualifies as a ${side} for this horizon (${side === "buy" ? "needs an uptrend" : "needs a downtrend"}).</p>`}</section>`;
  return `<section class="bs"><div class="bshead"><div><h2>${PK.bsCls === "forex" ? "Forex" : "Crypto"} — best Buy &amp; Sell signals</h2>
    <p class="note">Buys come only from uptrends, sells only from downtrends. ${PK.bsCls === "forex" ? "BUY = buy the first currency (e.g. EUR/USD buy = long euro); SELL = sell the first currency." : "SELL means a short position (futures/margin) or exiting a holding."} Use the ATR stop shown on each pick to define risk.</p></div>
    <div class="bsctl"><div class="view" id="bsCls"><button data-c="forex" class="${PK.bsCls === "forex" ? "on" : ""}">Forex</button><button data-c="crypto" class="${PK.bsCls === "crypto" ? "on" : ""}">Crypto</button></div>
    <div class="view" id="bsH">${HORIZONS.map((x) => `<button data-h="${x.id}" class="${x.id === PK.bsH ? "on" : ""}">${x.t}</button>`).join("")}</div></div></div>
    <div class="bsgrid">${col(buys, "buy")}${col(sells, "sell")}</div></section>`;
}
function renderPicks() {
  const reg = S.data.regime || {};
  const eq = reg.equity ? reg.equity[0] : null, cr = reg.crypto ? reg.crypto[0] : null;
  let warn = "";
  if (eq === "Risk-off" || cr === "Risk-off") warn = `<div class="pkwarn">⚠ Market backdrop: equities <b>${eq || "–"}</b>, crypto <b>${cr || "–"}</b>. In risk-off conditions even the best-ranked longs fail more often — consider smaller size or waiting.</div>`;
  let h = `<div class="pkhead"><div><h2>Top Picks</h2><p class="note">Ranked from today's data (${new Date(S.data.generated).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}). Only assets in an uptrend, not in distress; short horizons also skip overextended moves. Click any pick for its chart and forecast.</p></div>
    <label class="pkuni">Universe <select id="pkUni">${[["tradeable", "Stocks + ETFs + Crypto"], ["all", "Everything incl. Forex"], ["stocks", "Stocks"], ["etfs", "ETFs"], ["crypto", "Crypto"], ["forex", "Forex"], ["indices", "Indices"]].map(([v, l]) => `<option value="${v}" ${PK.universe === v ? "selected" : ""}>${l}</option>`).join("")}</select></label></div>${warn}${renderBuySell()}<h2 class="pksec">Top 5 buys by holding period</h2><div class="pkgrid">`;
  HORIZONS.forEach((H) => {
    const picks = topPicks(H);
    h += `<section class="pkcard"><div class="pkt"><h3>${H.t}</h3><span>${H.sub}</span></div>`;
    if (!picks.length) h += `<p class="note">No asset currently passes the filters for this horizon.</p>`;
    picks.forEach((p, i) => { h += pickRow(p, i, H); });
    h += `</section>`;
  });
  h += `</div><p class="note">${PK.universe === "forex" || PK.universe === "all" ? "Forex picks are <b>buy the first currency</b> of the pair (e.g. EUR/USD = buy euro, sell dollar). " : ""}How each list is ranked: <b>Daily/Weekly</b> favour entry timing (pullbacks in uptrends, oversold RSI(2)), trend, volume, short-range forecast odds and the asset's past forecast hit rate; Weekly also rewards a strong cycle low that is due. <b>Monthly</b> blends the composite score, momentum, forecast odds, hit rate and relative strength. <b>3/6/12 months</b> lean on medium-term momentum, trend, relative strength and (for stocks) Piotroski/Altman quality; leveraged/inverse ETFs are excluded from Monthly and longer lists because they decay over long holds. These are rankings, not guarantees — the further out, the wider the range.</p>`;
  $("picks").innerHTML = h;
  $("pkUni").onchange = (e) => { PK.universe = e.target.value; renderPicks(); };
  $("bsCls").onclick = (e) => { const c = e.target.dataset.c; if (c) { PK.bsCls = c; renderPicks(); } };
  $("bsH").onclick = (e) => { const x = e.target.dataset.h; if (x) { PK.bsH = x; renderPicks(); } };
  $("picks").querySelectorAll(".pk").forEach((el) => (el.onclick = () => openDetail(el.dataset.s)));
}

/* ---------------- detail drawer ---------------- */
async function openDetail(sym, keepScroll) {
  const r = findRow(sym);
  if (!r) return;
  S.openSym = sym;
  $("drawer").hidden = false;
  const b = r.buckets || {};
  const bk = (k, l) => b[k] == null ? "" : `<div class="bk"><div class="l">${l}</div><div class="v ${b[k] >= 70 ? "up" : b[k] < 40 ? "down" : ""}">${b[k]}</div></div>`;
  $("dHead").innerHTML = `<div class="dh"><h2>${disp(r)} <span class="px">${fmt.px(r.price)}</span> <span class="${cls(r.chg1d)}" style="font:500 15px var(--mono)">${fmt.pct(r.chg1d, 2)}</span></h2>
    <p>${r.name || ""}${r.sector ? " · " + r.sector : ""} · bar date ${r.date}</p>
    <div class="chips">${(r.signals || []).map((s) => `<span class="chip ${chipColor[s] || ""}">${s}</span>`).join("")}</div>
    <a class="termbtn" href="terminal.html?s=${encodeURIComponent(r.sym)}&tf=1D">▶ Open in Terminal</a>
    <div class="buckets"><div class="bk"><div class="l">Composite</div><div class="v">${r.score == null ? "–" : r.score.toFixed(0)}</div></div>
    ${bk("trend", "Trend")}${bk("momentum", "Momentum")}${bk("relstr", "Rel. strength")}${bk("volume", "Volume")}${bk("timing", "Entry timing")}${bk("quality", "Quality")}</div>
    <div class="legend"><span style="--c:#f2b33d">EMA 20</span><span style="--c:#5b8cff">EMA 50</span><span style="--c:#9b7bff">EMA 200</span><span style="--c:#22c38e">ATR trail (up)</span><span style="--c:#f0565b">ATR trail (down)</span><span style="--c:#e6e9ef">Forecast median</span><span style="--c:#5b8cff">80% range</span></div></div>`;
  const kv = (k, v) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`;
  let body = forecastSection(r) + `<h3>Indicators</h3><div class="grid2">
    ${kv("RSI (14)", fmt.n(r.rsi14))}${kv("RSI (2)", fmt.n(r.rsi2))}
    ${kv("MACD histogram", fmt.n(r.macd_hist, 3) + (r.macd_rising ? " ↑" : " ↓"))}${kv("ADX / +DI / −DI", `${fmt.n(r.adx, 0)} / ${fmt.n(r.pdi, 0)} / ${fmt.n(r.mdi, 0)}`)}
    ${kv("Bollinger %B", fmt.n(r.pct_b, 2))}${kv("σ-zone (z vs 20MA)", fmt.n(r.z20, 2))}
    ${kv("ATR % of price", fmt.pct(r.atr_pct, 2))}${kv("ATR trail stop", fmt.px(r.st_stop) + (r.st_dir === 1 ? " (long)" : " (short)"))}
    ${kv("Relative volume", fmt.n(r.relvol, 2))}${kv("OBV slope (20d)", fmt.n(r.obv_slope, 2))}
    ${kv("3-month return", fmt.pct(r.ret63))}${kv("12-1 month momentum", fmt.pct(r.mom12_1))}
    ${kv("Distance to 52W high", fmt.pct(r.dist52h))}${kv("RSI divergence", r.div || "none")}
    </div>`;
  if (r._cls === "stocks") body += `<h3>Fundamentals</h3><div class="grid2">${kv("Piotroski F-score", r.fscore == null ? "–" : r.fscore + " / 9")}${kv("Altman Z-score", r.altz == null ? "–" : fmt.n(r.altz, 2) + (r.sector === "Financial Services" ? " (n/a for financials)" : ""))}</div>`;
  if (r.st_stop && r.atr_pct) {
    const risk = r.st_dir === 1 ? (r.price - r.st_stop) / r.price : null;
    if (risk) body += `<h3>Risk framing</h3><div class="grid2">${kv("Distance to ATR trail stop", fmt.pct(-risk, 2))}${kv("Position size at 1% account risk", (1 / (risk * 100) * 100).toFixed(0) + "% of account")}</div>`;
  }
  if (r._cls === "crypto") body += `<h3>Futures (live, Binance)</h3><div class="grid2" id="fut">${kv("Funding rate (8h)", fundingCell(r))}${kv("Long/short account ratio", "loading…")}</div>`;
  $("dBody").innerHTML = body;
  if (r._cls === "crypto") loadLS(r);
  drawChart(sym);
}
function forecastSection(r) {
  const fc = r.fc;
  if (!fc) return `<h3>Forecast</h3><p class="note">Not enough history for a forecast.</p>`;
  const plan = planFor(r), f = plan ? plan.f : fcFor(r);
  const unit = fc.calendar ? "days" : "trading days";
  const px = fmt.px;
  let h = planCard(r, plan);
  h += `<h3>Where the price is expected to be on ${niceD(S.fdate)} <span class="mute" style="text-transform:none">(${f.h} ${unit})</span></h3>
  <div class="expect">
    <div class="ex main"><div class="l">Base case (median)</div><div class="v">${px(f.med)}</div><div class="${cls(f.chg)}">${fmt.pct(f.chg, 2)}</div></div>
    <div class="ex"><div class="l">Likely range · 50%</div><div class="v">${px(f.lo50)} – ${px(f.hi50)}</div><div class="s">1 in 2 chance it ends here</div></div>
    <div class="ex"><div class="l">Wide range · 80%</div><div class="v">${px(f.lo80)} – ${px(f.hi80)}</div><div class="s">4 in 5 chance</div></div>
    <div class="ex"><div class="l">Extreme range · 90%</div><div class="v">${px(f.lo90)} – ${px(f.hi90)}</div><div class="s">9 in 10 chance</div></div>
    <div class="ex"><div class="l">Bull case (top 10%)</div><div class="v up">≥ ${px(f.hi80)}</div><div class="s">${fmt.pct(f.hi80 / r.price - 1)}</div></div>
    <div class="ex"><div class="l">Bear case (bottom 10%)</div><div class="v down">≤ ${px(f.lo80)}</div><div class="s">${fmt.pct(f.lo80 / r.price - 1)}</div></div>
    <div class="ex"><div class="l">Chance higher than today</div><div class="v ${f.pup >= 0.55 ? "up" : f.pup <= 0.45 ? "down" : ""}">${Math.round(f.pup * 100)}%</div></div>
    <div class="ex"><div class="l">Expected move (±1σ)</div><div class="v">±${(f.s * 100).toFixed(1)}%</div><div class="s">±${px(r.price * f.s)}</div></div>
  </div>`;
  const hs = [[1, "1 day"], [5, "1 week"], [21, "1 month"], [63, "3 months"], [126, "6 months"], [252, "12 months"]].map(([k, l]) => [fc.calendar ? Math.round(k * 365 / 252) : k, l]);
  h += `<table class="fctable"><thead><tr><th>Horizon</th><th>Date</th><th>Base case</th><th>Change</th><th>50% range</th><th>90% range</th><th>P(higher)</th></tr></thead><tbody>${hs.map(([k, l]) => { const x = fcAt(fc, k); return `<tr><td>${l}</td><td>${niceD(isoD(addBars(fc.asof, k, fc.calendar)))}</td><td><b>${px(x.med)}</b></td><td class="${cls(x.chg)}">${fmt.pct(x.chg, 2)}</td><td>${px(x.lo50)} – ${px(x.hi50)}</td><td>${px(x.lo90)} – ${px(x.hi90)}</td><td class="${x.pup >= 0.55 ? "up" : x.pup <= 0.45 ? "down" : ""}">${Math.round(x.pup * 100)}%</td></tr>`; }).join("")}</tbody></table>`;
  const ms = modelStats(fc, f.h || 21);
  if (ms) {
    const edge = ms.k > 0 && ms.ic_oos > 0;
    h += `<h3>How reliable is this forecast?</h3><div class="grid2">
      <div class="kv"><span>Out-of-sample IC (${ms.h}-bar, last year)</span><span class="${ms.ic_oos >= 0.05 ? "up" : ms.ic_oos > 0 ? "warn" : "down"}">${ms.ic_oos == null ? "–" : ms.ic_oos.toFixed(3)}</span></div>
      <div class="kv"><span>Direction hit rate (all ${fc.grp} assets)</span><span>${ms.hit_oos == null ? "–" : Math.round(ms.hit_oos * 100) + "%"} <span class="mute">vs ${Math.round(ms.base_up_oos * 100)}% up-periods</span></span></div>
      <div class="kv"><span>Picked the better performers</span><span class="${(ms.hit_rel_oos || 0) >= 0.53 ? "up" : (ms.hit_rel_oos || 0) < 0.5 ? "down" : "warn"}">${ms.hit_rel_oos != null ? Math.round(ms.hit_rel_oos * 100) + "%" : "–"} <span class="mute">(50% = no skill)</span></span></div>
      <div class="kv"><span>Statistical significance (t)</span><span class="${(ms.t_ic || 0) >= 2 ? "up" : "warn"}">${ms.t_ic != null ? ms.t_ic.toFixed(1) : "–"} <span class="mute">(≥ 2 = significant)</span></span></div>
      <div class="kv"><span>Outcomes inside 50% range</span><span>${Math.round(ms.cov50_oos * 100)}% <span class="mute">(target 50%)</span></span></div>
      <div class="kv"><span>Outcomes inside 80% range</span><span>${Math.round(ms.cov80_oos * 100)}% <span class="mute">(target 80%)</span></span></div>
      ${fc.acc ? `<div class="kv"><span>This asset: 1-month calls right</span><span class="${fc.acc.dir >= 0.6 ? "up" : fc.acc.dir < 0.5 ? "down" : "warn"}">${Math.round(fc.acc.dir * 100)}% (${fc.acc.n})</span></div>` : ""}
      <div class="kv"><span>Model weight used</span><span>${Math.round(ms.k * 100)}%</span></div></div>
      <p class="note">${edge ? "The model showed real skill on data it had not seen, so its directional tilt is used (scaled by the weight above)." : "<b>No proven edge at this horizon</b> — the model's direction is switched off and the forecast is centred on drift only; the ranges are still calibrated."} IC above 0.05 is considered meaningful in professional quant research.</p>`;
  }
  return h + structureSection(r);
}
function structureSection(r) {
  const ms = r.ms || {}, px = fmt.px;
  const kv = (k, v) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`;
  const wk = ms.wk_trend === 1 ? '<span class="up">Up</span>' : ms.wk_trend === -1 ? '<span class="down">Down</span>' : "Flat / unclear";
  const daily = r.above200 && r.st_dir === 1 ? '<span class="up">Up</span>' : r.above200 === false && r.st_dir === -1 ? '<span class="down">Down</span>' : "Mixed";
  const vr = ms.atr_pctile == null ? "–" : ms.atr_pctile > 0.8 ? `<span class="warn">High (${Math.round(ms.atr_pctile * 100)}th pct)</span>` : ms.atr_pctile < 0.2 ? `Low (${Math.round(ms.atr_pctile * 100)}th pct) — squeeze` : `Normal (${Math.round(ms.atr_pctile * 100)}th pct)`;
  let h = `<h3>Market structure</h3><div class="grid2">
    ${kv("Daily trend / Weekly trend", `${daily} / ${wk}`)}${kv("Swing structure", ms.structure || "–")}
    ${kv("Break of structure", ms.bos ? `<span class="${ms.bos === "bullish" ? "up" : "down"}">${ms.bos}</span>` : "none")}${kv("Volatility regime (ATR)", vr)}
    ${kv("Realised volatility (annual)", ms.rvol_ann != null ? (ms.rvol_ann * 100).toFixed(1) + "%" : "–")}${kv("Trend quality (R², 3 mo)", ms.trend_r2 != null ? `${ms.trend_r2.toFixed(2)} · slope ${fmt.pct(ms.trend_slope_ann, 0)}/yr` : "–")}
    ${kv("Last swing high / low", `${px(ms.last_swing_high)} / ${px(ms.last_swing_low)}`)}${kv("20-day high / low", `${px(ms.swing_hi20)} / ${px(ms.swing_lo20)}`)}
  </div>
  <h3>Key levels</h3><div class="grid2">
    <div>${(ms.res || []).slice().reverse().map((l) => kv(`Resistance (${l.touches} touch${l.touches > 1 ? "es" : ""})`, `<span class="down">${px(l.price)}</span> <span class="mute">${fmt.pct(l.price / r.price - 1)}</span>`)).join("") || kv("Resistance", "none nearby")}
    ${kv("<b>Price</b>", `<b>${px(r.price)}</b>`)}
    ${(ms.sup || []).map((l) => kv(`Support (${l.touches} touch${l.touches > 1 ? "es" : ""})`, `<span class="up">${px(l.price)}</span> <span class="mute">${fmt.pct(l.price / r.price - 1)}</span>`)).join("") || kv("Support", "none nearby")}</div>
    <div>${ms.piv_w ? ["R2", "R1", "P", "S1", "S2"].map((k) => kv(`Weekly pivot ${k}`, px(ms.piv_w[k]))).join("") : ""}${ms.piv_d ? kv("Daily pivot P / R1 / S1", `${px(ms.piv_d.P)} / ${px(ms.piv_d.R1)} / ${px(ms.piv_d.S1)}`) : ""}</div>
  </div>`;
  return h;
}
async function loadLS(r) {
  try {
    const j = await (await fetch(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${futSym(r)}&period=1h&limit=1`)).json();
    const v = j && j[0] ? parseFloat(j[0].longShortRatio).toFixed(2) : "–";
    $("fut").lastElementChild.lastElementChild.textContent = v;
  } catch (e) { $("fut").lastElementChild.lastElementChild.textContent = "unavailable"; }
}
async function drawChart(sym) {
  const el = $("chart"), el2 = $("rsiChart");
  el.innerHTML = ""; el2.innerHTML = "";
  let h;
  try { h = await getHist(sym); } catch (e) { el.textContent = "No chart data"; return; }
  const opts = (height) => ({ height, layout: { background: { color: "#0b0e13" }, textColor: "#8a93a3", fontFamily: "IBM Plex Mono" }, grid: { vertLines: { color: "#161c26" }, horzLines: { color: "#161c26" } }, rightPriceScale: { borderColor: "#232b38" }, timeScale: { borderColor: "#232b38" }, crosshair: { mode: 0 } });
  const ch = LightweightCharts.createChart(el, { ...opts(340), width: el.clientWidth });
  const cs = ch.addCandlestickSeries({ upColor: "#22c38e", downColor: "#f0565b", borderVisible: false, wickUpColor: "#22c38e", wickDownColor: "#f0565b" });
  cs.setData(h.t.map((t, i) => ({ time: t, open: h.o[i], high: h.h[i], low: h.l[i], close: h.c[i] })));
  const line = (arr, color, w = 1) => { const s = ch.addLineSeries({ color, lineWidth: w, priceLineVisible: false, lastValueVisible: false }); s.setData(h.t.map((t, i) => arr[i] == null ? { time: t } : { time: t, value: arr[i] })); };
  line(h.e20, "#f2b33d"); line(h.e50, "#5b8cff"); line(h.e200, "#9b7bff", 2);
  const st = ch.addLineSeries({ lineWidth: 2, lineStyle: 2, priceLineVisible: false, lastValueVisible: false });
  st.setData(h.t.map((t, i) => h.st[i] == null ? { time: t } : { time: t, value: h.st[i], color: h.sd[i] === 1 ? "#22c38e" : "#f0565b" }));
  const r = findRow(sym);
  if (r && r.fc) {
    const fc = r.fc, lastT = h.t[h.t.length - 1];
    const H = Math.min(260, Math.max(63, barsBetween(fc.asof, S.fdate, fc.calendar)));
    const pts = { med: [], hi: [], lo: [] };
    pts.med.push({ time: lastT, value: fc.p0 }); pts.hi.push({ time: lastT, value: fc.p0 }); pts.lo.push({ time: lastT, value: fc.p0 });
    for (let k = 1; k <= H; k++) {
      const t = addBars(fc.asof, k, fc.calendar) / 1000;
      if (t <= lastT) continue;
      const x = fcAt(fc, k);
      pts.med.push({ time: t, value: x.med }); pts.hi.push({ time: t, value: x.hi80 }); pts.lo.push({ time: t, value: x.lo80 });
    }
    const mk = (color, style, w) => ch.addLineSeries({ color, lineWidth: w, lineStyle: style, priceLineVisible: false, lastValueVisible: false });
    const med = mk("#e6e9ef", 0, 2); med.setData(pts.med);
    mk("#5b8cff", 2, 1).setData(pts.hi); mk("#5b8cff", 2, 1).setData(pts.lo);
    const marks = (fc.turns || []).filter((t) => t.bars <= H).map((t) => ({ time: addBars(fc.asof, t.bars, fc.calendar) / 1000, position: t.type === "trough" ? "belowBar" : "aboveBar", color: t.type === "trough" ? "#22c38e" : "#f0565b", shape: t.type === "trough" ? "arrowUp" : "arrowDown", text: t.type === "trough" ? "low" : "high" }));
    const sel = barsBetween(fc.asof, S.fdate, fc.calendar);
    if (sel > 0 && sel <= H) marks.push({ time: addBars(fc.asof, sel, fc.calendar) / 1000, position: "inBar", color: "#f2b33d", shape: "circle", text: "target" });
    marks.sort((a, b) => a.time - b.time);
    med.setMarkers(marks);
  }
  ch.timeScale().fitContent();
  const rc = LightweightCharts.createChart(el2, { ...opts(120), width: el2.clientWidth });
  const rs = rc.addLineSeries({ color: "#9b7bff", lineWidth: 1, priceLineVisible: false });
  rs.setData(h.t.map((t, i) => h.rsi[i] == null ? { time: t } : { time: t, value: h.rsi[i] }));
  [70, 30].forEach((p) => rs.createPriceLine({ price: p, color: "#3a4352", lineStyle: 2, lineWidth: 1, axisLabelVisible: false }));
  rc.timeScale().fitContent();
  ch.timeScale().subscribeVisibleLogicalRangeChange((r) => r && rc.timeScale().setVisibleLogicalRange(r));
  S.chart = ch; S.rsiChart = rc;
}
/* ---------------- technical view: full candlestick + cycle panel ---------------- */
const TV = { sym: null, range: 126, charts: [], n: 0, fut: 0 };
function chartOpts(el, height) {
  return { width: el.clientWidth, height, layout: { background: { color: "#121720" }, textColor: "#8a93a3", fontFamily: "IBM Plex Mono" },
    grid: { vertLines: { color: "#1a212c" }, horzLines: { color: "#1a212c" } }, rightPriceScale: { borderColor: "#232b38", minimumWidth: 80 },
    timeScale: { borderColor: "#232b38", rightOffset: 4 }, crosshair: { mode: 0 } };
}
const ws = (times) => times.map((t) => ({ time: t }));
function cycleSeries(h, fc, futTimes) {
  // fitted sine (from forecast.py params) and the detrended price it was fitted to, both in %
  const cy = fc && fc.cycle;
  if (!cy) return null;
  const P = cy.period, n = h.c.length, m = Math.min(n, 3 * P), w = 2 * Math.PI / P;
  const y = h.c.slice(n - m).map(Math.log), x = y.map((_, i) => i);
  const xm = (m - 1) / 2, ym = y.reduce((a, b) => a + b, 0) / m;
  let sxy = 0, sxx = 0; for (let i = 0; i < m; i++) { sxy += (x[i] - xm) * (y[i] - ym); sxx += (x[i] - xm) ** 2; }
  const b = sxy / sxx, a = ym - b * xm;
  const actual = [], fit = [], marks = [];
  const start = Math.max(0, n - Math.max(m, 260));
  for (let i = start; i < n; i++) {
    const k = i - (n - 1);
    const s = cy.amp * Math.sin(cy.phase + w * k) * 100;
    fit.push({ time: h.t[i], value: s });
    if (i >= n - m) actual.push({ time: h.t[i], value: (y[i - (n - m)] - (a + b * (i - (n - m)))) * 100 });
  }
  futTimes.forEach((t, j) => fit.push({ time: t, value: cy.amp * Math.sin(cy.phase + w * (j + 1)) * 100 }));
  // turning points of the fitted wave (past and future)
  const allT = h.t.slice(start).concat(futTimes);
  for (let i = 1; i < fit.length - 1; i++) {
    const p = fit[i - 1].value, c = fit[i].value, nx = fit[i + 1].value;
    if (c > p && c >= nx) marks.push({ time: allT[i], kind: "peak", fut: i >= n - start });
    if (c < p && c <= nx) marks.push({ time: allT[i], kind: "trough", fut: i >= n - start });
  }
  return { actual, fit, marks };
}
async function drawTV(sym) {
  const r = (S.data.classes[S.cls] || []).find((x) => x.sym === sym);
  if (!r) return;
  TV.sym = sym;
  document.querySelectorAll("#tbl tbody tr").forEach((tr) => tr.classList.toggle("sel", tr.dataset.s === sym));
  $("tvSym").textContent = disp(r);
  $("tvName").textContent = r.name || "";
  let h;
  try { h = await getHist(sym); } catch (e) { $("tvMain").textContent = "No chart data"; return; }
  TV.charts.forEach((c) => c.remove()); TV.charts = [];
  const fc = r.fc, n = h.t.length; TV.n = n;
  const P = fc && fc.cycle ? fc.cycle.period : 30;
  const H = fc ? Math.min(260, Math.max(63, 2 * P, barsBetween(fc.asof, S.fdate, fc.calendar))) : 0;
  const fut = []; for (let k = 1; k <= H; k++) fut.push(addBars(fc.asof, k, fc.calendar) / 1000);
  const futT = fut.filter((t) => t > h.t[n - 1]); TV.fut = futT.length;
  const allTimes = h.t.concat(futT);

  // main chart
  const el = $("tvMain"); el.innerHTML = "";
  const ch = LightweightCharts.createChart(el, chartOpts(el, 460));
  const cs = ch.addCandlestickSeries({ upColor: "#22c38e", downColor: "#f0565b", borderVisible: false, wickUpColor: "#22c38e", wickDownColor: "#f0565b" });
  cs.setData(h.t.map((t, i) => ({ time: t, open: h.o[i], high: h.h[i], low: h.l[i], close: h.c[i] })));
  const vol = ch.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
  ch.priceScale("vol").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
  ch.priceScale("right").applyOptions({ scaleMargins: { top: 0.06, bottom: 0.2 } });
  vol.setData(h.t.map((t, i) => ({ time: t, value: h.v[i] || 0, color: h.c[i] >= h.o[i] ? "rgba(34,195,142,.35)" : "rgba(240,86,91,.35)" })));
  const line = (vals, color, w = 1, style = 0, times = h.t) => { const s = ch.addLineSeries({ color, lineWidth: w, lineStyle: style, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }); s.setData(times.map((t, i) => vals[i] == null ? { time: t } : { time: t, value: vals[i] })); return s; };
  line(h.e20, "#f2b33d"); line(h.e50, "#5b8cff"); line(h.e200, "#9b7bff", 2);
  // Bollinger from closes
  const bu = [], bl = [];
  for (let i = 0; i < n; i++) { if (i < 19) { bu.push(null); bl.push(null); continue; } const w = h.c.slice(i - 19, i + 1), m = w.reduce((a, b) => a + b, 0) / 20, sd = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / 20); bu.push(m + 2 * sd); bl.push(m - 2 * sd); }
  line(bu, "rgba(138,147,163,.45)", 1, 1); line(bl, "rgba(138,147,163,.45)", 1, 1);
  const st = ch.addLineSeries({ lineWidth: 2, lineStyle: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  st.setData(h.t.map((t, i) => h.st[i] == null ? { time: t } : { time: t, value: h.st[i], color: h.sd[i] === 1 ? "#22c38e" : "#f0565b" }));
  // key price lines
  const last = h.c[n - 1], hi52 = Math.max(...h.h.slice(-252)), lo52 = Math.min(...h.l.slice(-252));
  const pl = (price, color, title, style = 2) => cs.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title });
  pl(hi52, "#8a93a3", "52W high"); pl(lo52, "#8a93a3", "52W low");
  const ms = r.ms || {};
  (ms.res || []).forEach((l, i) => pl(l.price, "rgba(240,86,91,.55)", `R${i + 1}`, 1));
  (ms.sup || []).forEach((l, i) => pl(l.price, "rgba(34,195,142,.55)", `S${i + 1}`, 1));
  const plan = fc ? tradePlan(r, barsBetween(fc.asof, S.fdate, fc.calendar)) : null;
  if (plan && plan.dir) {
    pl(plan.stop, "#f0565b", "STOP", 0);
    plan.targets.forEach((t, i) => pl(t.price, "#22c38e", `T${i + 1}`, 0));
  } else if (r.st_stop) pl(r.st_stop, r.st_dir === 1 ? "#22c38e" : "#f0565b", "ATR stop");
  // forecast cone + cycle turn markers
  let f = null, cyc = null;
  if (fc) {
    f = fcFor(r);
    const med = [], h50 = [], l50 = [], h90 = [], l90 = [];
    futT.forEach((t, j) => { const x = fcAt(fc, j + 1 + (fut.length - futT.length)); med.push(x.med); h50.push(x.hi50); l50.push(x.lo50); h90.push(x.hi90); l90.push(x.lo90); });
    const ft = [h.t[n - 1]].concat(futT), p0 = [fc.p0];
    line(p0.concat(h90), "rgba(91,140,255,.55)", 1, 2, ft); line(p0.concat(l90), "rgba(91,140,255,.55)", 1, 2, ft);
    line(p0.concat(h50), "#5b8cff", 1, 0, ft); line(p0.concat(l50), "#5b8cff", 1, 0, ft);
    const ms = line(p0.concat(med), "#e6e9ef", 2, 0, ft);
    if (f && f.h > 0) pl(f.med, "#f2b33d", `Base ${niceD(S.fdate)}`, 0);
    cyc = cycleSeries(h, fc, futT);
    if (cyc) {
      const weak = fc.cycle.strength < 0.3;
      const pastMarks = cyc.marks.filter((m) => !m.fut).map((m) => ({ time: m.time, position: m.kind === "peak" ? "aboveBar" : "belowBar", color: m.kind === "peak" ? "rgba(240,86,91,.7)" : "rgba(34,195,142,.7)", shape: "circle", size: 0.6 }));
      cs.setMarkers(pastMarks);
      const futMarks = cyc.marks.filter((m) => m.fut).map((m) => {
        const k = futT.indexOf(m.time) + 1 + (fut.length - futT.length);
        const est = fcAt(fc, k).med;
        return { time: m.time, position: m.kind === "peak" ? "aboveBar" : "belowBar", color: m.kind === "peak" ? "#f0565b" : "#22c38e", shape: m.kind === "peak" ? "arrowDown" : "arrowUp", text: `${m.kind === "peak" ? "High" : "Low"} ~${fmt.px(est)}` };
      });
      ms.setMarkers(futMarks);
    }
  } else line([], "#000", 1, 0, futT);
  TV.charts.push(ch);

  // cycle pane
  const ec = $("tvCyc"); ec.innerHTML = "";
  const cc = LightweightCharts.createChart(ec, chartOpts(ec, 150));
  const pad = cc.addLineSeries({ visible: false }); pad.setData(ws(allTimes));
  if (cyc) {
    const M = 1.2 * Math.max(0.5, ...cyc.actual.map((d) => Math.abs(d.value)), ...cyc.fit.map((d) => Math.abs(d.value)));
    const auto = () => ({ priceRange: { minValue: -M, maxValue: M } });
    const pf = { type: "custom", formatter: (v) => v.toFixed(1) + "%" };
    const ca = cc.addLineSeries({ color: "#8a93a3", lineWidth: 1, priceLineVisible: false, lastValueVisible: false, title: "price vs trend", autoscaleInfoProvider: auto, priceFormat: pf }); ca.setData(cyc.actual);
    const cf = cc.addLineSeries({ color: "#f2b33d", lineWidth: 2, priceLineVisible: false, lastValueVisible: false, title: "cycle", autoscaleInfoProvider: auto, priceFormat: pf }); cf.setData(cyc.fit);
    cf.createPriceLine({ price: 0, color: "#3a4352", lineStyle: 2, lineWidth: 1, axisLabelVisible: false });
    cf.setMarkers(cyc.marks.filter((m) => m.fut).map((m) => ({ time: m.time, position: m.kind === "peak" ? "aboveBar" : "belowBar", color: m.kind === "peak" ? "#f0565b" : "#22c38e", shape: m.kind === "peak" ? "arrowDown" : "arrowUp", text: niceD(isoD(m.time * 1000)) })));
    const s = fc.cycle.strength;
    $("tvCycInfo").innerHTML = `period ≈ ${fc.cycle.period} ${fc.calendar ? "days" : "trading days"}, swing ±${(fc.cycle.amp * 100).toFixed(1)}%, strength <span class="${s >= 0.5 ? "up" : s < 0.3 ? "warn" : ""}">${(s * 100).toFixed(0)}%${s < 0.3 ? " (weak — rough guide only)" : s >= 0.5 ? " (clear)" : ""}</span>${fc.use_cycle ? " · used in the price forecast" : " · not used in the price forecast"}`;
  } else $("tvCycInfo").textContent = "not enough history";
  TV.charts.push(cc);

  // RSI pane
  const er = $("tvRsi"); er.innerHTML = "";
  const rc = LightweightCharts.createChart(er, chartOpts(er, 100));
  const pad2 = rc.addLineSeries({ visible: false }); pad2.setData(ws(allTimes));
  const rs = rc.addLineSeries({ color: "#9b7bff", lineWidth: 1, priceLineVisible: false });
  rs.setData(h.t.map((t, i) => h.rsi[i] == null ? { time: t } : { time: t, value: h.rsi[i] }));
  [70, 30].forEach((p) => rs.createPriceLine({ price: p, color: "#3a4352", lineStyle: 2, lineWidth: 1, axisLabelVisible: false }));
  TV.charts.push(rc);

  // sync panes
  let syncing = false;
  TV.charts.forEach((c) => c.timeScale().subscribeVisibleLogicalRangeChange((rg) => {
    if (syncing || !rg) return; syncing = true;
    TV.charts.forEach((o) => o !== c && o.timeScale().setVisibleLogicalRange(rg)); syncing = false;
  }));
  setTVRange(TV.range);

  // OHLC readout
  const readout = (i) => {
    if (i == null || i < 0 || i >= n) i = n - 1;
    const chg = i > 0 ? h.c[i] / h.c[i - 1] - 1 : 0;
    $("tvOhlc").innerHTML = `<span>${niceD(isoD(h.t[i] * 1000))}</span><span>O <b>${fmt.px(h.o[i])}</b></span><span>H <b>${fmt.px(h.h[i])}</b></span><span>L <b>${fmt.px(h.l[i])}</b></span><span>C <b>${fmt.px(h.c[i])}</b></span><span class="${cls(chg)}">${fmt.pct(chg, 2)}</span><span>Vol <b>${h.v[i] ? Number(h.v[i]).toLocaleString() : "–"}</b></span><span>RSI <b>${fmt.n(h.rsi[i], 0)}</b></span>`;
  };
  readout(n - 1);
  ch.subscribeCrosshairMove((p) => {
    if (!p || p.time == null) return readout(n - 1);
    const i = h.t.indexOf(p.time);
    if (i >= 0) return readout(i);
    if (fc) { const k = futT.indexOf(p.time) + 1 + (fut.length - futT.length); const x = fcAt(fc, k); $("tvOhlc").innerHTML = `<span>${niceD(isoD(p.time * 1000))} (forecast)</span><span>Est. <b>${fmt.px(x.med)}</b></span><span>80% <b>${fmt.px(x.lo80)} – ${fmt.px(x.hi80)}</b></span><span>P(higher) <b>${(x.pup * 100).toFixed(0)}%</b></span>`; }
  });

  $("tvLegend").innerHTML = `<span style="--c:#f2b33d">EMA 20</span><span style="--c:#5b8cff">EMA 50</span><span style="--c:#9b7bff">EMA 200</span><span style="--c:#8a93a3">Bollinger 20,2</span><span style="--c:#22c38e">ATR trail</span><span style="--c:#e6e9ef">Forecast base case</span><span style="--c:#5b8cff">50% range (solid) · 90% (dashed)</span><span style="--c:#f0565b">Resistance R1–R3</span><span style="--c:#22c38e">Support S1–S3</span><span style="--c:#f2b33d">Cycle wave</span>`;

  // key levels
  const lv = (l, v, s = "") => `<div class="lv"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  const vs = (p) => `${fmt.pct(p / last - 1)} from price`;
  let L = lv("Last price", fmt.px(last), `${r.date} · ${fmt.pct(r.chg1d, 2)} 1D`)
    + lv("Day range", `${fmt.px(h.l[n - 1])} – ${fmt.px(h.h[n - 1])}`, `open ${fmt.px(h.o[n - 1])}`)
    + lv("52-week high", fmt.px(hi52), vs(hi52)) + lv("52-week low", fmt.px(lo52), vs(lo52))
    + lv("EMA 20 / 50", `${fmt.px(h.e20[n - 1])} / ${fmt.px(h.e50[n - 1])}`, "short / medium trend")
    + lv("EMA 200", fmt.px(h.e200[n - 1]), h.e200[n - 1] ? vs(h.e200[n - 1]) : "")
    + lv("Bollinger band", `${fmt.px(bl[n - 1])} – ${fmt.px(bu[n - 1])}`, `σ-zone ${fmt.n(r.z20, 2)}`)
    + lv("ATR trail stop", fmt.px(r.st_stop), r.st_stop ? `${r.st_dir === 1 ? "long" : "short"} · ${vs(r.st_stop)}` : "");
  if (f) L += lv(`Base case ${niceD(S.fdate)}`, fmt.px(f.med), `50%: ${fmt.px(f.lo50)} – ${fmt.px(f.hi50)}`) + lv("90% range", `${fmt.px(f.lo90)} – ${fmt.px(f.hi90)}`, `P(higher) ${Math.round(f.pup * 100)}%`);
  (ms.res || []).slice(0, 2).forEach((l, i) => (L += lv(`Resistance R${i + 1}`, fmt.px(l.price), `${l.touches} touches · ${vs(l.price)}`)));
  (ms.sup || []).slice(0, 2).forEach((l, i) => (L += lv(`Support S${i + 1}`, fmt.px(l.price), `${l.touches} touches · ${vs(l.price)}`)));
  if (cyc) cyc.marks.filter((m) => m.fut).slice(0, 3).forEach((m) => {
    const k = futT.indexOf(m.time) + 1 + (fut.length - futT.length);
    L += lv(`Next cycle ${m.kind === "peak" ? "high" : "low"}`, niceD(isoD(m.time * 1000)), `est. ${fmt.px(fcAt(fc, k).med)} · in ${k} ${fc.calendar ? "days" : "bars"}`);
  });
  $("tvLevels").innerHTML = L;
  $("tvPlan").innerHTML = plan ? planCard(r, plan) : "";
}
function setTVRange(bars) {
  TV.range = bars;
  [...$("tvRange").children].forEach((b) => b.classList.toggle("on", +b.dataset.r === bars));
  const from = Math.max(0, TV.n - bars), to = TV.n - 1 + Math.min(TV.fut, Math.max(20, Math.round(bars / 3)));
  TV.charts.forEach((c) => c.timeScale().setVisibleLogicalRange({ from, to }));
}
$("tvRange").onclick = (e) => { const b = e.target.dataset.r; if (b) setTVRange(+b); };
$("tvDetails").onclick = () => TV.sym && openDetail(TV.sym);
function syncTV() {
  const on = S.view === "tech" && S.cls !== "method";
  $("tv").hidden = !on;
  if (!on || !S.data) return;
  const list = S.data.classes[S.cls] || [];
  const ok = list.some((x) => x.sym === TV.sym);
  const first = document.querySelector("#tbl tbody tr[data-s]");
  const sym = ok ? TV.sym : first ? first.dataset.s : null;
  if (sym) drawTV(sym);
}

$("closeDrawer").onclick = () => ($("drawer").hidden = true);
$("drawer").addEventListener("click", (e) => { if (e.target.id === "drawer") $("drawer").hidden = true; });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("drawer").hidden = true; });
window.addEventListener("resize", () => { TV.charts.forEach((c) => c.applyOptions({ width: c.chartElement().parentElement.clientWidth })); if (S.chart) S.chart.applyOptions({ width: $("chart").clientWidth }); if (S.rsiChart) S.rsiChart.applyOptions({ width: $("rsiChart").clientWidth }); });

/* ---------------- method page ---------------- */
const METHOD = `
<h2>How the forecast and signals work</h2>
<p>The forecast is built the way a systematic (quant) desk would build one: a single model per asset group, trained on 5 years of daily data across every asset in the group, and judged only on data it has never seen.</p>
<table><tr><th>Step</th><th>What happens</th></tr>
<tr><td>1. Factors</td><td>Nine standardised factors per asset per day: distance from the 200-day EMA, 3-month and 12-minus-1-month momentum (volatility-adjusted), 1-week reversal, RSI, Bollinger z-score, ATR-trail direction, ADX/DMI direction, and 50/200 EMA alignment.</td></tr>
<tr><td>2. Target</td><td>Forward return over 1 day, 1 week, 1 month, 3, 6 and 12 months, divided by the asset's expected volatility — so a quiet utility stock and a volatile coin are compared fairly.</td></tr>
<tr><td>3. Model</td><td>Ridge regression pooled across all assets in the group (stocks + ETFs + indices together; crypto; forex) — tens of thousands of observations, so it does not over-fit one chart.</td></tr>
<tr><td>4. Walk-forward test</td><td>The last 12 months are held out. The model is trained only on older data and scored on that year: <b>IC</b> (rank correlation of forecast vs outcome; above 0.05 is meaningful), <b>hit rate</b>, and how often outcomes fell inside the 50% and 80% ranges. If it shows no out-of-sample skill, its directional view is switched off.</td></tr>
<tr><td>5. Ranges</td><td>Built from the model's real historical errors, not a textbook bell curve, so fat tails and skew are kept. That gives the base case (median), 50%, 80% and 90% ranges, and the chance of finishing above any price.</td></tr>
<tr><td>6. Cycle</td><td>The dominant price cycle is projected for turning dates and only added to the price path when it beat the model on that asset's own history.</td></tr>
<tr><td>7. Signal</td><td>Conviction (−100 to +100) = 50% forecast odds + 25% daily trend + 15% weekly trend + 10% swing structure. ≥ +55 STRONG BUY, ≥ +25 BUY, ≤ −25 SELL, ≤ −55 STRONG SELL. A buy is blocked when daily and weekly trends are both down, and vice-versa.</td></tr>
<tr><td>8. Trade plan</td><td>Entry zone within ½ ATR of price (or the nearest support/resistance); stop beyond the ATR trail / 20-day swing / nearest level, kept between 1 and 3.5 ATR; targets = the base case (or the nearest level / edge of the 50% range when the base case is flat), then the 80% and 90% range edges, always progressively further; R-multiples, probability of reaching each by the date, and position size for 1% account risk.</td></tr>
</table>
<p><strong>Reading it honestly:</strong> even professional models are right on direction only ~52–58% of the time over days to weeks; the edge comes from sizing and stops, not certainty. Trust the ranges more than the single base-case number, and favour signals where the model's out-of-sample IC is positive and the asset's own hit rate is above 55%.</p>

<h2>How the score works — and why these indicators</h2>
<p>ELCARO lists 28 indicators plus proprietary scripts. Most of them measure the same thing in slightly different ways, and stacking correlated indicators makes a screener <em>look</em> more thorough without making it more accurate — it just over-weights one idea. This screener keeps one representative per factor family, favouring the families with the strongest published out-of-sample evidence, then combines them into a 0–100 composite ranked <strong>within each asset class</strong>.</p>
<table><tr><th>Bucket (weight)</th><th>What it uses</th><th>Why</th></tr>
<tr><td><strong>Trend</strong> (30%)</td><td>Price vs EMA 20/50/200, 50/200 cross, ATR trailing stop direction, ADX with +DI/−DI</td><td>Time-series momentum / trend following is the most robust technical effect across stocks, indices, commodities and crypto. ADX filters out trendless chop.</td></tr>
<tr><td><strong>Momentum</strong> (25%)</td><td>12-minus-1-month return rank, 3-month ROC rank, MACD histogram sign and slope</td><td>Cross-sectional momentum (Jegadeesh &amp; Titman) is one of the best-documented anomalies. Skipping the latest month avoids short-term reversal.</td></tr>
<tr><td><strong>Relative strength</strong> (15%)</td><td>3-month return minus benchmark (SPY for stocks/ETFs, S&amp;P 500 for indices, BTC for crypto)</td><td>Leaders vs the benchmark tend to keep leading; also tells you if a "rally" is just beta.</td></tr>
<tr><td><strong>Volume</strong> (10%)</td><td>OBV 20-day slope, relative volume on up-days</td><td>Confirms that moves have participation. Weaker evidence on its own, so a smaller weight.</td></tr>
<tr><td><strong>Entry timing</strong> (10%)</td><td>RSI(14), RSI(2), Bollinger σ-zone (z-score vs 20-day mean)</td><td>Buying short-term pullbacks <em>inside</em> long-term uptrends (e.g. RSI(2) &lt; 10 above the 200-day) has a long record on equity indices; heavily stretched moves (&gt;2σ, RSI &gt; 75) are penalised.</td></tr>
<tr><td><strong>Quality</strong> (10%, stocks only)</td><td>Piotroski F-score, Altman Z-score (distress cap)</td><td>F-score separates strong from weak balance sheets; Altman Z flags bankruptcy risk (not applied to banks/insurers).</td></tr>
</table>
<p>A bucket with no data (e.g. volume on some indices, quality on ETFs) is dropped and the weights re-normalised. <b>Forex</b> has no real volume (it trades over the counter) and no single benchmark, so forex pairs are scored on trend, momentum (ranked against the other pairs), entry timing and the price forecast; a high score means the <em>first</em> currency is strengthening. Gold and silver use front-month futures as a proxy for XAU/USD and XAG/USD. Market regime (S&amp;P 500 vs 200-day EMA, VIX, DXY, 10Y yield, gold; BTC trend, Fear &amp; Greed, BTC dominance) is shown on top as context rather than mixed into individual scores.</p>
<h2>What was kept and dropped from the ELCARO list</h2>
<table><tr><th>Indicator</th><th>Decision</th><th>Reason</th></tr>
<tr><td>EMA</td><td class="keep">Kept</td><td>Trend backbone (20/50/200).</td></tr>
<tr><td>MA, Smoothed MA, WMA, BBI, DMA, Bias, Average Price</td><td class="drop">Dropped</td><td>Variants of a moving average; redundant with EMA.</td></tr>
<tr><td>MACD</td><td class="keep">Kept</td><td>Momentum change (histogram slope).</td></tr>
<tr><td>RSI</td><td class="keep">Kept</td><td>Single overbought/oversold gauge, plus RSI(2) for pullbacks and divergence detection.</td></tr>
<tr><td>KDJ, Williams %R, CCI</td><td class="drop">Dropped</td><td>Same information as RSI.</td></tr>
<tr><td>DMI / ADX</td><td class="keep">Kept</td><td>Only indicator here that measures trend <em>strength</em>.</td></tr>
<tr><td>Momentum, ROC</td><td class="keep">Kept (as ROC)</td><td>Used as 3-month and 12-1-month returns.</td></tr>
<tr><td>TRIX, Awesome Oscillator</td><td class="drop">Dropped</td><td>Smoothed momentum; redundant with MACD.</td></tr>
<tr><td>Bollinger Bands</td><td class="keep">Kept</td><td>As %B and σ-zone — the open equivalent of ELCARO's "Trading Filter" σ-zones.</td></tr>
<tr><td>Parabolic SAR</td><td class="drop">Replaced</td><td>ATR trailing stop (Supertrend 10, 3) — the open equivalent of the "Trend Trail"; less whipsaw than SAR.</td></tr>
<tr><td>OBV, Volume</td><td class="keep">Kept</td><td>Volume confirmation.</td></tr>
<tr><td>EMV, PVT, VR</td><td class="drop">Dropped</td><td>Overlap with OBV / relative volume.</td></tr>
<tr><td>BRAR, CR, PSY</td><td class="drop">Dropped</td><td>Sentiment ratios from Chinese A-share practice with little published evidence outside that market.</td></tr>
<tr><td>"Forecast" cycle turning dates</td><td class="keep">Replaced</td><td>ELCARO's method is proprietary, so an open dominant-cycle model is used instead, with its own accuracy checked against past data (see above).</td></tr>
<tr><td>VWAP, order book, liquidations, on-chain, mempool</td><td class="drop">Out of scope</td><td>Intraday or paid data feeds; not meaningful on a daily screener.</td></tr>
<tr><td>Funding rate, long/short ratio</td><td class="keep">Kept (crypto, live)</td><td>Crowding gauges, fetched live from Binance in your browser; shown as context.</td></tr>
<tr><td>Fear &amp; Greed, BTC dominance, VIX, DXY, 10Y, gold, indices</td><td class="keep">Kept (regime bar)</td><td>Market backdrop.</td></tr>
<tr><td>Piotroski F, Altman Z</td><td class="keep">Kept (stocks)</td><td>Quality / distress filter.</td></tr>
</table>
<h2>Limits</h2>
<ul><li>No indicator set is "accurate" in the sense of reliably predicting the next move. The goal is to rank assets so the odds lean your way, then manage risk with the ATR stop.</li>
<li>Daily bars from Yahoo Finance via GitHub Actions; can lag or have gaps. Fundamentals refresh weekly.</li>
<li>Research tool only — not investment advice.</li></ul>`;

/* ---------------- self-update: reload if a newer build has been published ---------------- */
async function checkBuild() {
  try {
    const mine = document.querySelector('meta[name="build"]')?.content;
    const txt = await (await fetch("index.html?ts=" + Date.now(), { cache: "no-store" })).text();
    const m = txt.match(/<meta name="build" content="([^"]+)"/);
    if (m && mine && m[1] !== mine && !/__V__/.test(m[1])) location.replace(location.pathname + "?v=" + m[1] + location.hash);
  } catch (e) { /* offline: keep current */ }
}
checkBuild();
setInterval(checkBuild, 15 * 60 * 1000);
if (/[?&]tab=picks/.test(location.search) || location.hash === "#picks") setTimeout(() => document.querySelector('#tabs button[data-cls="picks"]').click(), 300);
load();
