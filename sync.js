/* Film Log backup and sync. The log itself lives in IndexedDB (store.js); this file copies it
   to places that survive a wiped browser:
     1. a folder on the device (File System Access API, where the browser has it)
     2. a GitHub repository you own (optional, uses a personal access token)
     3. a single backup file you save and restore by hand
   All three use the same file layout:
     settings.json                      lenses and cameras
     rolls/<rollId>.json                the roll and its frames (source of truth)
     rolls/<rollId>.md                  the same roll as a readable Markdown table
     scans/<rollId>/<frame>-<id>.<ext>  scans attached to frames
   Copies are one-way pushes plus an explicit "restore" that merges; nothing is deleted on restore. */
(() => {
"use strict";
const S = window.FilmLogStore;
let toMarkdown = () => "";
const status = { folder: { state: "none", name: "", last: "", error: "" }, github: { state: "off", last: "", error: "", busy: false } };
const statusSubs = new Set();
const emit = () => statusSubs.forEach(f => { try { f(status); } catch (e) { console.error(e); } });
const stamp = () => new Date().toISOString();
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/tiff": "tif", "image/gif": "gif" };
const TYPE = Object.fromEntries(Object.entries(EXT).map(([t, e]) => [e, t]));
const textBlob = t => new Blob([t], { type: "text/plain;charset=utf-8" });
const pretty = o => JSON.stringify(o, null, 2) + "\n";

/* ---------- tombstones: rolls deleted here, so copies can drop them too ---------- */
async function tombstones() { const t = (await S.kv.get("tombstones")) || []; const live = new Set(S.rollIds()); return t.filter(id => !live.has(id)); }
async function addTombstone(id) { const t = (await S.kv.get("tombstones")) || []; if (!t.includes(id)) { t.push(id); await S.kv.set("tombstones", t); } }

/* ---------- the file layout ---------- */
async function buildFiles(includeScans) {
  const files = new Map();   // path -> Blob
  files.set("settings.json", textBlob(pretty(S.settingsBundle())));
  for (const id of S.rollIds()) {
    const b = S.rollBundle(id);
    for (const shot of b.shots) {
      if (!shot.photo) continue;
      const blob = await S.getBlob(shot.photo); if (!blob) continue;
      shot.photoFile = `scans/${id}/${String(shot.n || 0).padStart(2, "0")}-${shot.photo}.${EXT[blob.type] || "jpg"}`;
      if (includeScans) files.set(shot.photoFile, blob);
    }
    files.set(`rolls/${id}.json`, textBlob(pretty(b)));
    files.set(`rolls/${id}.md`, textBlob(toMarkdown(b.roll, b.shots)));
  }
  return files;
}

/* Push the log to a target. A target has: list() -> Map(path -> tag), same(path, blob, tag),
   write(path, blob, tag), remove(path, tag). Returns counts. */
async function push(target, includeScans) {
  const files = await buildFiles(includeScans);
  const remote = await target.list();
  const dead = new Set(await tombstones()), live = new Set(S.rollIds());
  const res = { written: 0, removed: 0 };
  for (const [path, blob] of files) {
    if (remote.has(path) && await target.same(path, blob, remote.get(path))) continue;
    await target.write(path, blob, remote.get(path)); res.written++;
  }
  for (const [path, tag] of remote) {
    if (files.has(path)) continue;
    let m, drop = false;
    if ((m = path.match(/^rolls\/([^/]+)\.(json|md)$/))) drop = dead.has(m[1]);
    else if ((m = path.match(/^scans\/([^/]+)\//))) drop = dead.has(m[1]) || (includeScans && live.has(m[1]));
    if (drop) { await target.remove(path, tag); res.removed++; }
  }
  return res;
}

/* Restore from a source. A source has: list() -> iterable of paths, text(path), blob(path). */
async function restore(source) {
  const listed = await source.list();
  const paths = Array.from(listed instanceof Map ? listed.keys() : listed);
  const res = { rolls: 0, added: 0, updated: 0, scans: 0 };
  if (paths.includes("settings.json")) { try { await S.mergeSettings(JSON.parse(await source.text("settings.json"))); } catch (e) {} }
  for (const p of paths.filter(p => /^rolls\/[^/]+\.json$/.test(p)).sort()) {
    const bundle = JSON.parse(await source.text(p));
    const r = await S.mergeRoll(bundle);
    if (r.roll || r.added || r.updated) res.rolls++;
    res.added += r.added; res.updated += r.updated;
    for (const shot of bundle.shots || []) {
      if (!shot.photo || !shot.photoFile || !paths.includes(shot.photoFile) || await S.hasBlob(shot.photo)) continue;
      const blob = await source.blob(shot.photoFile);
      const ext = shot.photoFile.split(".").pop().toLowerCase();
      await S.putBlob(shot.photo, blob, blob.type || TYPE[ext] || "image/jpeg"); res.scans++;
    }
  }
  return res;
}

/* ---------- 1. folder on this device ---------- */
const folderSupported = () => typeof window.showDirectoryPicker === "function";
let folderHandle = null;
async function perm(handle, ask) {
  if (!handle.queryPermission) return "granted";     // e.g. origin-private handles
  let p = await handle.queryPermission({ mode: "readwrite" });
  if (p !== "granted" && ask) p = await handle.requestPermission({ mode: "readwrite" });
  return p;
}
async function dirFor(root, path, create) {
  const parts = path.split("/"); const name = parts.pop(); let dir = root;
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create });
  return [dir, name];
}
function folderTarget(root) {
  return {
    async list() {
      const out = new Map();
      const walk = async (dir, prefix, depth) => {
        for await (const [name, h] of dir.entries()) {
          if (h.kind === "file") out.set(prefix + name, true);
          else if (depth < 2) await walk(h, prefix + name + "/", depth + 1);
        }
      };
      for await (const [name, h] of root.entries()) {
        if (h.kind === "file" && name === "settings.json") out.set(name, true);
        if (h.kind === "directory" && (name === "rolls" || name === "scans")) await walk(h, name + "/", 1);
      }
      return out;
    },
    async same(path, blob) {
      if (path.startsWith("scans/")) return true;        // scan file names carry their id, so they never change
      try { const [dir, name] = await dirFor(root, path, false); return await (await (await dir.getFileHandle(name)).getFile()).text() === await blob.text(); }
      catch (e) { return false; }
    },
    async write(path, blob) {
      const [dir, name] = await dirFor(root, path, true);
      const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await w.write(blob); await w.close();
    },
    async remove(path) { try { const [dir, name] = await dirFor(root, path, false); await dir.removeEntry(name); } catch (e) {} },
    text: async path => { const [dir, name] = await dirFor(root, path, false); return (await (await dir.getFileHandle(name)).getFile()).text(); },
    blob: async path => { const [dir, name] = await dirFor(root, path, false); return (await dir.getFileHandle(name)).getFile(); },
  };
}
async function refreshFolder() {
  const f = status.folder;
  if (!folderHandle) { f.state = folderSupported() ? "none" : "unsupported"; f.name = ""; }
  else { f.name = folderHandle.name || "folder"; try { f.state = (await perm(folderHandle, false)) === "granted" ? "ready" : "needs-permission"; } catch (e) { f.state = "needs-permission"; } }
  emit();
}
async function setFolder(handle) { folderHandle = handle; await S.kv.set("folder", handle); status.folder.error = ""; await refreshFolder(); }
async function chooseFolder() { const h = await window.showDirectoryPicker({ mode: "readwrite", id: "film-log" }); await setFolder(h); return h; }
async function forgetFolder() { folderHandle = null; await S.kv.delete("folder"); status.folder.last = ""; await refreshFolder(); }
async function reconnectFolder() { if (!folderHandle) return false; const ok = (await perm(folderHandle, true)) === "granted"; await refreshFolder(); if (ok) queue("folder"); return ok; }
async function folderHasData() { if (!folderHandle) return false; const l = await folderTarget(folderHandle).list(); return Array.from(l.keys()).some(p => /^rolls\/[^/]+\.json$/.test(p)); }
async function pushFolder() {
  if (!folderHandle || (await perm(folderHandle, false)) !== "granted") { await refreshFolder(); throw new Error("Folder access is needed again"); }
  const r = await push(folderTarget(folderHandle), true);
  status.folder.last = stamp(); status.folder.error = ""; await S.kv.set("folderLast", status.folder.last); emit();
  return r;
}
async function restoreFolder() {
  if (!folderHandle || (await perm(folderHandle, true)) !== "granted") throw new Error("Folder access is needed");
  return restore(folderTarget(folderHandle));
}

/* ---------- 2. GitHub repository ---------- */
let gh = null;   // { owner, repo, branch, token, scans, auto }
const b64FromBlob = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1] || ""); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
function bytesFromB64(b64) { const bin = atob(b64.replace(/\s/g, "")); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
async function gitSha(blob) {
  const body = new Uint8Array(await blob.arrayBuffer());
  const head = new TextEncoder().encode(`blob ${body.length}\0`);
  const all = new Uint8Array(head.length + body.length); all.set(head); all.set(body, head.length);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-1", all)), b => b.toString(16).padStart(2, "0")).join("");
}
async function ghApi(cfg, path, opts = {}) {
  const r = await fetch(`https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}${path}`, {
    method: opts.method || "GET", cache: "no-store",
    headers: { Authorization: "Bearer " + cfg.token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(opts.body ? { "Content-Type": "application/json" } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (opts.allow && opts.allow.includes(r.status)) return { status: r.status, data: null };
  if (!r.ok) {
    let msg = ""; try { msg = (await r.json()).message || ""; } catch (e) {}
    const hint = r.status === 401 ? "The token was rejected. Check that it is complete and not expired"
      : r.status === 403 ? "GitHub refused. The token needs “Contents: Read and write” for this repository"
      : r.status === 404 ? "Repository not found. Check owner, name and that the token covers this repository"
      : r.status === 409 ? "GitHub reported a conflict. Try again" : `GitHub error ${r.status}`;
    const e = new Error(hint + (msg && r.status >= 422 ? ` (${msg})` : "")); e.status = r.status; throw e;
  }
  return { status: r.status, data: r.status === 204 ? null : await r.json() };
}
const ghPath = p => p.split("/").map(encodeURIComponent).join("/");
function githubTarget(cfg) {
  const branch = cfg.branch || "main"; let empty = false; const shas = new Map();
  const msg = verb => `Film log: ${verb}`;
  return {
    async list() {
      const r = await ghApi(cfg, `/git/trees/${encodeURIComponent(branch)}?recursive=1`, { allow: [404, 409] });
      shas.clear();
      if (!r.data) { empty = true; return shas; }
      for (const t of r.data.tree || []) if (t.type === "blob") shas.set(t.path, t.sha);
      return shas;
    },
    same: async (path, blob, sha) => sha === await gitSha(blob),
    async write(path, blob, sha) {
      const body = { message: msg("update " + path), content: await b64FromBlob(blob) };
      if (sha) body.sha = sha;
      if (!empty) body.branch = branch;      // an empty repository gets its first commit on its default branch
      await ghApi(cfg, "/contents/" + ghPath(path), { method: "PUT", body }); empty = false;
    },
    async remove(path, sha) { await ghApi(cfg, "/contents/" + ghPath(path), { method: "DELETE", body: { message: msg("remove " + path), sha, branch }, allow: [404] }); },
    async text(path) { return new TextDecoder().decode(await this.bytes(path)); },
    async blob(path) { const ext = path.split(".").pop().toLowerCase(); return new Blob([await this.bytes(path)], { type: TYPE[ext] || "application/octet-stream" }); },
    async bytes(path) { const r = await ghApi(cfg, "/git/blobs/" + shas.get(path)); return bytesFromB64(r.data.content); },
  };
}
function refreshGithub() { status.github.state = gh && gh.owner && gh.repo && gh.token ? "on" : "off"; emit(); }
async function setGithub(cfg) { gh = cfg; if (cfg) await S.kv.set("github", cfg); else { await S.kv.delete("github"); status.github.last = ""; } status.github.error = ""; refreshGithub(); }
async function testGithub(cfg) {
  const r = await ghApi(cfg, "");
  return { private: !!r.data.private, canPush: !r.data.permissions || !!r.data.permissions.push, defaultBranch: r.data.default_branch, name: r.data.full_name };
}
async function pushGithub() {
  if (!gh) throw new Error("GitHub sync is not set up");
  const r = await push(githubTarget(gh), !!gh.scans);
  status.github.last = stamp(); status.github.error = ""; await S.kv.set("githubLast", status.github.last);
  return r;
}
async function restoreGithub() { if (!gh) throw new Error("GitHub sync is not set up"); return restore(githubTarget(gh)); }

/* ---------- 3. one backup file ---------- */
async function backupFile(includeScans) {
  const files = await buildFiles(includeScans), out = { format: "film-log-backup", version: 1, exportedAt: stamp(), files: {}, scans: {} };
  for (const [path, blob] of files) {
    if (path.endsWith(".md")) continue;
    if (path.startsWith("scans/")) out.scans[path] = await b64FromBlob(blob); else out.files[path] = JSON.parse(await blob.text());
  }
  return JSON.stringify(out);
}
async function restoreBackup(text) {
  let b; try { b = JSON.parse(text); } catch (e) { throw new Error("This is not a Film Log backup file"); }
  if (b && b.format === "film-log-roll") b = { format: "film-log-backup", files: { [`rolls/${b.roll.id}.json`]: b }, scans: {} };
  if (!b || b.format !== "film-log-backup" || !b.files) throw new Error("This is not a Film Log backup file");
  const scans = b.scans || {};
  return restore({
    list: () => Object.keys(b.files).concat(Object.keys(scans)),
    text: async p => JSON.stringify(b.files[p]),
    blob: async p => new Blob([bytesFromB64(scans[p])], { type: TYPE[p.split(".").pop().toLowerCase()] || "image/jpeg" }),
  });
}

/* ---------- automatic runs: one at a time per target, re-run if something changed meanwhile ---------- */
const jobs = { folder: { run: pushFolder, delay: 1500 }, github: { run: pushGithub, delay: 20000 } };
function queue(name, delay) {
  const j = jobs[name]; clearTimeout(j.timer);
  j.timer = setTimeout(() => runJob(name), delay === undefined ? j.delay : delay);
}
async function runJob(name) {
  const j = jobs[name];
  if (j.running) { j.again = true; return; }
  if (name === "github" && !navigator.onLine) { j.pending = true; return; }
  j.running = true; j.pending = false; if (name === "github") { status.github.busy = true; emit(); }
  try { await j.run(); }
  catch (e) { status[name].error = e.message || String(e); if (name === "folder") await refreshFolder().catch(() => {}); }
  j.running = false; if (name === "github") status.github.busy = false;
  emit();
  if (j.again) { j.again = false; queue(name); }
}
async function syncNow(name) { clearTimeout(jobs[name].timer); await runJob(name); if (status[name].error) throw new Error(status[name].error); }

async function init(markdownFn) {
  toMarkdown = markdownFn;
  try { folderHandle = (await S.kv.get("folder")) || null; } catch (e) { folderHandle = null; }
  gh = (await S.kv.get("github")) || null;
  status.folder.last = (await S.kv.get("folderLast")) || ""; status.github.last = (await S.kv.get("githubLast")) || "";
  await refreshFolder(); refreshGithub();
  S.onChange(paths => {
    for (const p of paths) { const m = p.match(/^rolls\/([^/]+)$/); if (m && !S.hasDoc(p)) addTombstone(m[1]); }
    if (status.folder.state === "ready") queue("folder");
    if (gh && gh.auto && status.github.state === "on") queue("github");
  });
  window.addEventListener("online", () => { if (jobs.github.pending) queue("github", 2000); });
  if (status.folder.state === "ready") queue("folder", 3000);
  if (gh && gh.auto) queue("github", 6000);
}

window.FilmLogSync = { init, status, onStatus: f => { statusSubs.add(f); return () => statusSubs.delete(f); },
  folderSupported, chooseFolder, setFolder, forgetFolder, reconnectFolder, folderHasData, restoreFolder,
  github: () => gh, setGithub, testGithub, restoreGithub, syncNow, backupFile, restoreBackup };
})();
