/* Multi-Asset Screener front end. Reads data/screener.json built by scripts/build_data.py */
const S = { data: null, cls: "stocks", sort: { key: "score", dir: -1 }, preset: null, funding: {}, chart: null, rsiChart: null };
const $ = (id) => document.getElementById(id);

const fmt = {
  px: (v) => v == null ? "–" : v >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : v >= 1 ? v.toFixed(2) : v.toPrecision(4),
  pct: (v, d = 1) => v == null ? "–" : (v > 0 ? "+" : "") + (v * 100).toFixed(d) + "%",
  n: (v, d = 1) => v == null ? "–" : Number(v).toFixed(d),
};
const cls = (v) => v == null ? "mute" : v > 0 ? "up" : v < 0 ? "down" : "mute";
const chipColor = { "Strong trend": "g", "Breakout": "b", "Pullback in uptrend": "g", "RSI(2) oversold": "y", "Overextended": "y", "Bullish divergence": "g", "Bearish divergence": "r", "Downtrend": "r", "Distress risk": "r" };

const PRESETS = {
  "Trend leaders": { minScore: 70, upOnly: true, noExt: true },
  "Pullback buys": { sig: "Pullback in uptrend" },
  "Breakouts": { sig: "Breakout" },
  "RSI(2) dip-buys": { sig: "RSI(2) oversold" },
  "Bullish divergence": { sig: "Bullish divergence" },
  "Quality + trend": { minScore: 60, upOnly: true, quality: true },
  "Avoid list": { sig: "Downtrend" },
};

const COLS = [
  { k: "sym", t: "Symbol", f: (r) => `<span class="sym">${r.sym.replace(/\d{3,}-USD$/, "-USD")}</span><span class="nm">${r.name || ""}</span>` },
  { k: "price", t: "Price", f: (r) => fmt.px(r.price) },
  { k: "chg1d", t: "1D", f: (r) => `<span class="${cls(r.chg1d)}">${fmt.pct(r.chg1d)}</span>` },
  { k: "chg5d", t: "5D", f: (r) => `<span class="${cls(r.chg5d)}">${fmt.pct(r.chg5d)}</span>` },
  { k: "chg1m", t: "1M", f: (r) => `<span class="${cls(r.chg1m)}">${fmt.pct(r.chg1m)}</span>` },
  { k: "score", t: "Score", f: (r) => scoreBar(r.score) },
  { k: "st_dir", t: "Trend", f: (r) => trendCell(r) },
  { k: "rsi14", t: "RSI", f: (r) => `<span class="${r.rsi14 > 70 ? "warn" : r.rsi14 < 30 ? "up" : ""}">${fmt.n(r.rsi14, 0)}</span>` },
  { k: "adx", t: "ADX", f: (r) => `<span class="${r.adx > 25 ? "" : "mute"}">${fmt.n(r.adx, 0)}</span>` },
  { k: "z20", t: "σ-zone", f: (r) => `<span class="${Math.abs(r.z20) > 2 ? "warn" : ""}">${fmt.n(r.z20, 2)}</span>` },
  { k: "relvol", t: "Rel Vol", f: (r) => `<span class="${r.relvol > 1.5 ? "up" : "mute"}">${fmt.n(r.relvol, 2)}</span>` },
  { k: "dist52h", t: "vs 52W Hi", f: (r) => `<span class="${r.dist52h > -0.03 ? "up" : "mute"}">${fmt.pct(r.dist52h)}</span>` },
  { k: "fscore", t: "F-Score", only: "stocks", f: (r) => r.fscore == null ? "–" : `<span class="${r.fscore >= 7 ? "up" : r.fscore <= 3 ? "down" : ""}">${r.fscore}/9</span>` },
  { k: "altz", t: "Altman Z", only: "stocks", f: (r) => r.altz == null ? "–" : `<span class="${r.altz < 1.81 ? "down" : r.altz > 2.99 ? "up" : "warn"}">${fmt.n(r.altz, 1)}</span>` },
  { k: "funding", t: "Funding 8h", only: "crypto", f: (r) => fundingCell(r) },
  { k: "signals", t: "Signals", sortable: false, cl: "sigs", f: (r) => `<div class="chips">${(r.signals || []).map((s) => `<span class="chip ${chipColor[s] || ""}">${s}</span>`).join("")}</div>` },
];

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
  const g = new Date(S.data.generated);
  $("updated").textContent = "data as of " + g.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  renderRegime();
  buildControls();
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
    }
    [...$("presets").children].forEach((b) => b.classList.toggle("on", b.dataset.p === p && p !== ""));
    render();
  };
  const sigs = Object.keys(chipColor);
  $("sig").innerHTML = `<option value="">Any signal</option>` + sigs.map((s) => `<option>${s}</option>`).join("");
  ["q", "minScore", "rsiMin", "rsiMax", "sig", "upOnly", "noExt"].forEach((id) => $(id).addEventListener("input", render));
}
function resetFilters() {
  $("q").value = ""; $("minScore").value = 0; $("rsiMin").value = 0; $("rsiMax").value = 100;
  $("sig").value = ""; $("upOnly").checked = false; $("noExt").checked = false; S.preset = null;
}

/* ---------------- table ---------------- */
function rows() {
  let r = (S.data.classes[S.cls] || []).slice();
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
    (!(S.preset && PRESETS[S.preset].quality) || (x.fscore ?? 0) >= 6));
  const { key, dir } = S.sort;
  const val = (x) => key === "funding" ? S.funding[futSym(x)] : x[key];
  r.sort((a, b) => {
    const va = val(a), vb = val(b);
    if (va == null) return 1; if (vb == null) return -1;
    return (typeof va === "string" ? va.localeCompare(vb) : va - vb) * dir;
  });
  return r;
}
function render() {
  if (!S.data) return;
  const cols = COLS.filter((c) => !c.only || c.only === S.cls);
  $("tbl").querySelector("thead").innerHTML = "<tr>" + cols.map((c) => `<th data-k="${c.k}" class="${S.sort.key === c.k ? "sorted" : ""}">${c.t}${S.sort.key === c.k ? (S.sort.dir < 0 ? " ↓" : " ↑") : ""}</th>`).join("") + "</tr>";
  const list = rows();
  $("tbl").querySelector("tbody").innerHTML = list.map((r) => `<tr data-s="${r.sym}">` + cols.map((c) => `<td class="${c.cl || ""}">${c.f(r)}</td>`).join("") + "</tr>").join("");
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
  if (tr) openDetail(tr.dataset.s);
});

/* ---------------- tabs ---------------- */
$("tabs").onclick = (e) => {
  const b = e.target.closest("button"); if (!b) return;
  [...$("tabs").children].forEach((x) => x.classList.toggle("on", x === b));
  S.cls = b.dataset.cls;
  const m = S.cls === "method";
  $("screen").hidden = m; $("method").hidden = !m;
  if (m) { $("method").innerHTML = METHOD; return; }
  if (S.cls === "indices" || S.cls === "etfs") S.sort = { key: "score", dir: -1 };
  render();
};

/* ---------------- detail drawer ---------------- */
const safe = (s) => s.replace(/[^A-Za-z0-9\-_.]/g, "_");
async function openDetail(sym) {
  const r = (S.data.classes[S.cls] || []).find((x) => x.sym === sym);
  if (!r) return;
  $("drawer").hidden = false;
  const b = r.buckets || {};
  const bk = (k, l) => b[k] == null ? "" : `<div class="bk"><div class="l">${l}</div><div class="v ${b[k] >= 70 ? "up" : b[k] < 40 ? "down" : ""}">${b[k]}</div></div>`;
  $("dHead").innerHTML = `<div class="dh"><h2>${r.sym} <span class="px">${fmt.px(r.price)}</span> <span class="${cls(r.chg1d)}" style="font:500 15px var(--mono)">${fmt.pct(r.chg1d, 2)}</span></h2>
    <p>${r.name || ""}${r.sector ? " · " + r.sector : ""} · bar date ${r.date}</p>
    <div class="chips">${(r.signals || []).map((s) => `<span class="chip ${chipColor[s] || ""}">${s}</span>`).join("")}</div>
    <div class="buckets"><div class="bk"><div class="l">Composite</div><div class="v">${r.score == null ? "–" : r.score.toFixed(0)}</div></div>
    ${bk("trend", "Trend")}${bk("momentum", "Momentum")}${bk("relstr", "Rel. strength")}${bk("volume", "Volume")}${bk("timing", "Entry timing")}${bk("quality", "Quality")}</div>
    <div class="legend"><span style="--c:#f2b33d">EMA 20</span><span style="--c:#5b8cff">EMA 50</span><span style="--c:#9b7bff">EMA 200</span><span style="--c:#22c38e">ATR trail (up)</span><span style="--c:#f0565b">ATR trail (down)</span></div></div>`;
  const kv = (k, v) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`;
  let body = `<h3>Indicators</h3><div class="grid2">
    ${kv("RSI (14)", fmt.n(r.rsi14))}${kv("RSI (2)", fmt.n(r.rsi2))}
    ${kv("MACD histogram", fmt.n(r.macd_hist, 3) + (r.macd_rising ? " ↑" : " ↓"))}${kv("ADX / +DI / −DI", `${fmt.n(r.adx, 0)} / ${fmt.n(r.pdi, 0)} / ${fmt.n(r.mdi, 0)}`)}
    ${kv("Bollinger %B", fmt.n(r.pct_b, 2))}${kv("σ-zone (z vs 20MA)", fmt.n(r.z20, 2))}
    ${kv("ATR % of price", fmt.pct(r.atr_pct, 2))}${kv("ATR trail stop", fmt.px(r.st_stop) + (r.st_dir === 1 ? " (long)" : " (short)"))}
    ${kv("Relative volume", fmt.n(r.relvol, 2))}${kv("OBV slope (20d)", fmt.n(r.obv_slope, 2))}
    ${kv("3-month return", fmt.pct(r.ret63))}${kv("12-1 month momentum", fmt.pct(r.mom12_1))}
    ${kv("Distance to 52W high", fmt.pct(r.dist52h))}${kv("RSI divergence", r.div || "none")}
    </div>`;
  if (S.cls === "stocks") body += `<h3>Fundamentals</h3><div class="grid2">${kv("Piotroski F-score", r.fscore == null ? "–" : r.fscore + " / 9")}${kv("Altman Z-score", r.altz == null ? "–" : fmt.n(r.altz, 2) + (r.sector === "Financial Services" ? " (n/a for financials)" : ""))}</div>`;
  if (r.st_stop && r.atr_pct) {
    const risk = r.st_dir === 1 ? (r.price - r.st_stop) / r.price : null;
    if (risk) body += `<h3>Risk framing</h3><div class="grid2">${kv("Distance to ATR trail stop", fmt.pct(-risk, 2))}${kv("Position size at 1% account risk", (1 / (risk * 100) * 100).toFixed(0) + "% of account")}</div>`;
  }
  if (S.cls === "crypto") body += `<h3>Futures (live, Binance)</h3><div class="grid2" id="fut">${kv("Funding rate (8h)", fundingCell(r))}${kv("Long/short account ratio", "loading…")}</div>`;
  $("dBody").innerHTML = body;
  if (S.cls === "crypto") loadLS(r);
  drawChart(sym);
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
  try { h = await (await fetch(`data/history/${safe(sym)}.json`)).json(); } catch (e) { el.textContent = "No chart data"; return; }
  const opts = (height) => ({ height, layout: { background: { color: "#0b0e13" }, textColor: "#8a93a3", fontFamily: "IBM Plex Mono" }, grid: { vertLines: { color: "#161c26" }, horzLines: { color: "#161c26" } }, rightPriceScale: { borderColor: "#232b38" }, timeScale: { borderColor: "#232b38" }, crosshair: { mode: 0 } });
  const ch = LightweightCharts.createChart(el, { ...opts(340), width: el.clientWidth });
  const cs = ch.addCandlestickSeries({ upColor: "#22c38e", downColor: "#f0565b", borderVisible: false, wickUpColor: "#22c38e", wickDownColor: "#f0565b" });
  cs.setData(h.t.map((t, i) => ({ time: t, open: h.o[i], high: h.h[i], low: h.l[i], close: h.c[i] })));
  const line = (arr, color, w = 1) => { const s = ch.addLineSeries({ color, lineWidth: w, priceLineVisible: false, lastValueVisible: false }); s.setData(h.t.map((t, i) => arr[i] == null ? { time: t } : { time: t, value: arr[i] })); };
  line(h.e20, "#f2b33d"); line(h.e50, "#5b8cff"); line(h.e200, "#9b7bff", 2);
  const st = ch.addLineSeries({ lineWidth: 2, lineStyle: 2, priceLineVisible: false, lastValueVisible: false });
  st.setData(h.t.map((t, i) => h.st[i] == null ? { time: t } : { time: t, value: h.st[i], color: h.sd[i] === 1 ? "#22c38e" : "#f0565b" }));
  ch.timeScale().fitContent();
  const rc = LightweightCharts.createChart(el2, { ...opts(120), width: el2.clientWidth });
  const rs = rc.addLineSeries({ color: "#9b7bff", lineWidth: 1, priceLineVisible: false });
  rs.setData(h.t.map((t, i) => h.rsi[i] == null ? { time: t } : { time: t, value: h.rsi[i] }));
  [70, 30].forEach((p) => rs.createPriceLine({ price: p, color: "#3a4352", lineStyle: 2, lineWidth: 1, axisLabelVisible: false }));
  rc.timeScale().fitContent();
  ch.timeScale().subscribeVisibleLogicalRangeChange((r) => r && rc.timeScale().setVisibleLogicalRange(r));
  S.chart = ch; S.rsiChart = rc;
}
$("closeDrawer").onclick = () => ($("drawer").hidden = true);
$("drawer").addEventListener("click", (e) => { if (e.target.id === "drawer") $("drawer").hidden = true; });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("drawer").hidden = true; });
window.addEventListener("resize", () => { if (S.chart) S.chart.applyOptions({ width: $("chart").clientWidth }); if (S.rsiChart) S.rsiChart.applyOptions({ width: $("rsiChart").clientWidth }); });

/* ---------------- method page ---------------- */
const METHOD = `
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
<p>A bucket with no data (e.g. volume on some indices, quality on ETFs) is dropped and the weights re-normalised. Market regime (S&amp;P 500 vs 200-day EMA, VIX, DXY, 10Y yield, gold; BTC trend, Fear &amp; Greed, BTC dominance) is shown on top as context rather than mixed into individual scores.</p>
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
<tr><td>"Forecast" cycle turning dates</td><td class="drop">Not reproducible</td><td>Proprietary and unverifiable; cycle-date prediction has no reliable published evidence.</td></tr>
<tr><td>VWAP, order book, liquidations, on-chain, mempool</td><td class="drop">Out of scope</td><td>Intraday or paid data feeds; not meaningful on a daily screener.</td></tr>
<tr><td>Funding rate, long/short ratio</td><td class="keep">Kept (crypto, live)</td><td>Crowding gauges, fetched live from Binance in your browser; shown as context.</td></tr>
<tr><td>Fear &amp; Greed, BTC dominance, VIX, DXY, 10Y, gold, indices</td><td class="keep">Kept (regime bar)</td><td>Market backdrop.</td></tr>
<tr><td>Piotroski F, Altman Z</td><td class="keep">Kept (stocks)</td><td>Quality / distress filter.</td></tr>
</table>
<h2>Limits</h2>
<ul><li>No indicator set is "accurate" in the sense of reliably predicting the next move. The goal is to rank assets so the odds lean your way, then manage risk with the ATR stop.</li>
<li>Daily bars from Yahoo Finance via GitHub Actions; can lag or have gaps. Fundamentals refresh weekly.</li>
<li>Research tool only — not investment advice.</li></ul>`;

load();
