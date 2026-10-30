// Shared by every page: config, encryption, and reading/writing files in this GitHub repo.
//
// Your answers are encrypted on the device (AES-256-GCM, key derived from your passphrase with
// PBKDF2-SHA256) before they're uploaded, so the public repo only ever holds ciphertext.

const enc = new TextEncoder(), dec = new TextDecoder();
const LOG = "data/log.enc.json";
const KEYINFO = "data/keyinfo.json";
const SUBS = "push/subscriptions.json";
export const VAPID_PUBLIC = "push/vapid-public.txt";
const ITERATIONS = 600000;

// ---------- small helpers ----------

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

// Pages URL looks like https://<owner>.github.io/<repo>/. "dev_repo"/"api_base" are only for local testing.
export const repo = (() => {
  const dev = store.get("dev_repo");
  if (dev) { const [owner, name] = dev.split("/"); return { owner, name }; }
  return { owner: location.hostname.split(".")[0], name: location.pathname.split("/").filter(Boolean)[0] };
})();
const API = store.get("api_base") || "https://api.github.com";
const TOKEN_KEY = `gh_token:${repo.owner}/${repo.name}`;

export const token = {
  get: () => store.get(TOKEN_KEY),
  set: (v) => store.set(TOKEN_KEY, v.trim()),
  clear: () => store.del(TOKEN_KEY),
};

export function toB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromB64(s) {
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export const toB64url = (bytes) => toB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const fromB64url = (s) => fromB64(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));

export const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export async function loadConfig() {
  return fetch("config.json", { cache: "no-store" }).then((r) => r.json());
}

// Check-ins made before the rollover hour (default 4 AM) count toward the previous day.
export function logicalToday(cfg) {
  const d = new Date();
  if (d.getHours() < (cfg.day_rollover_hour ?? 4)) d.setDate(d.getDate() - 1);
  return ymd(d);
}

export function registerServiceWorker() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}

// ---------- GitHub contents API ----------

async function gh(path, opts = {}) {
  const headers = { Accept: "application/vnd.github+json" };
  const t = token.get();
  if (t) headers.Authorization = `Bearer ${t}`;
  if (opts.body) headers["Content-Type"] = "application/json";
  return fetch(`${API}/repos/${repo.owner}/${repo.name}${path}`, { ...opts, headers, cache: "no-store" });
}

async function failure(r) {
  const msg = (await r.json().catch(() => ({}))).message || r.statusText;
  if (r.status === 401) return new Error("GitHub rejected the access token. Re-enter it on the Setup page.");
  if (r.status === 403 && /rate limit/i.test(msg)) return new Error("GitHub rate limit hit. Add your token on the Setup page, or wait an hour.");
  if (r.status === 403 || r.status === 404) return new Error(`GitHub says: ${msg}. Check the token has Contents: Read and write on ${repo.name}.`);
  return new Error(`GitHub error ${r.status}: ${msg}`);
}

export async function checkRepoAccess() {
  const r = await gh("");
  if (!r.ok) throw await failure(r);
  return r.json();
}

export async function readFile(path) {
  const r = await gh(`/contents/${path}`);
  if (r.status === 404) return null;
  if (!r.ok) throw await failure(r);
  const j = await r.json();
  return { sha: j.sha, text: dec.decode(fromB64(j.content.replace(/\s/g, ""))) };
}

export async function writeFile(path, text, message, sha) {
  if (!token.get()) throw new Error("This device isn't connected to GitHub yet. Open Setup and add your token.");
  const r = await gh(`/contents/${path}`, {
    method: "PUT",
    body: JSON.stringify({ message, content: toB64(enc.encode(text)), ...(sha && { sha }) }),
  });
  if (r.status === 409 || r.status === 422) throw Object.assign(new Error("Save conflict"), { conflict: true });
  if (!r.ok) throw await failure(r);
  return (await r.json()).content.sha;
}

// Read-modify-write with retry, so two devices saving at once don't clobber each other.
async function updateJSON(path, message, change) {
  for (let i = 0; i < 3; i++) {
    const f = await readFile(path);
    const next = await change(f ? JSON.parse(f.text) : null);
    try { await writeFile(path, typeof next === "string" ? next : JSON.stringify(next, null, 2), message, f?.sha); return next; }
    catch (e) { if (!e.conflict) throw e; }
  }
  throw new Error("Couldn't save (the file kept changing). Try again.");
}

// ---------- encryption ----------

async function deriveKey(pass, salt, iterations) {
  const base = await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function seal(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(value)));
  return { iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}

async function unseal(key, box) {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(box.iv) }, key, fromB64(box.ct));
  return JSON.parse(dec.decode(pt));
}

// The derived key is kept in IndexedDB as a non-extractable CryptoKey: usable on this device, never readable as bytes.
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("health-checkin", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(k) {
  try {
    const db = await idb();
    return await new Promise((res, rej) => {
      const q = db.transaction("kv").objectStore("kv").get(k);
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
    });
  } catch { return undefined; }
}
async function idbSet(k, v) {
  try {
    const db = await idb();
    await new Promise((res, rej) => {
      const t = db.transaction("kv", "readwrite");
      t.objectStore("kv").put(v, k);
      t.oncomplete = res; t.onerror = () => rej(t.error);
    });
  } catch {}
}

const KEY_SLOT = `key:${repo.owner}/${repo.name}`;
let cachedKey = null;

export async function getKeyInfo() {
  const f = await readFile(KEYINFO);
  return f ? JSON.parse(f.text) : null;
}

async function rememberedKey(info) {
  if (cachedKey?.salt === info.salt) return cachedKey.key;
  const saved = await idbGet(KEY_SLOT);
  if (saved?.salt === info.salt) { cachedKey = saved; return saved.key; }
  return null;
}

async function remember(info, key) {
  cachedKey = { salt: info.salt, key };
  await idbSet(KEY_SLOT, cachedKey);
}

export async function forgetKey() {
  cachedKey = null;
  await idbSet(KEY_SLOT, null);
}

export async function createVault(pass) {
  if (await getKeyInfo()) throw new Error("This repo already has a passphrase. Use Unlock instead.");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(pass, salt, ITERATIONS);
  const info = { v: 1, kdf: "PBKDF2-SHA256", iterations: ITERATIONS, salt: toB64(salt), check: await seal(key, "health-checkin") };
  await writeFile(KEYINFO, JSON.stringify(info, null, 2), "Set up encryption");
  if (!(await readFile(LOG))) await writeFile(LOG, JSON.stringify(await seal(key, { entries: {} })), "Create empty log");
  await remember(info, key);
  return key;
}

export async function unlock(pass, info) {
  info ||= await getKeyInfo();
  const key = await deriveKey(pass, fromB64(info.salt), info.iterations);
  try { await unseal(key, info.check); } catch { throw new Error("That passphrase doesn't match."); }
  await remember(info, key);
  return key;
}

export async function isUnlocked() {
  const info = await getKeyInfo();
  return !!(info && (await rememberedKey(info)));
}

// Returns the key, prompting for the passphrase if this device doesn't have it yet.
// Returns null if the repo hasn't been set up.
export async function requireKey() {
  const info = await getKeyInfo();
  if (!info) return null;
  return (await rememberedKey(info)) || askPassphrase(info);
}

function askPassphrase(info) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "modal";
    wrap.innerHTML = `<form class="modal-card">
      <h2>Unlock your log</h2>
      <p>Enter your passphrase. This device will remember it.</p>
      <input type="password" autocomplete="current-password" placeholder="Passphrase" required>
      <div class="err" role="alert"></div>
      <button class="btn primary">Unlock</button></form>`;
    document.body.append(wrap);
    const input = wrap.querySelector("input"), err = wrap.querySelector(".err"), btn = wrap.querySelector("button");
    input.focus();
    wrap.querySelector("form").addEventListener("submit", async (e) => {
      e.preventDefault();
      btn.disabled = true; btn.textContent = "Unlocking…"; err.textContent = "";
      try { const key = await unlock(input.value, info); wrap.remove(); resolve(key); }
      catch (x) { err.textContent = x.message; btn.disabled = false; btn.textContent = "Unlock"; input.select(); }
    });
  });
}

// ---------- the log ----------

// entries = { "YYYY-MM-DD": { answers: {...}, updated_at } }
export async function loadEntries(key) {
  const f = await readFile(LOG);
  if (!f) return {};
  return (await unseal(key, JSON.parse(f.text))).entries;
}

export async function saveEntry(key, date, answers) {
  let saved;
  // The commit message is the only plain-text trace of a check-in; the reminder job uses it to skip nudges.
  await updateJSON(LOG, `Check-in for ${date}`, async (box) => {
    const entries = box ? (await unseal(key, box)).entries : {};
    entries[date] = { answers, updated_at: new Date().toISOString() };
    saved = entries;
    return JSON.stringify(await seal(key, { entries }));
  });
  return saved;
}

// ---------- push ----------

export async function readVapidPublic() {
  return (await readFile(VAPID_PUBLIC))?.text.trim() || null;
}

export async function addSubscription(sub) {
  const s = sub.toJSON();
  await updateJSON(SUBS, "Add notification device", (list) => [
    ...(list || []).filter((x) => x.endpoint !== s.endpoint),
    { endpoint: s.endpoint, keys: s.keys, added: new Date().toISOString() },
  ]);
}

export const repoUrl = () => `https://github.com/${repo.owner}/${repo.name}`;
