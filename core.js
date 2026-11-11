"use strict";

/* ---------------- constants ---------------- */
const START = "2026-01-01";
const TZ = "Europe/Warsaw";
const PSE_URL = "https://api.raporty.pse.pl/api/rce-pln";
const OM_URL = "https://archive-api.open-meteo.com/v1/archive";          // ERA5 reanalysis: same source as the PR calibration
const OM_FALLBACK = "https://historical-forecast-api.open-meteo.com/v1/forecast"; // only for days ERA5 has not published yet
const OM_FALLBACK_MODEL = "ecmwf_ifs025";
const DEFAULTS = { mode: "ratio", ratio: 0.60, auction: null, neg: "run6", prm: 1.0, deg: null, avail: 1.0 };

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  sget(k) { try { const v = sessionStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } },
  sset(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch {} },
  sdel(k) { try { sessionStorage.removeItem(k); } catch {} },
};

/* ---------------- formatting ---------------- */
const nf = (d) => new Intl.NumberFormat("en-GB", { minimumFractionDigits: d, maximumFractionDigits: d });
const F0 = nf(0), F1 = nf(1), F2 = nf(2), F3 = nf(3);
const pln = (v) => (v < 0 ? "−" : "") + F0.format(Math.abs(v));
const signed = (v) => (v > 0.5 ? "+" : v < -0.5 ? "−" : "") + F0.format(Math.abs(v));
const price = (v) => (v == null || isNaN(v)) ? "–" : (v < 0 ? "−" : "") + F2.format(Math.abs(v));
const pct = (v) => (v == null || isNaN(v)) ? "–" : F0.format(v * 100) + "%";
const cls = (v) => (v > 0.5 ? "pos" : v < -0.5 ? "neg" : "");

/* ---------------- dates ---------------- */
function todayWarsaw() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function addDays(iso, n) {
  const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
const yesterday = () => addDays(todayWarsaw(), -1);
function longDate(iso) {
  return new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}
const monthName = (ym) => new Date(ym + "-15T12:00:00Z").toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

/* ---------------- crypto / login ---------------- */
const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function decryptData(login, password) {
  const blob = await (await fetch("data.enc.json", { cache: "no-store" })).json();
  const enc = new TextEncoder();
  const secret = blob.v >= 2 ? login.trim().toLowerCase() + ":" + password : password;
  const base = await crypto.subtle.importKey("raw", enc.encode(secret), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: b64d(blob.salt), iterations: blob.iter, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64d(blob.iv) }, key, b64d(blob.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

/* ---------------- state ---------------- */
let CFG = null;              // decrypted portfolio
let S = null;                // settings
let PRICES = {};             // date -> { q:[...15-min], h:[24 avg], mean }
let WX = {};                 // siteKey -> date -> { g:[24], t:[24] }
let RANGE = null;            // { from, to }
let CUR = null;              // selected date
const charts = {};

function loadSettings() {
  const s = Object.assign({}, DEFAULTS, store.get("wd.settings", {}));
  if (s.auction == null) s.auction = CFG.auctionPrice["2026"];
  if (s.deg == null) s.deg = CFG.pvModel.degradation;
  return s;
}
const saveSettings = () => store.set("wd.settings", S);
const overrides = () => store.get("wd.baseOverrides", {});
let OFFICIAL = {};           // date -> official TGeBase from tgebase.json
async function loadOfficial() {
  try { OFFICIAL = (await (await fetch("tgebase.json", { cache: "no-store" })).json()).values || {}; }
  catch { OFFICIAL = {}; }
}

/* ---------------- data fetch ---------------- */
function setStatus(msg, isErr) {
  const el = $("status");
  if (!msg) { el.hidden = true; return; }
  el.hidden = false; el.textContent = msg; el.className = "status" + (isErr ? " error" : "");
}

async function fetchJson(url, tries = 3, timeoutMs = 60000) {
  let last;
  for (let i = 0; i < tries; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      clearTimeout(timer);
      if (r.ok) return await r.json();
      last = new Error("HTTP " + r.status);
      if (r.status === 400) break;
    } catch (e) { clearTimeout(timer); last = e.name === "AbortError" ? new Error("timeout") : e; }
    await new Promise((res) => setTimeout(res, 2000 * (i + 1)));
  }
  throw last;
}

async function fetchPrices(from, to) {
  const out = {};
  let url = `${PSE_URL}?$select=business_date,period,rce_pln&$first=20000&$filter=` +
    encodeURIComponent(`business_date ge '${from}' and business_date le '${to}'`);
  let guard = 0;
  while (url && guard++ < 20) {
    const j = await fetchJson(url);
    for (const r of j.value || []) {
      const d = r.business_date, h = parseInt(r.period.slice(0, 2), 10), v = Number(r.rce_pln);
      if (!out[d]) out[d] = { s: 0, n: 0, hs: Array(24).fill(0), hn: Array(24).fill(0) };
      out[d].s += v; out[d].n++;
      if (h >= 0 && h < 24) { out[d].hs[h] += v; out[d].hn[h] += 1; }
    }
    url = j.nextLink || null;
  }
  const res = {};
  for (const d in out) {
    const o = out[d];
    res[d] = { h: o.hs.map((s, i) => (o.hn[i] ? +(s / o.hn[i]).toFixed(3) : null)), mean: o.s / o.n };
  }
  return res;
}

function siteKey(f) { return f.lat.toFixed(4) + "," + f.lon.toFixed(4); }
function sites() {
  const m = {};
  for (const f of CFG.farms) m[siteKey(f)] = f;
  return m;
}

// one request for all sites (Open-Meteo accepts comma-separated coordinates)
async function fetchWeatherFrom(base, from, to, model) {
  const ss = Object.values(sites());
  const q = `?latitude=${ss.map((f) => f.lat).join(",")}&longitude=${ss.map((f) => f.lon).join(",")}` +
    `&hourly=global_tilted_irradiance,temperature_2m&tilt=${CFG.pvModel.tilt}&azimuth=${CFG.pvModel.azimuth}` +
    `&start_date=${from}&end_date=${to}&timezone=${encodeURIComponent(TZ)}` + (model ? `&models=${model}` : "");
  let j = await fetchJson(base + q, 2);
  if (!Array.isArray(j)) j = [j];
  const out = {};
  ss.forEach((f, idx) => {
    const k = siteKey(f), o = (out[k] = {});
    const t = j[idx].hourly.time, g = j[idx].hourly.global_tilted_irradiance, T = j[idx].hourly.temperature_2m;
    for (let i = 0; i < t.length; i++) {
      const d = t[i].slice(0, 10), h = parseInt(t[i].slice(11, 13), 10);
      if (!o[d]) o[d] = { g: Array(24).fill(0), t: Array(24).fill(10), ok: false, src: model || "era5" };
      if (g[i] != null) { o[d].g[h] += g[i]; o[d].ok = true; }
      if (T[i] != null) o[d].t[h] = T[i];
    }
  });
  return out;
}
async function fetchWeather(from, to) {
  let out;
  try { out = await fetchWeatherFrom(OM_URL, from, to); } catch { out = {}; }
  const missing = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (!Object.keys(sites()).every((k) => out[k]?.[d]?.ok)) missing.push(d);
  if (missing.length) {
    const fb = await fetchWeatherFrom(OM_FALLBACK, missing[0], missing[missing.length - 1], OM_FALLBACK_MODEL);
    for (const k in fb) { out[k] ??= {}; for (const d of missing) if (fb[k][d]) out[k][d] = fb[k][d]; }
  }
  return out;
}

function merge(px, wx) {
  Object.assign(PRICES, px);
  for (const k in wx) WX[k] = Object.assign(WX[k] || {}, wx[k]);
}
const haveDay = (d) => PRICES[d] && Object.keys(sites()).every((k) => WX[k]?.[d]?.ok);

// fast path: a single day
async function ensureDay(d) {
  if (haveDay(d)) return;
  const [px, wx] = await Promise.all([fetchPrices(d, d), fetchWeather(d, d)]);
  merge(px, wx);
}

// year to date, month by month, closed months cached in the browser
const YTD = { done: false, running: null, progress: "" };
function monthsUntil(to) {
  const out = [];
  for (let m = START.slice(0, 7); m <= to.slice(0, 7); ) {
    const first = m + "-01";
    const last = addDays(new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 1)).toISOString().slice(0, 10), -1);
    out.push({ m, from: first < START ? START : first, to: last > to ? to : last, closed: last < to });
    const n = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 1)); m = n.toISOString().slice(0, 7);
  }
  return out;
}
function loadYtd(force) {
  try { Object.keys(localStorage).filter((k) => k.startsWith("wd.cache.v1.")).forEach((k) => localStorage.removeItem(k)); } catch {}
  if (YTD.running && !force) return YTD.running;
  const to = yesterday();
  YTD.done = false;
  YTD.running = (async () => {
    for (const mo of monthsUntil(to)) {
      const key = `wd.cache.v2.${mo.m}`;
      let c = !force && mo.closed ? store.get(key, null) : null;
      if (!c) {
        YTD.progress = `Loading year to date: ${monthName(mo.m)}…`;
        onYtdProgress();
        const [px, wx] = await Promise.all([fetchPrices(mo.from, mo.to), fetchWeather(mo.from, mo.to)]);
        c = { px, wx };
        if (mo.closed) store.set(key, c);
      }
      merge(c.px, c.wx);
    }
    YTD.done = true; YTD.running = null;
    RANGE = { from: START, to };
    YTD.loadedAt = new Date();
    onYtdReady();
  })().catch((e) => {
    YTD.running = null;
    onYtdError(e);
  });
  return YTD.running;
}

/* ---------------- calculation ---------------- */
function auctionPriceFor(date) {
  const y = date.slice(0, 4);
  if (y === "2026") return Number(S.auction);
  return Number(CFG.auctionPrice[y] ?? S.auction);
}

function excludedHours(h) {
  const ex = Array(24).fill(false);
  if (S.neg === "none") return ex;
  if (S.neg === "all") return h.map((p) => p != null && p < 0);
  let i = 0;
  while (i < 24) {
    if (h[i] != null && h[i] < 0) {
      let j = i; while (j < 24 && h[j] != null && h[j] < 0) j++;
      if (j - i >= 6) for (let k = i; k < j; k++) ex[k] = true;
      i = j;
    } else i++;
  }
  return ex;
}

function computeDay(date) {
  const pr = PRICES[date];
  if (!pr) return null;
  const ov = overrides()[date];
  const manual = ov != null && ov !== "";
  const off = OFFICIAL[date];
  const src = manual ? "manual" : off != null ? "tge" : "proxy";
  const base = manual ? Number(ov) : off != null ? Number(off) : pr.mean;
  const auction = auctionPriceFor(date);
  const ex = excludedHours(pr.h);
  const yrs = Number(date.slice(0, 4)) - CFG.pvModel.calibrationYear;
  const degr = Math.pow(1 - S.deg, yrs);
  const tc = CFG.pvModel.tempCoeff, noct = CFG.pvModel.noct;
  const portH = Array(24).fill(0);
  let wxOk = true;

  const farms = CFG.farms.map((f) => {
    const w = WX[siteKey(f)]?.[date];
    if (!w || !w.ok) wxOk = false;
    const eh = Array(24).fill(0);
    if (w) for (let h = 0; h < 24; h++) {
      const g = w.g[h]; if (!g) continue;
      const tf = 1 + tc * Math.max(0, w.t[h] + noct * g - 25);
      const kw = Math.min((g / 1000) * f.kwp * f.pr * S.prm * tf * degr * S.avail, f.acKw);
      eh[h] = kw / 1000; // MWh in this hour
    }
    const E = eh.reduce((a, b) => a + b, 0);
    let pv = 0, eEx = 0;
    for (let h = 0; h < 24; h++) {
      portH[h] += eh[h];
      if (pr.h[h] != null) pv += eh[h] * pr.h[h];
      if (ex[h]) eEx += eh[h];
    }
    const capture = E > 0 ? pv / E : null;
    const salePrice = S.mode === "hourly" ? capture : S.ratio * base;
    const sale = S.mode === "hourly" ? pv : E * S.ratio * base;
    const eligible = f.auction ? E - eEx : 0;
    const settle = f.auction ? (auction - base) * eligible : 0;
    return { f, E, eh, yieldKwh: E * 1000 / f.kwp, capture, salePrice, sale, eligible, eEx, settle, net: sale + settle };
  });

  const sum = (k) => farms.reduce((a, r) => a + r[k], 0);
  const E = sum("E"), sale = sum("sale"), settle = sum("settle"), net = sale + settle;
  const eAuc = farms.filter((r) => r.f.auction).reduce((a, r) => a + r.E, 0);
  const pvAll = farms.reduce((a, r) => a + (r.capture ?? 0) * r.E, 0);
  return {
    date, base, proxy: pr.mean, overridden: src !== "proxy", src, auction, ex, prices: pr.h, portH, farms, wxOk,
    E, eAuc, eligible: sum("eligible"), eEx: farms.filter((r) => r.f.auction).reduce((a, r) => a + r.eEx, 0),
    sale, settle, net, salePrice: E ? sale / E : S.ratio * base, capture: E ? pvAll / E : null,
    negHours: pr.h.filter((p) => p != null && p < 0).length,
  };
}

