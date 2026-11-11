// Prints the SITES secret (unique site coordinates) from farms.private.json.
//   node tools/sites-secret.mjs | gh secret set SITES
import { readFileSync } from "node:fs";
const u = {};
for (const f of JSON.parse(readFileSync("farms.private.json", "utf8")).farms) u[f.lat.toFixed(4) + "," + f.lon.toFixed(4)] = { lat: f.lat, lon: f.lon };
process.stdout.write(JSON.stringify(Object.values(u)));
