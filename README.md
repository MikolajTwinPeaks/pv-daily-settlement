# PV Daily Settlement

Static web app that estimates, for any day since 1 January 2026, the output of each PV farm in the portfolio, the sale price, the auction reference price and the resulting daily auction settlement (whether the settlement agent pays the farms or the farms pay back).

No server, no build step. Runs on GitHub Pages. Code: `core.js` (data and calculation), `ui.js` (hash-routed pages: Overview, Day, Farm-day, Year, Month, Farms, Farm, Method, Assumptions).

Photography in `img/` is licensed from Adobe Stock (standard licence). Keep the repository private, or replace the images, if the licence terms do not allow redistributing the files in a public repository.

## Access (one login, no user accounts)

There is a single login and password. The portfolio data (farm names, locations, capacities, calibration) lives only in `data.enc.json`, encrypted with AES-256-GCM; the key is derived from `login:password` with PBKDF2-SHA256 (310,000 iterations). Without both, the repository shows code only.

Change the login or password (or farm data in `farms.private.json`):

```bash
node tools/set-login.mjs            # asks for login and password, input hidden
git add data.enc.json && git commit -m "Change login" && git push
```

The old login stops working once GitHub Pages redeploys (about a minute). `farms.private.json` and `PASSWORD.local.txt` are in `.gitignore` and must never be pushed.

## Deploy on GitHub Pages

```bash
git init && git add . && git commit -m "PV daily settlement"
gh repo create <name> --private --source . --push     # or --public
# Settings → Pages → Deploy from branch → main / root
```

Pages on a private repository requires a paid GitHub plan. On a public repository the code is visible but the data stays encrypted.

## Data sources (fetched in the browser)

| What | Source |
|---|---|
| Day-ahead prices, 15-min (RCE PLN = SDAC price for Poland) | PSE API `api.raporty.pse.pl/api/rce-pln` |
| Irradiance on a 30° south plane, air temperature, hourly | Open-Meteo Archive API, ERA5 reanalysis (same source as the PR calibration); ECMWF IFS historical forecast for days ERA5 has not covered yet (CC BY 4.0; free tier is for non-commercial use) |

Closed months are cached in the browser (localStorage), so after the first load only the current month is fetched.

## Method

- **Production**: hourly `GTI/1000 × kWp × PR × temperature factor × degradation × availability`, capped at the export limit. PR is calibrated per farm so that 2023 modelled output equals metered 2023 output.
- **TGeBase**: official TGE values from `tgebase.json` where available (add new days there and push); otherwise a proxy, the arithmetic mean of the day's RCE prices (0.8% mean absolute difference on 18 checked days). A manual value per day (Day view, stored in the browser) takes precedence. TGE keeps only about six weeks of sessions publicly, so add values regularly.
- **Sale price**: default 0.60 × TGeBase (editable), or hourly price × hourly output.
- **Auction settlement** (art. 93 ust. 2 OZE, daily): `(auction price − TGeBase) × eligible energy`. Positive → the settlement agent (ZRSA) pays; negative → the farm returns the difference. Energy in negative-price runs of ≥ 6 h is excluded (pre-28.12.2024 auctions; switchable).
- Auction price 2026: 493.87 PLN/MWh (CPI-indexed, editable).

All figures are monitoring estimates, not settlement documents.
