/* Film Log storage: everything lives in IndexedDB on this device.
   - "docs":  path -> plain object   (rolls/<id>, rolls/<id>/shots/<id>, settings/<name>)
   - "blobs": id   -> { blob, type } (scans)
   - "kv":    key  -> anything       (folder handle, sync settings, tombstones)
   The `db` object mimics a tiny document-database API (doc/collection/onSnapshot)
   so the UI code stays independent of where the data lives. */
(() => {
"use strict";
const DB_NAME = "film-log", DB_VERSION = 1;
let idb = null;
const docs = new Map();          // in-memory copy of every document (the log is small)
const subs = new Set();          // snapshot listeners
const changeSubs = new Set();    // (paths[]) => void, fired after every write
const urls = new Map();          // blob id -> object URL

const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const txDone = tx => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = tx.onabort = () => rej(tx.error || new Error("Storage error")); });
const clone = v => JSON.parse(JSON.stringify(v));

function openIdb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => { const d = r.result; for (const s of ["docs", "blobs", "kv"]) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function open() {
  if (idb) return api;
  idb = await openIdb();
  const tx = idb.transaction("docs");
  const store = tx.objectStore("docs");
  const [keys, vals] = await Promise.all([req(store.getAllKeys()), req(store.getAll())]);
  keys.forEach((k, i) => docs.set(k, vals[i]));
  return api;
}

/* ---- documents ---- */
async function write(ops) {   // ops: [[path, data | null]]
  const tx = idb.transaction("docs", "readwrite");
  const store = tx.objectStore("docs");
  for (const [path, data] of ops) data === null ? store.delete(path) : store.put(data, path);
  await txDone(tx);
  for (const [path, data] of ops) data === null ? docs.delete(path) : docs.set(path, data);
  subs.forEach(f => { try { f(); } catch (e) { console.error(e); } });
  const paths = ops.map(o => o[0]);
  changeSubs.forEach(f => { try { f(paths); } catch (e) { console.error(e); } });
  if (navigator.storage && navigator.storage.persist && !write.asked) { write.asked = true; navigator.storage.persist().catch(() => {}); }
}
const listen = f => { subs.add(f); Promise.resolve().then(f); return () => subs.delete(f); };

function docRef(path) {
  return {
    collection: name => colRef(path + "/" + name),
    get: async () => ({ exists: docs.has(path), data: () => clone(docs.get(path)) }),
    set: data => write([[path, clone(data)]]),
    update: data => write([[path, { ...(docs.get(path) || {}), ...clone(data) }]]),
    delete: () => write([[path, null]]),
    onSnapshot: cb => listen(() => cb({ exists: docs.has(path), data: () => clone(docs.get(path)) })),
  };
}
function children(path) {
  const pre = path + "/", out = [];
  for (const [k, v] of docs) if (k.startsWith(pre) && !k.slice(pre.length).includes("/")) out.push({ id: k.slice(pre.length), data: () => clone(v) });
  return out;
}
function colRef(path) {
  const snap = () => ({ metadata: { fromCache: false, hasPendingWrites: false }, docs: children(path) });
  return { doc: id => docRef(path + "/" + id), get: async () => snap(), onSnapshot: cb => listen(() => cb(snap())) };
}
const db = { doc: docRef, collection: colRef };

/* ---- scans ---- */
const hex = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, "0")).join("");
async function putBlob(id, blob, type) {
  const tx = idb.transaction("blobs", "readwrite");
  tx.objectStore("blobs").put({ blob, type: type || blob.type || "image/jpeg" }, id);
  await txDone(tx);
}
async function getBlob(id) {
  if (!id) return null;
  const rec = await req(idb.transaction("blobs").objectStore("blobs").get(id));
  return rec ? (rec.blob.type ? rec.blob : new Blob([rec.blob], { type: rec.type })) : null;
}
const hasBlob = async id => !!(await req(idb.transaction("blobs").objectStore("blobs").getKey(id)));
async function blobUrl(id) {
  if (urls.has(id)) return urls.get(id);
  const b = await getBlob(id);
  if (!b) return "";
  const u = URL.createObjectURL(b); urls.set(id, u); return u;
}
const assets = {
  async upload(blob, opts) { const id = hex(16); await putBlob(id, blob, opts && opts.type); return { id, url: await blobUrl(id) }; },
  async delete(id) {
    const tx = idb.transaction("blobs", "readwrite"); tx.objectStore("blobs").delete(id); await txDone(tx);
    if (urls.has(id)) { URL.revokeObjectURL(urls.get(id)); urls.delete(id); }
  },
};

/* ---- small settings ---- */
const kv = {
  get: async key => req(idb.transaction("kv").objectStore("kv").get(key)),
  async set(key, val) { const tx = idb.transaction("kv", "readwrite"); tx.objectStore("kv").put(val, key); await txDone(tx); },
  async delete(key) { const tx = idb.transaction("kv", "readwrite"); tx.objectStore("kv").delete(key); await txDone(tx); },
};

/* ---- saving a file to the device ---- */
function saveFile(filename, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: type || "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
const downloads = { save: async ({ filename, data }) => saveFile(filename, data) };

/* ---- whole-log snapshots (used by folder backup, GitHub sync and backup files) ---- */
const SHOT_RE = /^rolls\/([^/]+)\/shots\/([^/]+)$/, ROLL_RE = /^rolls\/([^/]+)$/;
function rollIds() { const out = []; for (const k of docs.keys()) { const m = k.match(ROLL_RE); if (m) out.push(m[1]); } return out.sort(); }
function rollBundle(id) {
  const roll = docs.get("rolls/" + id); if (!roll) return null;
  const shots = children("rolls/" + id + "/shots").map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.n || 0) - (b.n || 0));
  return { format: "film-log-roll", version: 1, roll: { id, ...clone(roll) }, shots };
}
function settingsBundle() {
  const get = n => { const d = docs.get("settings/" + n); return d && Array.isArray(d.list) ? d.list.slice() : []; };
  return { format: "film-log-settings", version: 1, lenses: get("lenses"), cameras: get("cameras") };
}
const newer = (a, b) => String(a || "") > String(b || "");

/* Merge a roll bundle into the log. Nothing is deleted: frames that only exist here stay,
   and where a frame exists on both sides the one edited last wins. Returns what changed. */
async function mergeRoll(bundle) {
  if (!bundle || !bundle.roll || !bundle.roll.id) throw new Error("Not a Film Log roll file");
  const { id, ...roll } = bundle.roll;
  const ops = [], res = { id, roll: false, added: 0, updated: 0 };
  const cur = docs.get("rolls/" + id);
  if (!cur) { ops.push(["rolls/" + id, clone(roll)]); res.roll = true; }
  else if (newer(roll.updatedAt, cur.updatedAt)) { ops.push(["rolls/" + id, clone(roll)]); res.roll = true; }
  for (const s of bundle.shots || []) {
    const { id: sid, photoFile, ...shot } = s; if (!sid) continue;
    const path = `rolls/${id}/shots/${sid}`, old = docs.get(path);
    if (!old) { ops.push([path, clone(shot)]); res.added++; }
    else if (newer(shot.updatedAt, old.updatedAt)) { ops.push([path, clone(shot)]); res.updated++; }
  }
  if (ops.length) await write(ops);
  return res;
}
async function mergeSettings(b) {
  if (!b) return;
  for (const name of ["lenses", "cameras"]) {
    const inc = Array.isArray(b[name]) ? b[name] : []; if (!inc.length) continue;
    const cur = (docs.get("settings/" + name) || {}).list || [];
    const list = cur.concat(inc.filter(x => !cur.includes(x)));
    if (list.length !== cur.length) await write([["settings/" + name, { list }]]);
  }
}

const api = { open, db, assets, downloads, kv, saveFile, getBlob, putBlob, hasBlob, blobUrl,
  rollIds, rollBundle, settingsBundle, mergeRoll, mergeSettings,
  onChange: f => { changeSubs.add(f); return () => changeSubs.delete(f); },
  rollIdOfPath: p => { const m = p.match(SHOT_RE) || p.match(ROLL_RE); return m ? m[1] : null; },
  hasDoc: p => docs.has(p) };
window.FilmLogStore = api;
})();
