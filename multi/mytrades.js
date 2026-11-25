/* My trades — record trades you take on any platform and monitor them with live prices.
   Stored in this browser (localStorage). Optional sync across devices via a private GitHub gist. */
(function () {
  const KEY = "myTrades.v1", GHKEY = "myTrades.gh", GIST_DESC = "my-trades-sync (screener)", FILE = "my-trades.json";
  const $$ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const px = (v) => (typeof fmt !== "undefined" ? fmt.px(v) : (+v).toFixed(4));
  const num = (v) => { const n = parseFloat(String(v).replace(/,/g, "")); return isFinite(n) ? n : null; };
  const rp = (v) => (v == null ? "" : +(+v).toFixed(Math.abs(v) >= 20 ? 2 : Math.abs(v) >= 1 ? 4 : 6));
  const ccy = (t) => (t.cls === "forex" ? (t.label || "").split("/")[1] || "" : t.sym.endsWith(".KL") ? "MYR" : "USD");

  const MT = {
    trades: [], priceFn: null, symbolsFn: null, metaFn: null, onChange: null, notified: {},
    load() { try { const d = JSON.parse(localStorage.getItem(KEY) || "{}"); MT.trades = d.trades || []; } catch (e) { MT.trades = []; } },
    save(skipSync) { try { localStorage.setItem(KEY, JSON.stringify({ trades: MT.trades })); } catch (e) {} if (!skipSync) MT.queuePush(); if (MT.onChange) MT.onChange(); },
    list(status) { return MT.trades.filter((t) => !t.del && (!status || t.status === status)); },
    openFor(sym) { return MT.list("open").filter((t) => t.sym === sym); },
    upsert(t) { t.u = Date.now(); const i = MT.trades.findIndex((x) => x.id === t.id); if (i >= 0) MT.trades[i] = t; else MT.trades.push(t); MT.save(); },
    remove(id) { const t = MT.trades.find((x) => x.id === id); if (t) { t.del = true; t.u = Date.now(); MT.save(); } },
    price(t) { const p = MT.priceFn && MT.priceFn(t.sym); return p > 0 ? p : null; },
    // live stats for a trade
    calc(t, p) {
      const exit = t.status === "closed" ? t.exit : p;
      if (!(exit > 0)) return {};
      const move = t.side * (exit - t.entry), pct = move / t.entry;
      const risk = t.stop ? Math.abs(t.entry - t.stop) : null, R = risk ? move / risk : null;
      const money = t.qty ? move * t.qty : null;
      let state = "open";
      if (t.status === "open") {
        if (t.target && (t.side > 0 ? exit >= t.target : exit <= t.target)) state = "target";
        else if (t.stop && (t.side > 0 ? exit <= t.stop : exit >= t.stop)) state = "stop";
        else if (R != null && R <= -0.75) state = "nearStop";
        else if (R != null && t.target && R >= 0.75 * (Math.abs(t.target - t.entry) / risk)) state = "nearTarget";
      }
      return { exit, move, pct, R, money, state };
    },
  };
  window.MT = MT;
  MT.load();

  /* ---------------- toast + notifications ---------------- */
  function toast(msg, cls) {
    let box = $$("mtToasts"); if (!box) { box = document.createElement("div"); box.id = "mtToasts"; document.body.appendChild(box); }
    const el = document.createElement("div"); el.className = "mttoast " + (cls || ""); el.innerHTML = msg; box.appendChild(el);
    setTimeout(() => el.remove(), 9000);
  }
  MT.toast = toast;
  MT.checkAlerts = function () {
    MT.list("open").forEach((t) => {
      const c = MT.calc(t, MT.price(t)); if (!c.state) return;
      const k = t.id + "|" + c.state, prev = MT.notified[t.id];
      if ((c.state === "target" || c.state === "stop") && prev !== k) {
        MT.notified[t.id] = k;
        const msg = `${c.state === "target" ? "🎯 Target reached" : "✕ Stop reached"} — ${t.label || t.sym} ${t.side > 0 ? "BUY" : "SELL"} at ${px(c.exit)} (${c.R != null ? (c.R >= 0 ? "+" : "") + c.R.toFixed(2) + "R" : (c.pct * 100).toFixed(2) + "%"})`;
        toast(msg + ` <a href="index.html?tab=mine">Review →</a>`, c.state === "target" ? "g" : "r");
        try { if (window.Notification && Notification.permission === "granted") new Notification("My trades", { body: msg }); } catch (e) {}
      } else if (c.state !== "target" && c.state !== "stop") MT.notified[t.id] = null;
    });
  };

  /* ---------------- record / edit form ---------------- */
  const nowLocal = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
  const toLocal = (iso) => { const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
  function modal(html) {
    let m = $$("mtModal"); if (m) m.remove();
    m = document.createElement("div"); m.id = "mtModal"; m.className = "mtmodal";
    m.innerHTML = `<div class="mtbox">${html}</div>`;
    m.onclick = (e) => { if (e.target === m) m.remove(); };
    document.body.appendChild(m); return m;
  }
  // opts: {sym,label,cls,side,stop,target,src,entry} or {edit:id}
  MT.form = function (opts) {
    opts = opts || {};
    const ed = opts.edit ? MT.trades.find((x) => x.id === opts.edit) : null;
    const t = ed ? { ...ed } : { side: opts.side || 1, sym: opts.sym || "", label: opts.label || opts.sym || "", cls: opts.cls || "", stop: opts.stop || null, target: opts.target || null, src: opts.src || "", entry: opts.entry || null };
    const live = t.sym ? MT.price(t) : null;
    const syms = MT.symbolsFn ? MT.symbolsFn() : [];
    const lastPlat = localStorage.getItem("myTrades.platform") || "";
    const m = modal(`<div class="mthead"><b>${ed ? "Edit trade" : "Record a trade I took"}</b><button class="mtx" data-x>✕</button></div>
      <p class="note" style="margin:0 0 10px">Record a position you opened on any platform. It is then monitored here with live prices${t.src ? ` · from signal: <b>${esc(t.src)}</b>` : ""}.</p>
      <div class="mtgrid">
        <label class="full">Asset <input id="mfSym" list="mfSyms" value="${esc(t.label || t.sym)}" placeholder="e.g. NVDA, BTC-USD, EUR/USD" ${ed || opts.sym ? "readonly" : ""}></label>
        <datalist id="mfSyms">${syms.map((s) => `<option value="${esc(s.label)}">${esc(s.name || "")}</option>`).join("")}</datalist>
        <div class="full mtside"><button data-side="1" class="${t.side > 0 ? "on b" : ""}">BUY / long</button><button data-side="-1" class="${t.side < 0 ? "on s" : ""}">SELL / short</button></div>
        <label>Entry price <input id="mfEntry" inputmode="decimal" value="${t.entry != null ? t.entry : live != null ? rp(live) : ""}"><span class="hint">${live != null ? `live now ${px(live)}` : ""}</span></label>
        <label>Quantity <input id="mfQty" inputmode="decimal" value="${t.qty != null ? t.qty : ""}" placeholder="shares / coins / units"></label>
        <label>Stop loss <input id="mfStop" inputmode="decimal" value="${t.stop != null ? rp(t.stop) : ""}" placeholder="optional"></label>
        <label>Target <input id="mfTgt" inputmode="decimal" value="${t.target != null ? rp(t.target) : ""}" placeholder="optional"></label>
        <label>Opened <input id="mfDate" type="datetime-local" value="${ed ? toLocal(t.opened) : nowLocal()}"></label>
        <label>Platform <input id="mfPlat" value="${esc(ed ? t.platform || "" : lastPlat)}" placeholder="e.g. IBKR, Moomoo, Binance"></label>
        <label class="full">Note <input id="mfNote" value="${esc(t.note || "")}" placeholder="optional"></label>
      </div>
      <div class="mtrisk" id="mfRisk"></div>
      <div class="mtbtns"><button class="mtprimary" id="mfSave">${ed ? "Save changes" : "Start tracking"}</button><button data-x>Cancel</button></div>`);
    let side = t.side;
    const risk = () => {
      const e = num($$("mfEntry").value), s = num($$("mfStop").value), g = num($$("mfTgt").value), q = num($$("mfQty").value);
      const parts = [];
      if (e && s) { const r = Math.abs(e - s); parts.push(`Risk ${(r / e * 100).toFixed(2)}% per unit${q ? ` = <b>${px(r * q)}</b> total` : ""}`); if (side * (s - e) > 0) parts.push(`<span class="down">⚠ stop is on the wrong side of entry for a ${side > 0 ? "BUY" : "SELL"}</span>`); }
      if (e && s && g) parts.push(`reward : risk = <b>${(Math.abs(g - e) / Math.abs(e - s)).toFixed(2)}</b>`);
      if (e && q) parts.push(`position value ${px(e * q)}`);
      $$("mfRisk").innerHTML = parts.join(" · ");
    };
    m.querySelectorAll("[data-side]").forEach((b) => (b.onclick = () => { side = +b.dataset.side; m.querySelectorAll("[data-side]").forEach((x) => (x.className = +x.dataset.side === side ? "on " + (side > 0 ? "b" : "s") : "")); risk(); }));
    m.querySelectorAll("input").forEach((i) => (i.oninput = risk)); risk();
    m.querySelectorAll("[data-x]").forEach((b) => (b.onclick = () => m.remove()));
    $$("mfSave").onclick = () => {
      let sym = t.sym, label = t.label, cls = t.cls;
      if (!ed && !opts.sym) {
        const v = $$("mfSym").value.trim(); const hit = syms.find((s) => s.label.toUpperCase() === v.toUpperCase() || s.sym.toUpperCase() === v.toUpperCase());
        if (!v) return alertBox("Enter the asset.");
        sym = hit ? hit.sym : v.toUpperCase(); label = hit ? hit.label : v.toUpperCase(); cls = hit ? hit.cls : "";
      }
      const entry = num($$("mfEntry").value); if (!(entry > 0)) return alertBox("Enter the entry price you got.");
      const stop = num($$("mfStop").value), target = num($$("mfTgt").value);
      if (stop && side * (stop - entry) >= 0) return alertBox(`For a ${side > 0 ? "BUY the stop must be below" : "SELL the stop must be above"} the entry price.`);
      if (target && side * (target - entry) <= 0) return alertBox(`For a ${side > 0 ? "BUY the target must be above" : "SELL the target must be below"} the entry price.`);
      const plat = $$("mfPlat").value.trim(); try { localStorage.setItem("myTrades.platform", plat); } catch (e) {}
      const out = Object.assign(ed || { id: "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), status: "open", src: t.src }, {
        sym, label, cls, side, entry, qty: num($$("mfQty").value), stop, target, opened: new Date($$("mfDate").value).toISOString(), platform: plat, note: $$("mfNote").value.trim(),
      });
      MT.upsert(out); m.remove();
      toast(`${ed ? "Saved" : "Now tracking"} ${esc(label)} ${side > 0 ? "BUY" : "SELL"} @ ${px(entry)} — <a href="index.html?tab=mine">My trades →</a>`, "g");
    };
    function alertBox(msg) { $$("mfRisk").innerHTML = `<span class="down">${msg}</span>`; }
  };
  MT.closeForm = function (id) {
    const t = MT.trades.find((x) => x.id === id); if (!t) return;
    const live = MT.price(t);
    const m = modal(`<div class="mthead"><b>Close ${esc(t.label || t.sym)} ${t.side > 0 ? "BUY" : "SELL"}</b><button class="mtx" data-x>✕</button></div>
      <p class="note" style="margin:0 0 10px">Entry ${px(t.entry)}${t.qty ? ` · qty ${t.qty}` : ""}. Enter the price you actually closed at.</p>
      <div class="mtgrid"><label>Exit price <input id="mcPx" inputmode="decimal" value="${live != null ? rp(live) : ""}"><span class="hint">${live != null ? `live now ${px(live)}` : ""}${t.stop ? ` · <a href="#" data-fill="${rp(t.stop)}">stop ${px(t.stop)}</a>` : ""}${t.target ? ` · <a href="#" data-fill="${rp(t.target)}">target ${px(t.target)}</a>` : ""}</span></label>
      <label>Closed <input id="mcDate" type="datetime-local" value="${nowLocal()}"></label></div>
      <div class="mtrisk" id="mcRes"></div>
      <div class="mtbtns"><button class="mtprimary" id="mcSave">Close trade</button><button data-x>Cancel</button></div>`);
    const res = () => { const e = num($$("mcPx").value); if (!e) return ($$("mcRes").innerHTML = ""); const c = MT.calc({ ...t, status: "closed", exit: e }); $$("mcRes").innerHTML = `Result: <b class="${c.move >= 0 ? "up" : "down"}">${c.pct >= 0 ? "+" : ""}${(c.pct * 100).toFixed(2)}%${c.R != null ? ` · ${c.R >= 0 ? "+" : ""}${c.R.toFixed(2)}R` : ""}${c.money != null ? ` · ${c.money >= 0 ? "+" : ""}${px(c.money)} ${ccy(t)}` : ""}</b>`; };
    $$("mcPx").oninput = res; res();
    m.querySelectorAll("[data-fill]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); $$("mcPx").value = a.dataset.fill; res(); }));
    m.querySelectorAll("[data-x]").forEach((b) => (b.onclick = () => m.remove()));
    $$("mcSave").onclick = () => { const e = num($$("mcPx").value); if (!(e > 0)) return; Object.assign(t, { status: "closed", exit: e, closed: new Date($$("mcDate").value).toISOString() }); MT.upsert(t); m.remove(); toast(`Closed ${esc(t.label || t.sym)} — recorded in your history.`, "g"); };
  };

  /* ---------------- the "My trades" page ---------------- */
  const dt = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "–");
  const sgn = (v, d = 2) => { const s = v.toFixed(d); return (/^-0\.0*$/.test(s) ? s.slice(1) : s).replace(/^(?!-)/, "+"); };
  MT.render = function (el) {
    const open = MT.list("open").sort((a, b) => b.opened.localeCompare(a.opened)), closed = MT.list("closed").sort((a, b) => (b.closed || "").localeCompare(a.closed || ""));
    const cs = closed.map((t) => ({ t, c: MT.calc(t) })), wins = cs.filter((x) => x.c.move > 0);
    const totR = cs.filter((x) => x.c.R != null).reduce((s, x) => s + x.c.R, 0), nR = cs.filter((x) => x.c.R != null).length;
    const money = {}; cs.forEach(({ t, c }) => { if (c.money != null) money[ccy(t)] = (money[ccy(t)] || 0) + c.money; });
    const gw = cs.filter((x) => x.c.money > 0).reduce((s, x) => s + x.c.money, 0), gl = -cs.filter((x) => x.c.money < 0).reduce((s, x) => s + x.c.money, 0);
    const gh = ghCfg();
    el.innerHTML = `<div class="mttop"><div><h2>My trades</h2><p class="note">Trades you took on any platform, monitored with live prices. Record one with <b>“+ I took this trade”</b> on any signal, or add it manually. ${gh.token ? `<span class="up">● Synced across your devices</span> <span class="mute" id="mtSyncSt"></span>` : `Saved in this browser only — <a href="#" id="mtSyncLink">turn on sync</a> to see them on your phone and computer.`}</p></div>
      <div class="mtacts"><button class="mtprimary" id="mtNew">+ New trade</button><button id="mtCsv">Export CSV</button><button id="mtBak">Backup</button><button id="mtRes">Restore</button><button id="mtSync">⟳ Sync</button><button id="mtNot">🔔 Alerts</button></div></div>
      <div class="metric tmet">
        <div class="m"><div class="l">Open trades</div><div class="v">${open.length}</div><div class="s" id="mtOpenSum">–</div></div>
        <div class="m"><div class="l">Closed trades</div><div class="v">${closed.length}</div><div class="s">${closed.length ? `win rate ${Math.round((wins.length / closed.length) * 100)}%` : "no history yet"}</div></div>
        <div class="m"><div class="l">Realised result</div><div class="v ${totR >= 0 ? "up" : "down"}">${nR ? sgn(totR) + "R" : "–"}</div><div class="s">${nR ? `avg ${sgn(totR / nR)}R per trade (with a stop)` : "R needs a stop loss"}</div></div>
        <div class="m"><div class="l">Realised P/L</div><div class="v ${Object.values(money).reduce((a, b) => a + b, 0) >= 0 ? "up" : "down"}" style="font-size:18px">${Object.keys(money).length ? Object.entries(money).map(([k, v]) => `${sgn(v)} ${k}`).join("<br>") : "–"}</div><div class="s">${gl ? `profit factor ${(gw / gl).toFixed(2)}` : "needs quantity"}</div></div>
      </div>
      <h3>Open (${open.length})</h3>
      ${open.length ? `<div class="tablewrap"><table class="trk mtt"><thead><tr><th>Asset</th><th>Side</th><th>Opened</th><th>Entry</th><th>Qty</th><th>Live price</th><th>Stop</th><th>Target</th><th>Stop ◂ progress ▸ Target</th><th>Live P/L</th><th>Status</th><th></th></tr></thead><tbody>
        ${open.map((t) => `<tr data-id="${t.id}" class="mtlive"><td><b>${esc(t.label || t.sym)}</b>${t.platform ? ` <span class="mute">${esc(t.platform)}</span>` : ""}${t.src || t.note ? `<div class="mute" style="font-size:11px">${esc([t.src, t.note].filter(Boolean).join(" · "))}</div>` : ""}</td><td class="${t.side > 0 ? "up" : "down"}"><b>${t.side > 0 ? "BUY" : "SELL"}</b></td><td>${dt(t.opened)}</td><td>${px(t.entry)}</td><td>${t.qty != null ? t.qty : "–"}</td><td class="mlpx"></td><td class="down">${t.stop ? px(t.stop) : "–"}</td><td class="up">${t.target ? px(t.target) : "–"}</td><td class="mlbar"></td><td class="mlpl"></td><td class="mlst"></td>
          <td class="mtrow"><button data-close="${t.id}">Close</button><button data-edit="${t.id}" title="Edit">✎</button><button data-del="${t.id}" title="Delete">🗑</button></td></tr>`).join("")}</tbody></table></div>`
        : `<p class="note">No open trades. Tap <b>“+ I took this trade”</b> on a signal (Top Picks, Track record, an asset's detail, or the Terminal), or <b>+ New trade</b> above.</p>`}
      <h3>History (${closed.length})</h3>
      ${closed.length ? `<div class="tablewrap"><table class="trk mtt"><thead><tr><th>Asset</th><th>Side</th><th>Opened</th><th>Closed</th><th>Entry</th><th>Exit</th><th>Qty</th><th>Result</th><th>P/L</th><th></th></tr></thead><tbody>
        ${cs.map(({ t, c }) => `<tr><td><b>${esc(t.label || t.sym)}</b>${t.platform ? ` <span class="mute">${esc(t.platform)}</span>` : ""}</td><td class="${t.side > 0 ? "up" : "down"}">${t.side > 0 ? "BUY" : "SELL"}</td><td>${dt(t.opened)}</td><td>${dt(t.closed)}</td><td>${px(t.entry)}</td><td>${px(t.exit)}</td><td>${t.qty != null ? t.qty : "–"}</td>
          <td class="${c.move >= 0 ? "up" : "down"}"><b>${c.move >= 0 ? "WIN" : "LOSS"}</b> ${sgn(c.pct * 100)}%${c.R != null ? ` · ${sgn(c.R)}R` : ""}</td><td class="${c.move >= 0 ? "up" : "down"}">${c.money != null ? `${sgn(c.money)} ${ccy(t)}` : "–"}</td>
          <td class="mtrow"><button data-reopen="${t.id}" title="Reopen">↺</button><button data-del="${t.id}" title="Delete">🗑</button></td></tr>`).join("")}</tbody></table></div>` : `<p class="note">Closed trades appear here with their result.</p>`}
      <input type="file" id="mtFile" accept=".json" hidden>`;
    const on = (id, f) => { const b = $$(id); if (b) b.onclick = (e) => { e.preventDefault(); f(); }; };
    on("mtNew", () => MT.form({}));
    on("mtCsv", exportCsv); on("mtBak", backup); on("mtRes", () => $$("mtFile").click());
    on("mtSync", syncSetup); on("mtSyncLink", syncSetup);
    on("mtNot", () => { try { Notification.requestPermission().then((p) => toast(p === "granted" ? "Alerts on: you'll be notified when a trade reaches its stop or target (while this site is open)." : "Notifications are blocked in this browser.", p === "granted" ? "g" : "r")); } catch (e) { toast("This browser doesn't support notifications.", "r"); } });
    $$("mtFile").onchange = restore;
    el.querySelectorAll("[data-close]").forEach((b) => (b.onclick = () => MT.closeForm(b.dataset.close)));
    el.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => MT.form({ edit: b.dataset.edit })));
    el.querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => { if (confirm("Delete this trade from your record? This can't be undone.")) MT.remove(b.dataset.del); }));
    el.querySelectorAll("[data-reopen]").forEach((b) => (b.onclick = () => { const t = MT.trades.find((x) => x.id === b.dataset.reopen); if (t) { t.status = "open"; delete t.exit; delete t.closed; MT.upsert(t); } }));
    MT.updLive(el);
  };
  MT.updLive = function (el) {
    let sumR = 0, nR = 0, up = 0, n = 0; const money = {};
    (el || document).querySelectorAll("tr.mtlive").forEach((tr) => {
      const t = MT.trades.find((x) => x.id === tr.dataset.id); if (!t) return;
      const p = MT.price(t), c = MT.calc(t, p); n++;
      if (!c.exit) { tr.querySelector(".mlpx").innerHTML = `<span class="mute">no price</span>`; return; }
      const r = typeof findRow === "function" ? findRow(t.sym) : null, age = r && r._live ? (Date.now() - r._live) / 1000 : null;
      tr.querySelector(".mlpx").innerHTML = `<b style="font-size:14px">${px(c.exit)}</b> <span class="ldot ${age != null && age < 120 ? "on" : ""}" title="${age != null && age < 120 ? "live" : "snapshot price"}"></span>`;
      if (t.stop && t.target) {
        const risk = Math.abs(t.entry - t.stop), Rm = Math.abs(t.target - t.entry) / risk, pos = Math.max(0, Math.min(1, (c.R + 1) / (Rm + 1))), ent = 1 / (Rm + 1);
        tr.querySelector(".mlbar").innerHTML = `<div class="pbar"><div class="pfill ${c.R >= 0 ? "g" : "r"}" style="left:${Math.min(pos, ent) * 100}%;width:${Math.abs(pos - ent) * 100}%"></div><div class="pent" style="left:${ent * 100}%"></div><div class="pnow" style="left:${pos * 100}%"></div></div><div class="mute" style="font-size:11px;display:flex;justify-content:space-between;gap:8px"><span>${((t.side * (t.stop - c.exit)) / c.exit * 100).toFixed(1)}% to stop</span><span>${((t.side * (t.target - c.exit)) / c.exit * 100 >= 0 ? "+" : "")}${((t.side * (t.target - c.exit)) / c.exit * 100).toFixed(1)}% to target</span></div>`;
      } else tr.querySelector(".mlbar").innerHTML = `<span class="mute" style="font-size:11px">${t.stop ? `${((t.side * (t.stop - c.exit)) / c.exit * 100).toFixed(1)}% to stop` : t.target ? `${((t.side * (t.target - c.exit)) / c.exit * 100).toFixed(1)}% to target` : "set a stop/target to see progress"}</span>`;
      tr.querySelector(".mlpl").innerHTML = `<b class="${c.move >= 0 ? "up" : "down"}">${sgn(c.pct * 100)}%</b>${c.R != null ? `<div class="${c.R >= 0 ? "up" : "down"}" style="font-size:11px">${sgn(c.R)}R</div>` : ""}${c.money != null ? `<div class="${c.money >= 0 ? "up" : "down"}" style="font-size:11px">${sgn(c.money)} ${ccy(t)}</div>` : ""}`;
      const days = Math.floor((Date.now() - new Date(t.opened)) / 864e5);
      tr.querySelector(".mlst").innerHTML = { target: `<span class="chip g">🎯 Target reached</span>`, stop: `<span class="chip r">✕ Stop reached</span>`, nearStop: `<span class="chip warn">Near stop</span>`, nearTarget: `<span class="chip g">Near target</span>` }[c.state] || `<span class="mute">Open · ${days}d</span>`;
      if (c.R != null) { sumR += c.R; nR++; } if (c.move > 0) up++; if (c.money != null) money[ccy(t)] = (money[ccy(t)] || 0) + c.money;
    });
    const s = $$("mtOpenSum"); if (s) s.innerHTML = n ? `${up} of ${n} in profit${nR ? ` · <b class="${sumR >= 0 ? "up" : "down"}">${sgn(sumR)}R</b>` : ""}${Object.keys(money).length ? " · " + Object.entries(money).map(([k, v]) => `<b class="${v >= 0 ? "up" : "down"}">${sgn(v)} ${k}</b>`).join(" ") : ""}` : "–";
    MT.checkAlerts();
  };

  /* ---------------- export / backup ---------------- */
  function download(name, text, type) { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }
  function exportCsv() {
    const rows = [["asset", "side", "status", "opened", "entry", "qty", "stop", "target", "closed", "exit", "pct", "R", "pnl", "ccy", "platform", "signal", "note"]];
    MT.list().forEach((t) => { const c = MT.calc(t, MT.price(t)); rows.push([t.label || t.sym, t.side > 0 ? "BUY" : "SELL", t.status, t.opened, t.entry, t.qty ?? "", t.stop ?? "", t.target ?? "", t.closed || "", t.status === "closed" ? t.exit : "", c.pct != null ? (c.pct * 100).toFixed(2) : "", c.R != null ? c.R.toFixed(2) : "", c.money != null ? c.money.toFixed(2) : "", ccy(t), t.platform || "", t.src || "", t.note || ""]); });
    download(`my-trades-${new Date().toISOString().slice(0, 10)}.csv`, rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n"), "text/csv");
  }
  function backup() { download(`my-trades-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ trades: MT.trades }, null, 1), "application/json"); }
  function restore(e) {
    const f = e.target.files[0]; if (!f) return;
    f.text().then((txt) => { try { const d = JSON.parse(txt); merge(d.trades || []); MT.save(); toast(`Restored ${(d.trades || []).length} trades.`, "g"); } catch (er) { toast("That file isn't a trades backup.", "r"); } });
  }
  function merge(list) { list.forEach((x) => { const i = MT.trades.findIndex((y) => y.id === x.id); if (i < 0) MT.trades.push(x); else if ((x.u || 0) > (MT.trades[i].u || 0)) MT.trades[i] = x; }); }

  /* ---------------- optional sync across devices (private GitHub gist) ---------------- */
  function ghCfg() { try { return JSON.parse(localStorage.getItem(GHKEY) || "{}"); } catch (e) { return {}; } }
  function ghSet(c) { try { localStorage.setItem(GHKEY, JSON.stringify(c)); } catch (e) {} }
  async function gh(path, method, body) {
    const c = ghCfg(); const r = await fetch("https://api.github.com" + path, { method: method || "GET", headers: { Authorization: "Bearer " + c.token, Accept: "application/vnd.github+json", ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
    if (!r.ok) throw new Error(r.status === 401 ? "token rejected" : "GitHub error " + r.status);
    return r.json();
  }
  async function findGist() {
    const c = ghCfg(); if (c.gist) return c.gist;
    for (let page = 1; page <= 5; page++) { const l = await gh(`/gists?per_page=100&page=${page}`); const g = l.find((x) => x.description === GIST_DESC && x.files[FILE]); if (g) { ghSet({ ...c, gist: g.id }); return g.id; } if (l.length < 100) break; }
    return null;
  }
  MT.pull = async function () {
    const c = ghCfg(); if (!c.token) return;
    try {
      const id = await findGist(); if (!id) return MT.push();
      const g = await gh("/gists/" + id); const f = g.files[FILE];
      let content = f.content; if (f.truncated) content = await (await fetch(f.raw_url)).text();
      const before = JSON.stringify(MT.trades); merge((JSON.parse(content || "{}").trades) || []);
      if (JSON.stringify(MT.trades) !== before) { MT.save(true); }
      if (JSON.stringify(MT.trades) !== content) { const d = JSON.parse(content || "{}"); if (JSON.stringify(d.trades || []) !== JSON.stringify(MT.trades)) MT.queuePush(); }
      syncSt("synced " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    } catch (e) { syncSt("sync failed: " + e.message); }
  };
  let pushT = null;
  MT.queuePush = function () { if (!ghCfg().token) return; clearTimeout(pushT); pushT = setTimeout(MT.push, 1200); };
  MT.push = async function () {
    const c = ghCfg(); if (!c.token) return;
    try {
      const files = { [FILE]: { content: JSON.stringify({ trades: MT.trades }) } };
      const id = await findGist();
      if (id) await gh("/gists/" + id, "PATCH", { files });
      else { const g = await gh("/gists", "POST", { description: GIST_DESC, public: false, files }); ghSet({ ...ghCfg(), gist: g.id }); }
      syncSt("synced " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    } catch (e) { syncSt("sync failed: " + e.message); }
  };
  function syncSt(s) { const el = $$("mtSyncSt"); if (el) el.textContent = "· " + s; }
  function syncSetup() {
    const c = ghCfg();
    const m = modal(`<div class="mthead"><b>Sync my trades across devices</b><button class="mtx" data-x>✕</button></div>
      <p class="note">Your trades are kept in a <b>private</b> GitHub gist on your own account, so the same list shows on your phone and computer. One-time setup on each device:</p>
      <ol class="note" style="padding-left:18px;margin:6px 0 10px"><li><a href="https://github.com/settings/tokens/new?scopes=gist&description=My%20trades%20sync" target="_blank" rel="noopener">Create a GitHub token</a> with only the <b>gist</b> box ticked (set “Expiration” to what you prefer) and copy it.</li><li>Paste it below on each device you use.</li></ol>
      <div class="mtgrid"><label class="full">GitHub token (gist scope) <input id="ghTok" type="password" value="${c.token ? "••••••••" : ""}" placeholder="ghp_…"></label></div>
      <p class="note">The token stays in this browser only and can only read/write your gists. Remove it any time here or on GitHub.</p>
      <div class="mtbtns"><button class="mtprimary" id="ghSave">Save & sync</button>${c.token ? `<button id="ghOff">Turn off sync</button>` : ""}<button data-x>Cancel</button></div>`);
    m.querySelectorAll("[data-x]").forEach((b) => (b.onclick = () => m.remove()));
    $$("ghSave").onclick = async () => {
      const v = $$("ghTok").value.trim(); if (!v) return;
      if (v !== "••••••••") ghSet({ token: v });
      m.remove(); toast("Syncing…"); await MT.pull(); if (MT.onChange) MT.onChange();
    };
    const off = $$("ghOff"); if (off) off.onclick = () => { ghSet({}); m.remove(); if (MT.onChange) MT.onChange(); toast("Sync turned off. Your trades stay in this browser."); };
  }
  MT.syncSetup = syncSetup;
  if (ghCfg().token) { MT.pull(); setInterval(MT.pull, 60000); }
  window.addEventListener("storage", (e) => { if (e.key === KEY) { MT.load(); if (MT.onChange) MT.onChange(); } }); // other tab (e.g. terminal) changed it

  /* ---------------- "I took this trade" buttons anywhere ---------------- */
  // <button class="mtrec" data-rec='{"sym":..,"side":..,"stop":..,"target":..,"src":..}'>
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-rec]"); if (!b) return;
    e.preventDefault(); e.stopPropagation();
    try { MT.form(JSON.parse(b.dataset.rec)); } catch (er) { MT.form({}); }
  }, true);
  MT.btn = (o, label) => `<button class="mtrec" data-rec='${esc(JSON.stringify(o)).replace(/'/g, "&#39;")}'>${label || "+ I took this trade"}</button>`;
})();
