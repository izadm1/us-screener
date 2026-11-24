/* Live prices + live re-forecasting.
 * - Crypto: Binance public prices every 5 s (no key).
 * - US stocks/ETFs + forex: Finnhub websocket (key stored only in this browser).
 * - Every tick rebuilds the asset's latest daily bar and re-computes the model's factors, so the
 *   forecast, signal and trade plan follow the live price. Factor maths mirrors scripts/model.py.
 * - The page also re-loads the server snapshot whenever a newer one is published (every ~15 min).
 */
const LIVE = { hist: {}, base: {}, dirty: false, lastTick: {}, ws: null, wsSyms: new Set(), status: { crypto: "off", fh: "off" } };
const FH_KEY_NAME = "fh_key";
function fhKey() { try { return localStorage.getItem(FH_KEY_NAME) || ""; } catch (e) { return ""; } }
(function captureKeyFromLink() { // one-time link: …/multi/#fh=KEY  -> saved locally, removed from the address bar
  const m = location.hash.match(/fh=([A-Za-z0-9]+)/);
  if (m) { try { localStorage.setItem(FH_KEY_NAME, m[1]); } catch (e) {} history.replaceState(null, "", location.pathname + location.search); }
})();

/* ---------- history cache (server bars, patched with the live bar) ---------- */
async function loadBase(sym) {
  if (!LIVE.base[sym]) LIVE.base[sym] = await (await fetch(`data/history/${safe(sym)}.json?g=${encodeURIComponent(S.data.generated)}`)).json();
  return LIVE.base[sym];
}
async function getHist(sym) { return LIVE.hist[sym] || (await loadBase(sym)); }

/* ---------- indicator maths (ports of indicators.py / model.py) ---------- */
function ewmRec(arr, alpha) { const out = new Array(arr.length); let m = null; for (let i = 0; i < arr.length; i++) { const v = arr[i]; if (v == null || Number.isNaN(v)) { out[i] = m; continue; } m = m == null ? v : m + alpha * (v - m); out[i] = m; } return out; }
function rsiArr(c, n) { const up = [null], dn = [null]; for (let i = 1; i < c.length; i++) { const d = c[i] - c[i - 1]; up.push(Math.max(d, 0)); dn.push(Math.max(-d, 0)); } const au = ewmRec(up, 1 / n), ad = ewmRec(dn, 1 / n); return au.map((u, i) => (u == null || ad[i] == null ? null : ad[i] === 0 ? 100 : 100 - 100 / (1 + u / ad[i]))); }
function atrArr(H, L, C, n) { const tr = H.map((h, i) => (i === 0 ? h - L[i] : Math.max(h - L[i], Math.abs(h - C[i - 1]), Math.abs(L[i] - C[i - 1])))); tr[0] = null; return ewmRec(tr, 1 / n); }
function adxLast(H, L, C, n = 14) {
  const pdm = [null], mdm = [null];
  for (let i = 1; i < H.length; i++) { const up = H[i] - H[i - 1], dn = L[i - 1] - L[i]; pdm.push(up > dn && up > 0 ? up : 0); mdm.push(dn > up && dn > 0 ? dn : 0); }
  const a = atrArr(H, L, C, n), sp = ewmRec(pdm, 1 / n), sm = ewmRec(mdm, 1 / n);
  const pdi = sp.map((v, i) => (v == null || !a[i] ? null : 100 * v / a[i])), mdi = sm.map((v, i) => (v == null || !a[i] ? null : 100 * v / a[i]));
  const dx = pdi.map((p, i) => (p == null || mdi[i] == null || p + mdi[i] === 0 ? null : 100 * Math.abs(p - mdi[i]) / (p + mdi[i])));
  const ad = ewmRec(dx, 1 / n), k = H.length - 1;
  return { adx: ad[k], pdi: pdi[k], mdi: mdi[k], atr: a[k] };
}
function supertrendLast(H, L, C, n = 10, mult = 3) {
  const a = atrArr(H, L, C, n), N = C.length;
  const ub = H.map((h, i) => (a[i] == null ? NaN : (h + L[i]) / 2 + mult * a[i])), lb = H.map((h, i) => (a[i] == null ? NaN : (h + L[i]) / 2 - mult * a[i]));
  const fu = ub.slice(), fl = lb.slice(); let dir = 1, stop = NaN;
  for (let i = 1; i < N; i++) {
    if (Number.isNaN(ub[i]) || Number.isNaN(fu[i - 1])) continue;
    fu[i] = ub[i] < fu[i - 1] || C[i - 1] > fu[i - 1] ? ub[i] : fu[i - 1];
    fl[i] = lb[i] > fl[i - 1] || C[i - 1] < fl[i - 1] ? lb[i] : fl[i - 1];
    dir = dir === 1 ? (C[i] < fl[i] ? -1 : 1) : C[i] > fu[i] ? 1 : -1;
    stop = dir === 1 ? fl[i] : fu[i];
  }
  return { dir, stop };
}
function liveFactors(b) {
  const C = b.c, n = C.length, lc = C.map(Math.log), last = n - 1;
  const r = []; for (let i = 1; i < n; i++) r.push(lc[i] - lc[i - 1]);
  const ew = ewmRec(r.map((x) => x * x), 0.06)[r.length - 1];
  const w = r.slice(-252); let rv = null;
  if (w.length >= 60) { const m = w.reduce((s, x) => s + x, 0) / w.length; rv = w.reduce((s, x) => s + (x - m) ** 2, 0) / (w.length - 1); }
  const vol = Math.max(1e-4, Math.sqrt(0.5 * ew + 0.5 * (rv ?? ew)));
  const cl = (x) => Math.max(-5, Math.min(5, x));
  const rsi = rsiArr(C, 14)[last];
  const w20 = C.slice(-20), m20 = w20.reduce((s, x) => s + x, 0) / 20, sd20 = Math.sqrt(w20.reduce((s, x) => s + (x - m20) ** 2, 0) / 20);
  const st = supertrendLast(b.h, b.l, C), dmi = adxLast(b.h, b.l, C);
  const e200 = b.e200[last], e50 = b.e50[last];
  const f = {
    tr200: e200 ? cl((lc[last] - Math.log(e200)) / (vol * Math.sqrt(200))) : null,
    m63: n > 63 ? cl((lc[last] - lc[last - 63]) / (vol * Math.sqrt(63))) : null,
    m12_1: n > 252 ? cl((lc[last - 21] - lc[last - 252]) / (vol * Math.sqrt(231))) : 0,
    r5: n > 5 ? cl((lc[last] - lc[last - 5]) / (vol * Math.sqrt(5))) : null,
    rsi: rsi == null ? null : cl((rsi - 50) / 25),
    z20: sd20 ? cl((C[last] - m20) / sd20) : 0,
    st: st.dir,
    adx: dmi.adx == null ? 0 : cl(Math.max(0, Math.min(3, dmi.adx / 25)) * Math.sign(dmi.pdi - dmi.mdi)),
    e50: e50 && e200 ? Math.sign(e50 - e200) : 0,
  };
  return { f, vol, rsi, z20: sd20 ? (C[last] - m20) / sd20 : 0, st, dmi, e200, e50 };
}

/* ---------- apply a live price to one asset ---------- */
const exchDate = (cls) => { // trading date of "now" for the asset's own calendar
  const tz = cls === "crypto" || cls === "forex" ? "UTC" : "America/New_York";
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
};
async function applyLive(r, price, ts) {
  if (!r || !(price > 0)) return;
  let base;
  try { base = await loadBase(r.sym); } catch (e) { return; }
  const n = base.t.length, lastD = isoD(base.t[n - 1] * 1000), today = exchDate(r._cls);
  const b = { t: base.t.slice(), o: base.o.slice(), h: base.h.slice(), l: base.l.slice(), c: base.c.slice(), v: base.v.slice(), e20: base.e20.slice(), e50: base.e50.slice(), e200: base.e200.slice(), st: base.st.slice(), sd: base.sd.slice(), rsi: base.rsi.slice(), mh: base.mh.slice() };
  let prevIdx;
  if (today > lastD && !(r._cls !== "crypto" && [0, 6].includes(new Date(parseD(today)).getUTCDay()))) {
    b.t.push(parseD(today) / 1000); b.o.push(b.c[n - 1]); b.h.push(Math.max(b.c[n - 1], price)); b.l.push(Math.min(b.c[n - 1], price)); b.c.push(price); b.v.push(0);
    ["e20", "e50", "e200", "st", "rsi", "mh"].forEach((k) => b[k].push(null)); b.sd.push(b.sd[n - 1]);
    prevIdx = n - 1;
  } else {
    const k = n - 1;
    b.h[k] = Math.max(b.h[k], price); b.l[k] = Math.min(b.l[k], price); b.c[k] = price;
    prevIdx = n - 2;
  }
  const L = b.c.length - 1;
  const upd = (key, span) => { const p = b[key][prevIdx]; b[key][L] = p == null ? b[key][L] : p + (2 / (span + 1)) * (price - p); };
  upd("e20", 20); upd("e50", 50); upd("e200", 200);
  const lf = liveFactors(b);
  b.rsi[L] = lf.rsi; b.st[L] = lf.st.stop; b.sd[L] = lf.st.dir;
  // model: mz per horizon from the group's coefficients
  const st = ((S.data.model || {})[r.fc && r.fc.grp] || {}).h || {};
  const mz = {};
  Object.entries(st).forEach(([h, v]) => {
    if (!v.coef) return;
    let p = v.coef.const;
    for (const [k, c] of Object.entries(v.coef)) if (k !== "const") p += c * (lf.f[k] ?? 0);
    mz[h] = v.k * (p - (v.off || 0));
  });
  LIVE.hist[r.sym] = b;
  r.price = price;
  r.chg1d = price / b.c[L - 1] - 1;
  r.rsi14 = lf.rsi ?? r.rsi14; r.z20 = lf.z20; r.st_dir = lf.st.dir; r.st_stop = lf.st.stop;
  if (lf.e200) r.above200 = price > lf.e200;
  if (lf.e50 && lf.e200) r.golden = lf.e50 > lf.e200;
  if (lf.dmi.atr) r.atr_pct = lf.dmi.atr / price;
  r.date = isoD(b.t[L] * 1000);
  if (r.fc) { r.fc.p0 = price; r.fc.asof = r.date; r.fc.sigma = lf.vol; if (Object.keys(mz).length) r.fc.mz = mz; }
  r._live = ts || Date.now();
  LIVE.lastTick[r._cls] = Date.now();
  LIVE.dirty = true;
}
const bySym = () => { const m = {}; Object.values(S.data.classes).forEach((l) => l.forEach((r) => (m[r.sym] = r))); return m; };

/* ---------- crypto: Binance REST, every 5 s ---------- */
const BIN_MAP = { RNDR: "RENDER" };
async function pollCrypto() {
  if (!S.data) return;
  const list = S.data.classes.crypto || [];
  for (const host of ["https://data-api.binance.vision", "https://api.binance.com"]) {
    try {
      const j = await (await fetch(`${host}/api/v3/ticker/price`)).json();
      if (!Array.isArray(j)) continue;
      const px = {}; j.forEach((x) => (px[x.symbol] = +x.price));
      let n = 0;
      for (const r of list) { const p = px[(BIN_MAP[r.name] || r.name) + "USDT"]; if (p) { await applyLive(r, p); n++; } }
      LIVE.status.crypto = n ? "live" : "off";
      return;
    } catch (e) { /* try next host */ }
  }
  LIVE.status.crypto = "error";
}

/* ---------- stocks / ETFs / forex: Finnhub websocket ---------- */
const fhSym = (r) => (r._cls === "forex" ? "OANDA:" + r.label.replace("/", "_") : r.sym.replace("-", "."));
function wantedFh() {
  const want = [];
  const add = (r) => { if (r && ["stocks", "etfs", "forex"].includes(r._cls) && want.length < 50 && !want.includes(fhSym(r))) want.push(fhSym(r)); };
  const m = bySym();
  if (S.openSym) add(m[S.openSym]);
  if (TV && TV.sym) add(m[TV.sym]);
  (S.data.classes.forex || []).forEach(add);
  [...document.querySelectorAll("#tbl tbody tr[data-s]")].forEach((tr) => add(m[tr.dataset.s]));
  document.querySelectorAll(".pk[data-s]").forEach((el) => add(m[el.dataset.s]));
  (S.data.classes.stocks || []).forEach(add);
  return want;
}
function syncFhSubs() {
  const ws = LIVE.ws;
  if (!ws || ws.readyState !== 1) return;
  const want = new Set(wantedFh());
  LIVE.wsSyms.forEach((s) => { if (!want.has(s)) { ws.send(JSON.stringify({ type: "unsubscribe", symbol: s })); LIVE.wsSyms.delete(s); } });
  want.forEach((s) => { if (!LIVE.wsSyms.has(s)) { ws.send(JSON.stringify({ type: "subscribe", symbol: s })); LIVE.wsSyms.add(s); } });
}
function connectFh() {
  const key = fhKey();
  if (!key || !S.data) { LIVE.status.fh = key ? "off" : "nokey"; return; }
  try { if (LIVE.ws) LIVE.ws.close(); } catch (e) {}
  const ws = new WebSocket(`wss://ws.finnhub.io?token=${key}`);
  LIVE.ws = ws; LIVE.wsSyms = new Set(); LIVE.status.fh = "connecting";
  const map = {}; Object.values(S.data.classes).forEach((l) => l.forEach((r) => { if (["stocks", "etfs", "forex"].includes(r._cls)) map[fhSym(r)] = r; }));
  ws.onopen = () => { LIVE.status.fh = "live"; syncFhSubs(); };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.type === "trade" && m.data) {
      const last = {}; m.data.forEach((d) => (last[d.s] = d));
      Object.values(last).forEach((d) => applyLive(map[d.s], d.p, d.t));
    } else if (m.type === "error") { LIVE.status.fh = "error: " + (m.msg || ""); }
  };
  ws.onclose = () => { if (LIVE.ws === ws) { LIVE.status.fh = "reconnecting"; setTimeout(connectFh, 5000); } };
}

/* ---------- re-render loop + status badge ---------- */
function liveBadge() {
  const el = document.getElementById("liveBadge");
  if (!el) return;
  const ago = (c) => { const t = LIVE.lastTick[c]; return t ? Math.round((Date.now() - t) / 1000) + "s" : "–"; };
  const dot = (ok) => `<i class="dot ${ok ? "on" : ""}"></i>`;
  const fh = LIVE.status.fh;
  el.innerHTML = `${dot(LIVE.status.crypto === "live")}Crypto ${LIVE.status.crypto === "live" ? "live · " + ago("crypto") : LIVE.status.crypto}
    <span class="sep">|</span>${dot(fh === "live")}Stocks/ETFs/FX ${fh === "live" ? "live · " + (LIVE.lastTick.stocks || LIVE.lastTick.etfs || LIVE.lastTick.forex ? Math.round((Date.now() - Math.max(LIVE.lastTick.stocks || 0, LIVE.lastTick.etfs || 0, LIVE.lastTick.forex || 0)) / 1000) + "s" : "waiting for trades") : fh === "nokey" ? '<a href="#" id="setKey">add Finnhub key</a>' : fh}
    <span class="sep">|</span>Model snapshot ${new Date(S.data.generated).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
  const sk = document.getElementById("setKey");
  if (sk) sk.onclick = (e) => { e.preventDefault(); openKeyBox(); };
}
function openKeyBox() {
  let box = document.getElementById("keyBox");
  if (!box) {
    box = document.createElement("div"); box.id = "keyBox"; box.className = "keybox";
    box.innerHTML = `<b>Finnhub API key</b><p class="note">Stored only in this browser (never in the website code). Enables live US stock, ETF and forex prices.</p><input id="keyIn" type="password" placeholder="paste key"><button id="keySave">Save</button><button id="keyClear">Remove</button>`;
    document.body.appendChild(box);
    box.querySelector("#keySave").onclick = () => { try { localStorage.setItem(FH_KEY_NAME, box.querySelector("#keyIn").value.trim()); } catch (e) {} box.remove(); connectFh(); };
    box.querySelector("#keyClear").onclick = () => { try { localStorage.removeItem(FH_KEY_NAME); } catch (e) {} box.remove(); if (LIVE.ws) LIVE.ws.close(); LIVE.ws = null; LIVE.status.fh = "nokey"; };
  }
}
let lastDeep = 0;
setInterval(() => {
  liveBadge();
  if (!LIVE.dirty || !S.data) return;
  LIVE.dirty = false;
  Object.keys(PBAR).forEach((k) => delete PBAR[k]);
  if (!$("screen").hidden) render();
  if (!$("picks").hidden && Date.now() - lastDeep > 10000) { renderPicks(); lastDeep = Date.now(); }
  if (Date.now() - lastDeep > 8000) {
    if (!$("drawer").hidden && S.openSym) openDetail(S.openSym, true);
    if (S.view === "tech" && TV.sym && !$("tv").hidden) drawTV(TV.sym);
    lastDeep = Date.now();
  }
}, 1500);
setInterval(syncFhSubs, 4000);

/* ---------- pick up a newer server snapshot (model refresh) without reloading the page ---------- */
async function refreshSnapshot() {
  try {
    const d = await (await fetch("data/screener.json?" + Date.now(), { cache: "no-store" })).json();
    if (!S.data || d.generated === S.data.generated) return;
    const live = {}; Object.values(S.data.classes).forEach((l) => l.forEach((r) => { if (r._live) live[r.sym] = r.price; }));
    S.data = d; LIVE.base = {}; LIVE.hist = {};
    try { S.sig = await (await fetch("data/signals.json?" + Date.now(), { cache: "no-store" })).json(); } catch (e) {}
    Object.entries(S.data.classes).forEach(([c, list]) => list.forEach((x) => (x._cls = c)));
    renderRegime();
    for (const [s, p] of Object.entries(live)) await applyLive(bySym()[s], p);
    LIVE.dirty = true;
    if (LIVE.ws) connectFh();
  } catch (e) { /* offline */ }
}
setInterval(refreshSnapshot, 5 * 60 * 1000);

/* ---------- start once the snapshot has loaded ---------- */
(function waitData() {
  if (!S.data) return setTimeout(waitData, 300);
  if (!fhKey()) LIVE.status.fh = "nokey";
  pollCrypto(); setInterval(pollCrypto, 5000);
  connectFh();
})();
