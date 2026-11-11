// Builds the static data cache in data/YYYY-MM.json (prices + weather per site),
// so the app does not depend on live API calls from each browser.
//
// Sites come from env SITES (JSON array of {lat, lon}) or from farms.private.json.
// Sites are stored under a hash of their coordinates, so the files do not reveal locations.
//   node tools/update-data.mjs            (updates the last 2 months and any missing month)
//   node tools/update-data.mjs --all      (rebuilds every month)
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";

const START = "2026-01-01";
const TILT = 30, AZ = 0, TZ = "Europe/Warsaw";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const yesterday = addDays(today, -1);

let sites = process.env.SITES ? JSON.parse(process.env.SITES) : JSON.parse(readFileSync("farms.private.json", "utf8")).farms;
const uniq = {}; for (const s of sites) uniq[s.lat.toFixed(4) + "," + s.lon.toFixed(4)] = s;
sites = Object.entries(uniq).map(([k, s]) => ({ key: createHash("sha256").update(k).digest("hex").slice(0, 12), lat: s.lat, lon: s.lon }));

async function getJson(url, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 120000);
      const r = await fetch(url, { signal: ctl.signal }); clearTimeout(t);
      if (r.ok) return await r.json();
      console.warn("HTTP", r.status, url.slice(0, 90));
      if (r.status === 400) throw new Error("400 " + (await r.text()).slice(0, 200));
    } catch (e) { if (String(e).startsWith("Error: 400")) throw e; console.warn("retry", i, String(e).slice(0, 80)); }
    await sleep(15000 * (i + 1));
  }
  throw new Error("failed " + url.slice(0, 90));
}

async function prices(from, to) {
  const out = {};
  let url = `https://api.raporty.pse.pl/api/rce-pln?$select=business_date,period,rce_pln&$first=20000&$filter=` + encodeURIComponent(`business_date ge '${from}' and business_date le '${to}'`);
  while (url) {
    const j = await getJson(url);
    for (const r of j.value || []) {
      const d = r.business_date, h = parseInt(r.period.slice(0, 2), 10), v = Number(r.rce_pln);
      const o = (out[d] ??= { s: 0, n: 0, hs: Array(24).fill(0), hn: Array(24).fill(0) });
      o.s += v; o.n++; if (h >= 0 && h < 24) { o.hs[h] += v; o.hn[h]++; }
    }
    url = j.nextLink || null;
  }
  const res = {};
  for (const d in out) { const o = out[d]; res[d] = { h: o.hs.map((s, i) => (o.hn[i] ? +(s / o.hn[i]).toFixed(2) : null)), mean: +(o.s / o.n).toFixed(4) }; }
  return res;
}

async function weather(base, from, to, model) {
  const q = `?latitude=${sites.map((s) => s.lat).join(",")}&longitude=${sites.map((s) => s.lon).join(",")}&hourly=global_tilted_irradiance,temperature_2m&tilt=${TILT}&azimuth=${AZ}&start_date=${from}&end_date=${to}&timezone=${encodeURIComponent(TZ)}` + (model ? `&models=${model}` : "");
  let j = await getJson(base + q); if (!Array.isArray(j)) j = [j];
  const out = {};
  sites.forEach((s, i) => {
    const o = (out[s.key] = {}); const H = j[i].hourly;
    for (let k = 0; k < H.time.length; k++) {
      const d = H.time[k].slice(0, 10), h = parseInt(H.time[k].slice(11, 13), 10);
      const x = (o[d] ??= { g: Array(24).fill(0), t: Array(24).fill(10), ok: false, src: model || "era5" });
      const g = H.global_tilted_irradiance[k], t = H.temperature_2m[k];
      if (g != null) { x.g[h] = +(x.g[h] + g).toFixed(1); x.ok = true; }
      if (t != null) x.t[h] = +t.toFixed(1);
    }
  });
  return out;
}

const months = [];
for (let m = START.slice(0, 7); m <= yesterday.slice(0, 7); ) {
  const first = m + "-01", nxt = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 1)).toISOString().slice(0, 10);
  months.push({ m, from: first, to: addDays(nxt, -1) > yesterday ? yesterday : addDays(nxt, -1) });
  m = nxt.slice(0, 7);
}
const all = process.argv.includes("--all");
mkdirSync("data", { recursive: true });
const recent = months.slice(-2).map((x) => x.m);
for (const mo of months) {
  const file = `data/${mo.m}.json`;
  if (!all && existsSync(file) && !recent.includes(mo.m)) {
    const c = JSON.parse(readFileSync(file, "utf8"));
    const complete = sites.every((s) => Object.values(c.wx[s.key] || {}).filter((d) => d.ok && d.src === "era5").length >= Object.keys(c.px).length) && c.to === mo.to;
    if (complete) continue;
  }
  console.log("month", mo.m, mo.from, "→", mo.to);
  const px = await prices(mo.from, mo.to);
  const wx = await weather("https://archive-api.open-meteo.com/v1/archive", mo.from, mo.to);
  const missing = [];
  for (let d = mo.from; d <= mo.to; d = addDays(d, 1)) if (!sites.every((s) => wx[s.key]?.[d]?.ok)) missing.push(d);
  if (missing.length) {
    console.log("  ERA5 missing", missing.length, "days; using ECMWF IFS forecast");
    const fb = await weather("https://historical-forecast-api.open-meteo.com/v1/forecast", missing[0], missing[missing.length - 1], "ecmwf_ifs025");
    for (const s of sites) for (const d of missing) if (fb[s.key]?.[d]) wx[s.key][d] = fb[s.key][d];
  }
  writeFileSync(file, JSON.stringify({ v: 1, month: mo.m, to: mo.to, updated: new Date().toISOString(), px, wx }));
  await sleep(4000);
}
writeFileSync("data/index.json", JSON.stringify({ updated: new Date().toISOString(), through: yesterday, months: months.map((x) => x.m) }));
console.log("done through", yesterday);
