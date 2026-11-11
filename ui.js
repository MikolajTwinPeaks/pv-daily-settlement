"use strict";
/* UI layer: hash router, pages, charts. Depends on core.js (data + calculation). */

/* ---------------- small helpers ---------------- */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const shortDate = (iso) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const dayMonth = (iso) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const kwpTotal = () => CFG.farms.reduce((a, f) => a + f.kwp, 0);
const farmById = (id) => CFG.farms.find((f) => f.id === id);
const isCustom = () => {
  const d = Object.assign({}, DEFAULTS, { auction: CFG.auctionPrice["2026"], deg: CFG.pvModel.degradation });
  return Object.keys(d).some((k) => Number(S[k]) !== Number(d[k]) && S[k] !== d[k]);
};
const T = {
  market: "TGE's daily base-load index for the day. The settlement compares our auction price against it.",
  auction: "Fixed in auction AZ/9/2019 and indexed to inflation every year. 2026: 493.87 PLN/MWh.",
  settled: "Output of the 7 auction farms, minus hours that fall in long runs of negative prices.",
  agent: "Zarządca Rozliczeń S.A. (ZRSA), the state settlement agent for renewable auctions.",
  estimated: "Average of the day's PSE day-ahead prices. On 18 checked days it was within 0.8% of the official index on average.",
  sale: "What the offtaker pays for the energy. Default: 60% of the market price.",
};
const term = (label, key) => `<span class="term" tabindex="0" data-tip="${esc(T[key])}">${label}</span>`;
const srcBadge = (src) => ({
  tge: `<span class="badge ok" title="Official TGeBase published by TGE">Official TGE price</span>`,
  manual: `<span class="badge warn" title="Entered in this browser">Price entered manually</span>`,
  proxy: `<span class="badge" data-tip="${esc(T.estimated)}" tabindex="0">Estimated price</span>`,
})[src];
const money = (v) => `${pln(v)}<span class="u">PLN</span>`;
function dirWord(v) { return v > 0.5 ? "receive" : v < -0.5 ? "pay back" : "settle"; }

/* ---------------- shell ---------------- */
const page = () => $("page");
function setPage(html) { destroyCharts(); page().innerHTML = html; window.scrollTo(0, 0); }
function destroyCharts() { for (const k in charts) { try { charts[k].destroy(); } catch {} delete charts[k]; } }
function crumbs(items) {
  return `<nav class="crumbs" aria-label="Breadcrumb">${items.map((it, i) => i < items.length - 1
    ? `<a href="${it[1]}">${esc(it[0])}</a><span aria-hidden="true">›</span>` : `<span aria-current="page">${esc(it[0])}</span>`).join("")}</nav>`;
}
function setNav(key) {
  document.querySelectorAll(".nav a").forEach((a) => {
    const on = a.dataset.nav === key;
    a.classList.toggle("active", on);
    if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  $("customChip").hidden = !isCustom();
  const to = RANGE ? RANGE.to : yesterday();
  $("sideMeta").innerHTML = `<b>${esc(CFG.portfolio)}</b><br>${CFG.farms.length} farms · ${F2.format(kwpTotal() / 1000)} MWp<br>Data through ${dayMonth(to)}<br>${Object.keys(OFFICIAL).length} days with official TGE price`;
}
function waiting(msg, bare) {
  return `<div class="${bare ? "" : "card "}loading" role="status"><div class="spinner" aria-hidden="true"></div><div><b>${esc(msg)}</b>
    <div class="muted small">${esc(YTD.progress || "Fetching prices and weather. Closed months are cached after the first load.")}</div></div></div>`;
}
function verdict(v, title, sub, extra = "") {
  const c = v > 0.5 ? "pos" : v < -0.5 ? "neg" : "flat";
  const head = v > 0.5 ? `We receive ${F0.format(v)} PLN` : v < -0.5 ? `We pay back ${F0.format(-v)} PLN` : "No settlement";
  const arrow = v > 0.5 ? "↓" : v < -0.5 ? "↑" : "·";
  return `<div class="verdict ${c}">
    <div class="v-icon" aria-hidden="true">${arrow}</div>
    <div class="v-body"><div class="v-title">${esc(title)}</div><div class="v-head">${head}</div><div class="v-sub">${sub}</div>${extra}</div></div>`;
}
function tile(label, value, sub, c = "") {
  return `<div class="tile ${c}"><div class="t-l">${label}</div><div class="t-v">${value}</div>${sub ? `<div class="t-s">${sub}</div>` : ""}</div>`;
}
function dataStatus() {
  const to = RANGE ? RANGE.to : yesterday();
  const off = Object.keys(OFFICIAL).filter((d) => d <= to).length;
  const days = Math.round((new Date(to) - new Date(START)) / 864e5) + 1;
  return `Prices through ${dayMonth(to)} · official TGE price on ${off} of ${days} days, estimated on the rest · ${isCustom() ? `<a href="#/assumptions">custom assumptions</a>` : "default assumptions"}`;
}

/* ---------------- aggregation ---------------- */
let ROWS = null;
function rows() {
  if (ROWS) return ROWS;
  const out = [];
  for (let d = START; d <= (RANGE ? RANGE.to : yesterday()); d = addDays(d, 1)) { const r = computeDay(d); if (r) out.push(r); }
  return (ROWS = out);
}
const invalidate = () => { ROWS = null; };
function sumRows(rs) {
  const t = { n: rs.length, E: 0, eAuc: 0, sale: 0, settle: 0, net: 0, base: 0, baseW: 0, pos: 0, neg: 0, posSum: 0, negSum: 0, elig: 0 };
  for (const r of rs) {
    t.E += r.E; t.eAuc += r.eAuc; t.sale += r.sale; t.settle += r.settle; t.net += r.net; t.base += r.base; t.baseW += r.base * r.E; t.elig += r.eligible;
    if (r.settle > 0.5) { t.pos++; t.posSum += r.settle; } else if (r.settle < -0.5) { t.neg++; t.negSum += r.settle; }
  }
  return t;
}
function byMonth(rs) {
  const m = {};
  for (const r of rs) (m[r.date.slice(0, 7)] ??= []).push(r);
  return m;
}
function farmTotals(rs, id) {
  const t = { E: 0, sale: 0, settle: 0, net: 0, elig: 0 };
  for (const r of rs) { const x = r.farms.find((y) => y.f.id === id); t.E += x.E; t.sale += x.sale; t.settle += x.settle; t.net += x.net; t.elig += x.eligible; }
  return t;
}

/* ---------------- charts ---------------- */
function baseOpts(extra = {}) {
  const ink2 = css("--ink-2"), line = css("--line");
  return Object.assign({
    responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
    plugins: { legend: { position: "bottom", labels: { color: ink2, boxWidth: 10, boxHeight: 10, usePointStyle: true, font: { family: "Inter", size: 12 } } },
      tooltip: { backgroundColor: "#1C2430", titleFont: { family: "Inter" }, bodyFont: { family: "Inter" }, padding: 10, cornerRadius: 8 } },
    scales: {
      x: { ticks: { color: ink2, maxRotation: 0, autoSkip: true, font: { family: "Inter", size: 11 } }, grid: { display: false }, border: { color: line } },
      y: { ticks: { color: ink2, font: { family: "Inter", size: 11 } }, grid: { color: line }, border: { display: false } },
    },
  }, extra);
}
function hourlyChart(id, r, eh, noLegend) {
  if (typeof Chart === "undefined") return;
  const labels = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0"));
  const sun = css("--sun"), exc = css("--neg"), price = css("--price"), pos = css("--pos"), ink2 = css("--ink-2");
  const o = baseOpts();
  o.scales.y.title = { display: true, text: "MWh", color: ink2 }; o.scales.y.beginAtZero = true;
  if (noLegend) o.plugins.legend = { display: false };
  o.scales.y2 = { position: "right", title: { display: true, text: "PLN/MWh", color: ink2 }, ticks: { color: ink2, font: { family: "Inter", size: 11 } }, grid: { display: false }, border: { display: false } };
  charts[id] = new Chart($(id), {
    data: { labels, datasets: [
      { type: "bar", label: "Output (MWh)", data: eh.map((v) => +v.toFixed(3)), yAxisID: "y", backgroundColor: r.ex.map((e) => (e ? exc + "99" : sun)), borderRadius: 3, order: 3 },
      { type: "line", label: "Hourly day-ahead price", data: r.prices.map((v) => (v == null ? null : +v.toFixed(2))), yAxisID: "y2", borderColor: price, backgroundColor: price, pointRadius: 0, borderWidth: 2, tension: 0.3, order: 1 },
      { type: "line", label: "Market price (day)", data: labels.map(() => +r.base.toFixed(2)), yAxisID: "y2", borderColor: ink2, borderDash: [5, 4], pointRadius: 0, borderWidth: 1.5, order: 2 },
      { type: "line", label: "Our auction price", data: labels.map(() => r.auction), yAxisID: "y2", borderColor: pos, borderDash: [2, 3], pointRadius: 0, borderWidth: 1.5, order: 2 },
    ] }, options: o,
  });
}
function settleBars(id, labels, values, cum, onClick) {
  if (typeof Chart === "undefined") return;
  const pos = css("--pos"), neg = css("--neg"), prim = css("--primary"), ink2 = css("--ink-2");
  const o = baseOpts();
  if (cum) o.scales.y2 = { position: "right", ticks: { color: ink2, font: { family: "Inter", size: 11 } }, grid: { display: false }, border: { display: false } };
  if (onClick) o.onClick = (_, els) => { if (els.length) onClick(els[0].index); };
  o.onHover = onClick ? (e, els) => { e.native.target.style.cursor = els.length ? "pointer" : "default"; } : undefined;
  const ds = [{ type: "bar", label: "Settlement (PLN)", data: values.map(Math.round), backgroundColor: values.map((v) => (v >= 0 ? pos : neg)), borderRadius: 3, order: 2, yAxisID: "y" }];
  if (cum) ds.push({ type: "line", label: "Cumulative (PLN)", data: cum.map(Math.round), borderColor: prim, backgroundColor: prim, pointRadius: 0, borderWidth: 2, tension: 0.25, order: 1, yAxisID: "y2" });
  if (!cum) o.plugins.legend = { display: false };
  charts[id] = new Chart($(id), { data: { labels, datasets: ds }, options: o });
}

/* ---------------- calendar heatmap ---------------- */
function heatmap(rs) {
  const max = Math.max(1, ...rs.map((r) => Math.abs(r.settle)).sort((a, b) => a - b).slice(0, Math.ceil(rs.length * 0.95)));
  const byDate = Object.fromEntries(rs.map((r) => [r.date, r]));
  const first = new Date(START + "T12:00:00Z"); const off = (first.getUTCDay() + 6) % 7; // Monday = 0
  const last = rs.length ? rs[rs.length - 1].date : START;
  const cells = []; const months = [];
  let col = 0;
  for (let i = -off, d = addDays(START, -off); d <= last; i++, d = addDays(d, 1)) {
    col = Math.floor((i + off) / 7);
    if (d < START) { cells.push(`<span class="hm-cell empty" style="grid-column:${col + 1};grid-row:${((i + off) % 7) + 1}"></span>`); continue; }
    if (d.endsWith("-01") || d === START) months.push(`<span style="grid-column:${col + 1}">${new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" })}</span>`);
    const r = byDate[d]; const v = r ? r.settle : 0;
    const lvl = r ? Math.min(4, Math.ceil((Math.abs(v) / max) * 4)) : 0;
    const k = !r ? "none" : v > 0.5 ? `p${lvl}` : v < -0.5 ? `n${lvl}` : "z";
    const lab = r ? `${shortDate(d)}: ${v > 0.5 ? "we receive" : v < -0.5 ? "we pay back" : "no settlement"} ${F0.format(Math.abs(v))} PLN` : `${shortDate(d)}: no data`;
    cells.push(`<a class="hm-cell ${k}" href="#/day/${d}" style="grid-column:${col + 1};grid-row:${((i + off) % 7) + 1}" aria-label="${esc(lab)}" data-tip="${esc(lab)}"></a>`);
  }
  return `<div class="hm-wrap"><div class="hm-months" style="grid-template-columns:repeat(${col + 1}, var(--hm))">${months.join("")}</div>
    <div class="hm-grid" style="grid-template-columns:repeat(${col + 1}, var(--hm))">${cells.join("")}</div></div>
    <div class="hm-legend"><span>We pay back</span>${["n4", "n3", "n2", "n1", "z", "p1", "p2", "p3", "p4"].map((k) => `<i class="hm-cell ${k}"></i>`).join("")}<span>We receive</span></div>`;
}

/* ---------------- pages ---------------- */
async function pageOverview() {
  setNav("overview");
  const y = yesterday();
  setPage(`<div class="wrap">
    <section class="hero" style="--img:url('img/hero.jpg')">
      <div class="hero-in">
        <div class="eyebrow">${esc(CFG.portfolio)} · ${CFG.farms.length} farms · ${F2.format(kwpTotal() / 1000)} MWp</div>
        <h1>Daily settlement</h1>
        <p class="hero-sub">Estimated production, prices and the auction settlement for every day since 1 January 2026.</p>
      </div>
    </section>
    <div class="two overlap">
        <div class="card" id="ovDay">${waiting("Loading yesterday", true)}</div>
        <div class="card" id="ovYear">${waiting("Loading the year", true)}</div>
    </div>
    <div class="card" id="ovChart"><div class="card-h"><h2>Settlement by month</h2><a class="more" href="#/year">Year detail →</a></div><div id="ovChartBody">${YTD.done ? "" : '<div class="skeleton chart"></div>'}</div></div>
    <div class="card" id="ovFarms"><div class="card-h"><h2>Farms this year</h2><a class="more" href="#/farms">All farm data →</a></div><div id="ovFarmsBody">${YTD.done ? "" : '<div class="skeleton rows"></div>'}</div></div>
    <p class="status-line">${dataStatus()}</p>
  </div>`);
  let y2 = y;
  try { await ensureDay(y); } catch { await loadYtd(); y2 = RANGE ? RANGE.to : y; }
  const r = computeDay(y2);
  if (!r && $("ovDay")) $("ovDay").innerHTML = errorBox(new Error("data for the latest days is not available yet"));
  if (r && $("ovDay")) $("ovDay").innerHTML = verdict(r.settle, `${y2 === y ? "Yesterday" : "Latest day"} · ${shortDate(y2)}`,
    `${term("Market price", "market")} ${price(r.base)} vs ${term("our auction price", "auction")} ${price(r.auction)} PLN/MWh, on ${F1.format(r.eligible)} MWh.`,
    `<div class="v-foot">${srcBadge(r.src)}<a class="more" href="#/day/${y2}">Open the day →</a></div>`);
  if (YTD.done) overviewYtd(); else loadYtd();
}
function overviewYtd() {
  if (!$("ovYear")) return;
  const rs = rows(), t = sumRows(rs);
  $("ovYear").innerHTML = verdict(t.settle, `Year to date · ${t.n} days`,
    `The agent paid us on ${t.pos} days (+${F0.format(t.posSum)}), we paid back on ${t.neg} days (−${F0.format(-t.negSum)} PLN).`,
    `<div class="v-foot"><span class="muted small">Total revenue ${pln(t.net)} PLN · ${price(t.net / t.E)} PLN/MWh</span><a class="more" href="#/year">Open the year →</a></div>`);
  const m = byMonth(rs), keys = Object.keys(m);
  $("ovChartBody").innerHTML = `<div class="chart-box"><canvas id="cOv" role="img" aria-label="Monthly auction settlement and cumulative total"></canvas></div>`;
  let c = 0; const vals = keys.map((k) => sumRows(m[k]).settle);
  settleBars("cOv", keys.map((k) => new Date(k + "-15T12:00:00Z").toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" })), vals, vals.map((v) => (c += v)), (i) => go(`#/month/${keys[i]}`));
  $("ovFarmsBody").innerHTML = farmTable(rs, true);
}
function farmTable(rs, compact) {
  const list = CFG.farms.map((f) => ({ f, ...farmTotals(rs, f.id) })).sort((a, b) => b.net - a.net);
  return `<div class="tbl"><table class="${compact ? "h2" : "h2 h3 h4 h7"}"><thead><tr><th>Farm</th>${compact ? "" : "<th>kWp</th>"}<th>Output MWh</th>${compact ? "" : "<th>Yield kWh/kWp</th>"}<th>Settlement PLN</th><th>Total revenue PLN</th>${compact ? "" : "<th>PLN/MWh</th>"}</tr></thead><tbody>
    ${list.map((x) => `<tr><td><a class="rowlink" href="#/farm/${x.f.id}">${esc(x.f.name)}</a><div class="sub">${x.f.auction ? "Auction" : "Merchant"} · ${esc(x.f.site.split(" (")[0])}</div></td>
      ${compact ? "" : `<td>${F0.format(x.f.kwp)}</td>`}<td>${F1.format(x.E)}</td>${compact ? "" : `<td>${F0.format(x.E * 1000 / x.f.kwp)}</td>`}
      <td class="${x.f.auction ? cls(x.settle) : "muted"}">${x.f.auction ? signed(x.settle) : "n/a"}</td><td><b>${pln(x.net)}</b></td>${compact ? "" : `<td>${price(x.net / x.E)}</td>`}</tr>`).join("")}
    </tbody></table></div>`;
}
const errorBox = (e) => `<div class="err-box" role="alert"><b>Could not load data.</b> ${esc(e.message || e)}. <button class="link" onclick="route()">Try again</button></div>`;

function priceScale(r) {
  const hi = Math.max(r.auction, r.base, 0) * 1.12 || 1, lo = Math.min(0, r.base);
  const pos = (v) => ((v - lo) / (hi - lo)) * 100;
  const a = pos(r.auction), b = pos(r.base), gap = r.auction - r.base, c = gap >= 0 ? "pos" : "neg";
  const left = Math.min(a, b), w = Math.abs(a - b);
  const side = (x, other) => (x < 35 ? "r" : x > 65 ? "l" : x < other ? "l" : "r");
  const aSide = side(a, b), bSide = side(b, a);
  return `<div class="scale" aria-label="Auction price ${price(r.auction)} versus market price ${price(r.base)} PLN/MWh">
      <div class="scale-track"><div class="scale-gap ${c}" style="left:${left}%;width:${w}%"></div>
        <div class="scale-mk" style="left:${a}%"></div><div class="scale-mk" style="left:${b}%"></div>
        <div class="scale-lab top ${aSide}" style="left:${a}%">Our auction price<b>${price(r.auction)}</b></div>
        <div class="scale-lab bot ${bSide}" style="left:${b}%">Market price<b>${price(r.base)}</b></div></div></div>
    <div class="scale-calc"><span>Gap <b>${(gap < 0 ? "−" : "+") + F2.format(Math.abs(gap))}</b> PLN/MWh</span><span>× settled energy <b>${F2.format(r.eligible)}</b> MWh</span>
      <span class="res ${cls(r.settle)}">= <b>${signed(r.settle)}</b> PLN</span></div>`;
}
function dayBand(r, d) {
  const c = r.settle > 0.5 ? "pos" : r.settle < -0.5 ? "neg" : "";
  const head = r.settle > 0.5 ? `We receive <span class="amt">${F0.format(r.settle)} PLN</span>` : r.settle < -0.5 ? `We pay back <span class="amt">${F0.format(-r.settle)} PLN</span>` : "No settlement";
  const sub = r.settle > 0.5 ? `The market price was below our auction price, so the ${term("settlement agent", "agent")} pays the difference.`
    : r.settle < -0.5 ? `The market price was above our auction price, so we return the difference to the ${term("settlement agent", "agent")}.` : "Nothing to settle on this day.";
  return `<section class="band ${c}"><div><div class="v-title">Auction settlement · ${esc(shortDate(d))}</div><div class="v-head">${head}</div><div class="v-sub">${sub}</div>
    <div class="band-foot">${srcBadge(r.src)}${r.wxOk ? "" : `<span class="badge warn">Weather data incomplete</span>`}${r.eEx > 0.0005 ? `<span class="badge warn">${F1.format(r.eEx)} MWh excluded, negative prices</span>` : ""}</div></div>
    <div>${priceScale(r)}</div></section>`;
}
function kpiStrip(items) {
  return `<div class="strip">${items.map(([l, v, s, c, dot]) => `<div><div class="k-l">${dot ? `<i style="background:${dot}"></i>` : ""}${l}</div><div class="k-v ${c || ""}">${v}</div>${s ? `<div class="k-s">${s}</div>` : ""}</div>`).join("")}</div>`;
}
const hbar = (v, max) => `<span class="hbar" aria-hidden="true"><i style="width:${max > 0 ? Math.max(2, (v / max) * 100) : 0}%"></i></span>`;
const dbar = (v, max) => `<span class="dbar" aria-hidden="true"><i class="${v >= 0 ? "pos" : "neg"}" style="width:${max > 0 ? (Math.abs(v) / max) * 50 : 0}%"></i></span>`;

async function pageDay(d) {
  setNav("day");
  if (d < START) d = START; if (d > yesterday()) d = yesterday();
  CUR = d; store.set("wd.date", d);
  const head = `<div class="wrap"><div class="phead"><div>${crumbs([["Overview", "#/"], [monthName(d.slice(0, 7)), `#/month/${d.slice(0, 7)}`], [shortDate(d), ""]])}<h1>${esc(longDate(d))}</h1></div>
      <div class="daynav"><a class="btn icon ${d <= START ? "disabled" : ""}" href="#/day/${addDays(d, -1)}" aria-label="Previous day">‹</a>
      <input type="date" id="dPick" value="${d}" min="${START}" max="${yesterday()}" aria-label="Choose a day">
      <a class="btn icon ${d >= yesterday() ? "disabled" : ""}" href="#/day/${addDays(d, 1)}" aria-label="Next day">›</a></div></div>`;
  const tok = (pageDay.tok = (pageDay.tok || 0) + 1);
  setPage(head + waiting("Loading " + shortDate(d)) + "</div>");
  const bindPick = () => $("dPick").addEventListener("change", (e) => e.target.value && go(`#/day/${e.target.value}`));
  bindPick();
  try { await ensureDay(d); } catch (e) { setPage(head + errorBox(e) + "</div>"); return; }
  if (tok !== pageDay.tok || !location.hash.startsWith("#/day")) return;
  const r = computeDay(d);
  if (!r) { setPage(head + `<div class="card">No market prices published for this day yet.</div></div>`); return; }
  const maxE = Math.max(...r.farms.map((x) => x.E)), maxS = Math.max(1, ...r.farms.map((x) => Math.abs(x.settle)));
  setPage(head + `
    ${dayBand(r, d)}
    ${kpiStrip([
      ["Production (est.)", `${F2.format(r.E)}<span class="u">MWh</span>`, `${F2.format(r.eAuc)} MWh from auction farms`, "", css("--sun")],
      [term("Settled energy", "settled"), `${F2.format(r.eligible)}<span class="u">MWh</span>`, r.eEx > 0.0005 ? `${F2.format(r.eEx)} MWh excluded` : "nothing excluded"],
      [`${term("Sales revenue", "sale")} (est.)`, money(r.sale), `${price(r.salePrice)} PLN/MWh`],
      ["Total revenue", money(r.net), `${price(r.E ? r.net / r.E : null)} PLN/MWh incl. settlement`],
    ])}
    <div class="split">
      <div class="card"><div class="card-h"><h2>Farms</h2><span class="sub">Select a farm for its hourly detail</span></div>
        <div class="tbl"><table class="h2"><thead><tr><th>Farm</th><th>Output MWh</th><th>Settlement PLN</th><th>Revenue PLN</th></tr></thead><tbody>
        ${r.farms.map((x) => `<tr><td><a class="rowlink" href="#/day/${d}/farm/${x.f.id}">${esc(x.f.name)}</a><div class="sub">${x.f.auction ? "Auction" : "Merchant"}</div></td>
          <td>${hbar(x.E, maxE)}${F2.format(x.E)}</td>
          <td class="${x.f.auction ? cls(x.settle) : "muted"}">${x.f.auction ? dbar(x.settle, maxS) + signed(x.settle) : "n/a"}</td><td><b>${pln(x.net)}</b></td></tr>`).join("")}
        </tbody><tfoot><tr><td>Portfolio</td><td>${F2.format(r.E)}</td><td class="${cls(r.settle)}">${signed(r.settle)}</td><td>${pln(r.net)}</td></tr></tfoot></table></div></div>
      <div class="card"><div class="card-h"><h2>Hour by hour</h2><span class="sub">Portfolio output and prices</span></div>
        <div class="chart-box tall"><canvas id="cDay" role="img" aria-label="Hourly portfolio output and day-ahead prices"></canvas></div>
        <div class="legend-x"><span><i class="box" style="background:${css("--sun")}"></i>Output, MWh</span>${r.eEx > 0.0005 ? `<span><i class="box" style="background:${css("--neg")}99"></i>Excluded hours</span>` : ""}
          <span><i style="background:${css("--price")}"></i>Hourly price</span><span><i style="background:${css("--ink-2")}"></i>Market price (day)</span><span><i style="background:${css("--pos")}"></i>Our auction price</span></div>
        <p class="note">${r.negHours ? `${r.negHours} hours had negative prices${r.eEx > 0.0005 ? `; ${F2.format(r.eEx)} MWh fell in runs of 6 hours or more and get no settlement.` : ", none in runs long enough to be excluded."}` : "No negative-price hours."}
          Actual PV capture: ${pct(r.capture / r.base)} of the market price.</p>
        <div class="override"><label for="ovr">Official market price</label>
          <input id="ovr" type="number" step="0.01" value="${overrides()[d] ?? ""}" placeholder="${OFFICIAL[d] != null ? "TGE " + price(OFFICIAL[d]) : "est. " + price(r.proxy)}">
          <button class="btn ghost" id="ovrClear">Clear</button><span class="muted small">Saved in this browser only.</span></div>
      </div>
    </div>
    <p class="status-line">${dataStatus()}</p></div>`);
  bindPick();
  hourlyChart("cDay", r, r.portH, true);
  $("ovr").addEventListener("change", () => { const o = overrides(); const v = parseFloat($("ovr").value); if (isNaN(v)) delete o[d]; else o[d] = v; store.set("wd.baseOverrides", o); invalidate(); route(); });
  $("ovrClear").addEventListener("click", () => { const o = overrides(); delete o[d]; store.set("wd.baseOverrides", o); invalidate(); route(); });
}

async function pageFarmDay(d, id) {
  setNav("day");
  const f = farmById(id); if (!f) return go("#/");
  setPage(`<div class="wrap">${waiting("Loading")}</div>`);
  try { await ensureDay(d); } catch (e) { setPage(`<div class="wrap">${errorBox(e)}</div>`); return; }
  const r = computeDay(d); if (!r) return go(`#/day/${d}`);
  const x = r.farms.find((y) => y.f.id === id);
  setPage(`<div class="wrap">${crumbs([["Overview", "#/"], [shortDate(d), `#/day/${d}`], [f.name, ""]])}${farmBanner(f, shortDate(d))}
    ${kpiStrip([
      ["Output (est.)", `${F3.format(x.E)}<span class="u">MWh</span>`, `${F2.format(x.yieldKwh)} kWh per kWp`, "", css("--sun")],
      [term("Sale price", "sale"), `${price(x.salePrice)}<span class="u">PLN/MWh</span>`, `${pln(x.sale)} PLN sales`],
      ["Settlement", f.auction ? money(x.settle) : "n/a", f.auction ? `on ${F3.format(x.eligible)} MWh settled` : "Merchant farm, no auction", f.auction ? cls(x.settle) : ""],
      ["Total revenue", money(x.net), `${price(x.E ? x.net / x.E : null)} PLN/MWh`],
    ])}
    <div class="card"><div class="card-h"><h2>Hour by hour</h2>${srcBadge(r.src)}</div><div class="chart-box tall"><canvas id="cFD" role="img" aria-label="Hourly output of ${esc(f.name)} and prices"></canvas></div></div>
    <div class="row-links"><a class="btn ghost" href="#/day/${d}">← Back to the day</a><a class="btn ghost" href="#/farm/${id}">${esc(f.name)}: whole year →</a></div></div>`);
  hourlyChart("cFD", r, x.eh);
}
function farmBanner(f, when) {
  return `<section class="banner" style="--img:url('img/farm.jpg')"><div class="banner-in">
    <div class="eyebrow">${f.auction ? "Auction farm · AZ/9/2019" : "Merchant farm"}${when ? " · " + esc(when) : ""}</div><h1>${esc(f.name)}</h1>
    <div class="facts"><span>${esc(f.site)}</span><span>${F0.format(f.kwp)} kWp</span><span>Export limit ${F0.format(f.acKw)} kW</span></div></div></section>`;
}

function needYtd(label) { if (YTD.done) return false; setPage(`<div class="wrap">${waiting(label)}</div>`); loadYtd(); return true; }

function pageYear() {
  setNav("year"); if (needYtd("Loading the year")) return;
  const rs = rows(), t = sumRows(rs), m = byMonth(rs);
  setPage(`<div class="wrap">${crumbs([["Overview", "#/"], ["Year to date", ""]])}
    <div class="pagebar"><h1>Year to date</h1><button class="btn ghost" id="csv">Export CSV</button></div>
    ${verdict(t.settle, `${dayMonth(START)} – ${dayMonth(rs[rs.length - 1].date)} · ${t.n} days`, `The agent paid us on ${t.pos} days (+${F0.format(t.posSum)} PLN), we paid back on ${t.neg} days (−${F0.format(-t.negSum)} PLN).`)}
    <div class="tiles four">
      ${tile(`Average ${term("market price", "market")}`, `${price(t.base / t.n)}<span class="u">PLN/MWh</span>`, `output-weighted ${price(t.baseW / t.E)}`)}
      ${tile("Production (est.)", `${F0.format(t.E)}<span class="u">MWh</span>`, `${F0.format(t.eAuc)} MWh from auction farms`)}
      ${tile(`${term("Sales revenue", "sale")} (est.)`, money(t.sale), `${price(t.sale / t.E)} PLN/MWh`)}
      ${tile("Total revenue", money(t.net), `${price(t.net / t.E)} PLN/MWh incl. settlement`)}
    </div>
    <div class="card"><div class="card-h"><h2>Every day of the year</h2><span class="muted small">Select a day to open it</span></div>${heatmap(rs)}</div>
    <div class="card"><div class="card-h"><h2>By month</h2></div><div class="tbl"><table class="h2 h3 h4"><thead><tr><th>Month</th><th>Avg market price</th><th>Output MWh</th><th>Days we receive / pay back</th><th>Settlement PLN</th><th>Total revenue PLN</th></tr></thead><tbody>
      ${Object.entries(m).map(([k, v]) => { const s = sumRows(v); return `<tr><td><a class="rowlink" href="#/month/${k}">${monthName(k)}</a></td><td>${price(s.base / s.n)}</td><td>${F1.format(s.E)}</td><td>${s.pos} / ${s.neg}</td><td class="${cls(s.settle)}">${signed(s.settle)}</td><td><b>${pln(s.net)}</b></td></tr>`; }).join("")}
      </tbody><tfoot><tr><td>Total</td><td>${price(t.base / t.n)}</td><td>${F1.format(t.E)}</td><td>${t.pos} / ${t.neg}</td><td class="${cls(t.settle)}">${signed(t.settle)}</td><td>${pln(t.net)}</td></tr></tfoot></table></div></div>
    <p class="status-line small">${dataStatus()}</p></div>`);
  $("csv").addEventListener("click", exportCsv);
  const hm = document.querySelector(".hm-wrap"); if (hm) hm.scrollLeft = hm.scrollWidth;
}

function pageMonth(ym) {
  setNav("year"); if (needYtd("Loading the month")) return;
  const rs = rows().filter((r) => r.date.startsWith(ym)); if (!rs.length) return go("#/year");
  const t = sumRows(rs);
  const prev = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 2, 1)).toISOString().slice(0, 7);
  const next = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 1)).toISOString().slice(0, 7);
  setPage(`<div class="wrap">${crumbs([["Overview", "#/"], ["Year to date", "#/year"], [monthName(ym), ""]])}
    <div class="pagebar"><h1>${monthName(ym)}</h1><div class="daynav">
      <a class="btn icon ${prev < START.slice(0, 7) ? "disabled" : ""}" href="#/month/${prev}" aria-label="Previous month">‹</a>
      <a class="btn icon ${next > yesterday().slice(0, 7) ? "disabled" : ""}" href="#/month/${next}" aria-label="Next month">›</a></div></div>
    ${verdict(t.settle, `${t.n} days`, `We received on ${t.pos} days and paid back on ${t.neg}. Total revenue ${pln(t.net)} PLN, ${price(t.net / t.E)} PLN/MWh.`)}
    <div class="card"><div class="card-h"><h2>Settlement per day</h2><span class="muted small">Select a bar to open the day</span></div><div class="chart-box"><canvas id="cM" role="img" aria-label="Daily settlement in ${monthName(ym)}"></canvas></div></div>
    <div class="card"><div class="card-h"><h2>Days</h2><span class="muted small">✓ official TGE price · ~ estimated · ✎ entered manually</span></div><div class="tbl"><table class="h3"><thead><tr><th>Day</th><th>Market price</th><th>Output MWh</th><th>Settlement PLN</th><th>Total revenue PLN</th></tr></thead><tbody>
      ${rs.slice().reverse().map((r) => `<tr><td><a class="rowlink" href="#/day/${r.date}">${shortDate(r.date)}</a></td><td>${price(r.base)} <span class="src" title="${r.src}">${{ tge: "✓", proxy: "~", manual: "✎" }[r.src]}</span></td><td>${F2.format(r.E)}</td><td class="${cls(r.settle)}">${signed(r.settle)}</td><td><b>${pln(r.net)}</b></td></tr>`).join("")}
    </tbody></table></div></div></div>`);
  settleBars("cM", rs.map((r) => String(+r.date.slice(8))), rs.map((r) => r.settle), null, (i) => go(`#/day/${rs[i].date}`));
}

function spark(vals, kind) {
  const max = Math.max(1, ...vals.map(Math.abs));
  return `<div class="spark ${kind === "settle" ? "mid" : ""}">${vals.map((v) => kind === "settle"
    ? `<i class="${v >= 0 ? "pos" : "neg"}" style="--h:${(Math.abs(v) / max) * 50}%"></i>` : `<i class="out" style="--h:${(v / max) * 100}%"></i>`).join("")}</div>`;
}
function pageFarms() {
  setNav("farms"); if (needYtd("Loading farm data")) return;
  const rs = rows(), m = byMonth(rs), keys = Object.keys(m);
  const ml = keys.map((k) => new Date(k + "-15T12:00:00Z").toLocaleDateString("en-GB", { month: "narrow", timeZone: "UTC" }));
  setPage(`<div class="wrap"><div class="phead"><div>${crumbs([["Overview", "#/"], ["Farms", ""]])}<h1>Farms</h1></div><span class="muted small">Year to date, ${dayMonth(START)} – ${dayMonth(rs[rs.length - 1].date)}</span></div>
    <div class="farm-cards">${CFG.farms.map((f) => {
      const t = farmTotals(rs, f.id), mt = keys.map((k) => farmTotals(m[k], f.id));
      return `<a class="farm-card" href="#/farm/${f.id}">
        <div class="fc-head"><div><b>${esc(f.name)}</b><small>${esc(f.site)}</small></div><span class="badge ${f.auction ? "ok" : "warn"}">${f.auction ? "Auction" : "Merchant"}</span></div>
        <div class="fc-main"><div><div class="lab">Total revenue</div><div class="big">${pln(t.net)}<span class="u">PLN</span></div></div>
          <div><div class="lab">Settlement</div><div class="big ${f.auction ? cls(t.settle) : "na"}">${f.auction ? signed(t.settle) + '<span class="u">PLN</span>' : "Not in auction"}</div></div></div>
        <div class="fc-chart"><div class="lab small muted">${f.auction ? "Settlement by month" : "Output by month"}</div>${spark(f.auction ? mt.map((x) => x.settle) : mt.map((x) => x.E), f.auction ? "settle" : "out")}
          <div class="spark-l">${ml.map((x) => `<span>${x}</span>`).join("")}</div></div>
        <div class="fc-foot"><span>Output <b>${F0.format(t.E)} MWh</b></span><span>Yield <b>${F0.format(t.E * 1000 / f.kwp)} kWh/kWp</b></span><span>Revenue per MWh <b>${price(t.net / t.E)} PLN</b></span></div></a>`; }).join("")}</div>
    <div class="card"><div class="card-h"><h2>Comparison</h2><span class="sub">Sorted by total revenue</span></div>${farmTable(rs, false)}</div></div>`);
}

function pageFarm(id) {
  setNav("farms"); const f = farmById(id); if (!f) return go("#/farms");
  if (needYtd("Loading " + f.name)) return;
  const rs = rows(), t = farmTotals(rs, id), m = byMonth(rs), keys = Object.keys(m);
  const mt = keys.map((k) => ({ k, ...farmTotals(m[k], id) }));
  setPage(`<div class="wrap">${crumbs([["Overview", "#/"], ["Farms", "#/farms"], [f.name, ""]])}${farmBanner(f, "Year to date")}
    <div class="tiles four">
      ${tile("Output (est.)", `${F0.format(t.E)}<span class="u">MWh</span>`, `${F0.format(t.E * 1000 / f.kwp)} kWh per kWp`)}
      ${tile(`${term("Sales revenue", "sale")} (est.)`, money(t.sale), `${price(t.sale / t.E)} PLN/MWh`)}
      ${tile("Settlement", f.auction ? money(t.settle) : "n/a", f.auction ? `on ${F0.format(t.elig)} MWh settled` : "Merchant farm", f.auction ? cls(t.settle) : "")}
      ${tile("Total revenue", money(t.net), `${price(t.net / t.E)} PLN/MWh`)}
    </div>
    <div class="card"><div class="card-h"><h2>${f.auction ? "Settlement by month" : "Revenue by month"}</h2></div><div class="chart-box"><canvas id="cF" role="img" aria-label="Monthly figures for ${esc(f.name)}"></canvas></div></div>
    <div class="card"><div class="card-h"><h2>By month</h2></div><div class="tbl"><table class="h2 h3"><thead><tr><th>Month</th><th>Output MWh</th><th>Sales PLN</th><th>Settlement PLN</th><th>Total revenue PLN</th></tr></thead><tbody>
      ${mt.map((x) => `<tr><td><a class="rowlink" href="#/month/${x.k}">${monthName(x.k)}</a></td><td>${F1.format(x.E)}</td><td>${pln(x.sale)}</td><td class="${f.auction ? cls(x.settle) : "muted"}">${f.auction ? signed(x.settle) : "n/a"}</td><td><b>${pln(x.net)}</b></td></tr>`).join("")}
    </tbody></table></div></div>
    <div class="card"><div class="card-h"><h2>Setup</h2></div><dl class="facts-list">
      <div><dt>Location</dt><dd>${esc(f.site)} · ${f.lat.toFixed(3)}, ${f.lon.toFixed(3)}</dd></div>
      <div><dt>Installed capacity</dt><dd>${F2.format(f.kwp)} kWp DC</dd></div><div><dt>Export limit</dt><dd>${F0.format(f.acKw)} kW</dd></div>
      <div><dt>Performance ratio</dt><dd>${F3.format(f.pr)} (calibrated to 2023 output of ${F1.format(f.prod2023)} MWh)</dd></div>
      <div><dt>Regime</dt><dd>${f.auction ? "Auction AZ/9/2019, two-way settlement with the agent" : "Merchant, sales only"}</dd></div></dl></div></div>`);
  if (typeof Chart === "undefined") return;
  if (f.auction) settleBars("cF", keys.map((k) => new Date(k + "-15T12:00:00Z").toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" })), mt.map((x) => x.settle), null, (i) => go(`#/month/${keys[i]}`));
  else {
    const o = baseOpts(); o.plugins.legend = { display: false }; charts.cF = new Chart($("cF"), { type: "bar", data: { labels: keys.map((k) => new Date(k + "-15T12:00:00Z").toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" })), datasets: [{ label: "Revenue (PLN)", data: mt.map((x) => Math.round(x.net)), backgroundColor: css("--primary"), borderRadius: 3 }] }, options: o });
  }
}

function pageMethod() {
  setNav("method");
  setPage(`<div class="wrap narrow">${crumbs([["Overview", "#/"], ["Method", ""]])}<h1>How the numbers are made</h1>
    <div class="card prose">
      <h2>The settlement in one line</h2>
      <p class="formula">Settlement = (our auction price − market price) × settled energy</p>
      <p>Seven of the ten farms sold their output in auction AZ/9/2019. Each day the ${term("settlement agent", "agent")} compares our auction price with the day's market price. If the market price is lower, the agent pays us the difference; if it is higher, we pay the difference back (art. 93 ust. 2 of the Polish RES Act). The other three farms are merchant and only sell energy.</p>
      <h2>Terms</h2>
      <dl class="gloss">
        <div><dt>Market price</dt><dd>${esc(T.market)}</dd></div>
        <div><dt>Our auction price</dt><dd>${esc(T.auction)}</dd></div>
        <div><dt>Settled energy</dt><dd>${esc(T.settled)} Projects from auctions before 28.12.2024 lose support only for runs of at least 6 negative hours.</dd></div>
        <div><dt>Settlement agent</dt><dd>${esc(T.agent)}</dd></div>
        <div><dt>Sales revenue</dt><dd>${esc(T.sale)} Shown as an estimate.</dd></div>
        <div><dt>Estimated price</dt><dd>${esc(T.estimated)} Largest difference seen: 32.9 PLN/MWh (28 Oct 2026). Errors go both ways and almost cancel out over a year.</dd></div>
      </dl>
      <h2>Production</h2>
      <p>Hourly irradiance on a 30° south-facing plane at each site, corrected for module temperature and capped at the farm's export limit. A performance ratio per farm makes the model reproduce each farm's metered 2023 output. Results are estimates; metered data will differ day to day.</p>
      <h2>Data sources and timing</h2>
      <ul><li>Day-ahead prices: PSE (RCE), published around 14:00 the day before delivery.</li>
        <li>Official market price: TGE TGeBase, added when available. TGE keeps about six weeks of sessions public.</li>
        <li>Weather: ERA5 reanalysis via Open-Meteo (CC BY 4.0), the same source used to calibrate each farm. If ERA5 has not yet covered the latest day, the ECMWF IFS forecast fills in.</li></ul>
      <p class="muted small">Not modelled: the annual auction volume cap and the periodic cash settlement with the agent. Figures are for monitoring, not invoices.</p>
    </div><p class="status-line small">${dataStatus()}</p></div>`);
}

function pageAssumptions() {
  setNav("assumptions");
  setPage(`<div class="wrap narrow">${crumbs([["Overview", "#/"], ["Assumptions", ""]])}<h1>Assumptions</h1>
    <p class="muted">Changes apply at once and are saved in this browser only. Other people see the defaults.</p>
    <div class="card"><div class="card-h"><h2>Prices</h2></div><div class="form">
      <label>Sale price method<select id="s_mode"><option value="ratio">Fixed share of the market price</option><option value="hourly">Hourly price × hourly output</option></select></label>
      <label>Sale price as share of the market price<input id="s_ratio" type="number" step="0.01" min="0" max="1.5"></label>
      <label>Our auction price 2026 (PLN/MWh)<input id="s_auction" type="number" step="0.01"></label>
      <label>Negative-price hours<select id="s_neg"><option value="run6">No settlement in runs of 6 h or more (our auctions)</option><option value="all">No settlement in any negative hour (current rules)</option><option value="none">Always settled</option></select></label>
    </div></div>
    <div class="card"><div class="card-h"><h2>Production</h2></div><div class="form">
      <label>Performance ratio multiplier<input id="s_prm" type="number" step="0.01" min="0.5" max="1.5"></label>
      <label>Annual degradation since 2023<input id="s_deg" type="number" step="0.001" min="0" max="0.02"></label>
      <label>Availability<input id="s_avail" type="number" step="0.01" min="0" max="1"></label>
    </div></div>
    <div class="row-links"><button class="btn ghost" id="sReset">Reset to defaults</button><button class="btn ghost" id="csv">Export year to date (CSV)</button><button class="btn ghost" id="refresh">Reload latest data</button></div></div>`);
  const set = () => { $("s_mode").value = S.mode; $("s_ratio").value = S.ratio; $("s_auction").value = S.auction; $("s_neg").value = S.neg; $("s_prm").value = S.prm; $("s_deg").value = S.deg; $("s_avail").value = S.avail; $("s_ratio").disabled = S.mode !== "ratio"; };
  set();
  const upd = () => { saveSettings(); invalidate(); setNav("assumptions"); set(); };
  ["s_mode", "s_neg"].forEach((id) => $(id).addEventListener("change", () => { S[id.slice(2)] = $(id).value; upd(); }));
  ["s_ratio", "s_auction", "s_prm", "s_deg", "s_avail"].forEach((id) => $(id).addEventListener("change", () => { const v = parseFloat($(id).value); if (!isNaN(v)) { S[id.slice(2)] = v; upd(); } }));
  $("sReset").addEventListener("click", () => { store.set("wd.settings", {}); S = loadSettings(); upd(); });
  $("csv").addEventListener("click", () => (YTD.done ? exportCsv() : (setStatus("The year is still loading; try again in a moment."), loadYtd())));
  $("refresh").addEventListener("click", refreshData);
}

/* ---------------- CSV ---------------- */
function exportCsv() {
  const rs = rows();
  const head = ["date", "market_price_pln_mwh", "price_source", "sale_price_pln_mwh", "auction_price_pln_mwh", "production_mwh", "auction_farms_mwh",
    "settled_mwh", "sales_pln", "settlement_pln", "total_revenue_pln", "negative_hours", ...CFG.farms.flatMap((f) => [`${f.id}_mwh`, `${f.id}_settlement_pln`])];
  const lines = [head.join(",")];
  for (const r of rs) lines.push([r.date, r.base.toFixed(2), r.src, r.salePrice.toFixed(2), r.auction.toFixed(2), r.E.toFixed(4), r.eAuc.toFixed(4),
    r.eligible.toFixed(4), r.sale.toFixed(2), r.settle.toFixed(2), r.net.toFixed(2), r.negHours, ...r.farms.flatMap((x) => [x.E.toFixed(4), x.settle.toFixed(2)])].join(","));
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
  a.download = `daily-settlement_${START}_${rs[rs.length - 1].date}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------------- router ---------------- */
function go(h) { if (location.hash === h) route(); else location.hash = h; }
function route() {
  setStatus(null);
  const h = location.hash.replace(/^#\/?/, "").split("/");
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
  if (h[0] === "day" && isDate(h[1]) && h[2] === "farm") return pageFarmDay(h[1], h[3]);
  if (h[0] === "day") return pageDay(isDate(h[1]) ? h[1] : (store.get("wd.date", null) || yesterday()));
  if (h[0] === "year") return pageYear();
  if (h[0] === "month" && /^\d{4}-\d{2}$/.test(h[1])) return pageMonth(h[1]);
  if (h[0] === "farms") return pageFarms();
  if (h[0] === "farm") return pageFarm(h[1]);
  if (h[0] === "method") return pageMethod();
  if (h[0] === "assumptions") return pageAssumptions();
  return pageOverview();
}
const ytdPages = () => /^#\/(year|month|farms|farm\/)/.test(location.hash) || !location.hash || location.hash === "#/";
function onYtdProgress() { const el = document.querySelector(".loading .muted"); if (el) el.textContent = YTD.progress; }
function onYtdReady() { invalidate(); if (!location.hash || location.hash === "#/") overviewYtd(); else if (ytdPages()) route(); }
function onYtdError(e) { setStatus("Could not load the year (" + e.message + "). Use Reload latest data under Assumptions to retry.", true); }
function refreshData() {
  const y = yesterday();
  for (const k in WX) for (const d in WX[k]) if (d >= addDays(y, -2)) delete WX[k][d];
  for (const d in PRICES) if (d >= addDays(y, -2)) delete PRICES[d];
  for (const k in MONTHS_LOADED) if (k >= addDays(y, -2).slice(0, 7)) delete MONTHS_LOADED[k];
  YTD.done = false; YTD.running = null; invalidate(); loadYtd(); setStatus("Reloading the latest days…"); setTimeout(() => setStatus(null), 2500);
}

/* ---------------- tooltips for .term / [data-tip] ---------------- */
function bindTips() {
  const tip = $("tip");
  const show = (el) => {
    tip.textContent = el.dataset.tip; tip.hidden = false;
    const b = el.getBoundingClientRect(), w = Math.min(300, window.innerWidth - 24);
    tip.style.maxWidth = w + "px";
    const left = Math.max(12, Math.min(window.innerWidth - w - 12, b.left + b.width / 2 - w / 2));
    tip.style.left = left + "px"; tip.style.top = (b.bottom + 8 + window.scrollY) + "px";
  };
  const hide = () => { tip.hidden = true; };
  document.addEventListener("mouseover", (e) => { const el = e.target.closest("[data-tip]"); if (el) show(el); });
  document.addEventListener("mouseout", (e) => { if (e.target.closest("[data-tip]")) hide(); });
  document.addEventListener("focusin", (e) => { const el = e.target.closest("[data-tip]"); if (el) show(el); });
  document.addEventListener("focusout", hide);
  window.addEventListener("scroll", hide, { passive: true });
}

/* ---------------- boot ---------------- */
async function startApp(cfg) {
  CFG = cfg; S = loadSettings();
  document.body.classList.remove("is-login");
  $("login").hidden = true; $("app").hidden = false;
  $("brandSub").textContent = cfg.portfolio;
  await loadOfficial();
  window.addEventListener("hashchange", route);
  document.addEventListener("keydown", (e) => {
    if (!location.hash.startsWith("#/day/") || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    const d = location.hash.split("/")[2];
    if (e.key === "ArrowLeft" && d > START) go(`#/day/${addDays(d, -1)}`);
    if (e.key === "ArrowRight" && d < yesterday()) go(`#/day/${addDays(d, 1)}`);
  });
  $("logout").addEventListener("click", () => { store.sdel("wd.cfg"); location.hash = ""; location.reload(); });
  bindTips();
  route();
  loadYtd();
}
(function boot() {
  const cached = store.sget("wd.cfg");
  if (cached) { startApp(cached); return; }
  document.body.classList.add("is-login");
  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("loginBtn"); btn.disabled = true; btn.textContent = "Unlocking…"; $("loginErr").hidden = true;
    try { const cfg = await decryptData($("user").value, $("pw").value); store.sset("wd.cfg", cfg); $("pw").value = ""; startApp(cfg); }
    catch { $("loginErr").hidden = false; btn.disabled = false; btn.textContent = "Sign in"; $("pw").select(); }
  });
})();
