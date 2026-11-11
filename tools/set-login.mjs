// Sets the single login and password: encrypts farms.private.json -> data.enc.json.
// The key is derived from "login:password", so both are needed to open the app.
//
//   node tools/set-login.mjs                      (asks for login and password, input hidden)
//   node tools/set-login.mjs <login> "<password>" (non-interactive)
//
// Run from the repository root, then commit and push data.enc.json.
import { readFileSync, writeFileSync } from "node:fs";
import { webcrypto as crypto } from "node:crypto";
import readline from "node:readline";

function ask(q, hidden) {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (s) => { if (s.includes(q)) rl.output.write(s); else rl.output.write(""); };
    rl.question(q, (a) => { rl.close(); if (hidden) process.stdout.write("\n"); res(a); });
  });
}

let [login, password] = process.argv.slice(2);
if (!login) login = await ask("Login: ");
if (!password) {
  password = await ask("Password (min. 10 characters): ", true);
  const again = await ask("Repeat password: ", true);
  if (again !== password) { console.error("Passwords do not match."); process.exit(1); }
}
login = (login || "").trim().toLowerCase();
if (!login || !password || password.length < 10) { console.error("Login required and password must have at least 10 characters."); process.exit(1); }

const ITER = 310000;
const plain = readFileSync("farms.private.json", "utf8");
JSON.parse(plain);
const enc = new TextEncoder();
const salt = crypto.getRandomValues(new Uint8Array(16));
const iv = crypto.getRandomValues(new Uint8Array(12));
const base = await crypto.subtle.importKey("raw", enc.encode(login + ":" + password), "PBKDF2", false, ["deriveKey"]);
const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: ITER, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plain)));
const b64 = (u) => Buffer.from(u).toString("base64");
writeFileSync("data.enc.json", JSON.stringify({ v: 2, kdf: "PBKDF2-SHA256", input: "login:password", iter: ITER, salt: b64(salt), iv: b64(iv), ct: b64(ct) }, null, 1) + "\n");
console.log(`Done. Login "${login}" set. Commit and push data.enc.json; the old login stops working after the deploy.`);
