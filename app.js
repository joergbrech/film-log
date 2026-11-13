/* Film Log: the user interface. Data access goes through store.js, backups through sync.js. */
(() => {
"use strict";
const VERSION = "1.0.2";   // keep in step with CACHE in sw.js
const Store = window.FilmLogStore, Sync = window.FilmLogSync;
const METERING = ["Luxmeter app", "Kept settings", "Sunny 16", "Guessed", "Luxmeter + guess", "Other"];
const APERTURES = ["1.8", "2", "2.8", "4", "5.6", "8", "11", "16"];
const SHUTTERS = ["1/1000", "1/500", "1/250", "1/125", "1/60", "1/30", "1/15", "1/8", "1/4", "1/2", "1s", "B"];
const STOCKS = ["Kodak Gold 200", "Kodak Ultramax 400", "Kodak Portra 400", "Kodak ColorPlus 200", "Fujifilm 400", "Ilford HP5 Plus 400", "Ilford FP4 Plus 125", "Kodak Tri-X 400", "Cinestill 800T"];

let db = null, downloads = null, assets = null;
const DEFAULT_LENSES = ["Super Takumar 55mm f/1.8"];
let lenses = DEFAULT_LENSES.slice();
let cameras = ["Praktica"];
let rolls = [], rollsLoaded = false;
let shots = [], shotsFor = null, unsubShots = null;
let currentId = null;
let sheetOpen = false;

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = n => String(n).padStart(2, "0");
const nowParts = () => { const d = new Date(); return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` }; };
const newId = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const fmtDate = d => { if (!d) return ""; const [y, m, dd] = d.split("-"); return `${dd}.${m}.${y}`; };
const shutterLabel = s => s || "";
const apLabel = a => a ? "f/" + a : "";

/* ---------- light / EV ----------
   All EV values are EV at ISO 100 (the scale light meter apps use).
   Settings EV = log2(N²/t) − log2(ISO/100). Incident lux → EV: log2(lux / 2.5). */
const toNum = v => { const x = parseFloat(String(v ?? "").replace(",", ".")); return isFinite(x) ? x : null; };
const apNum = a => { const m = String(a ?? "").match(/\d+(?:[.,]\d+)?/g); if (!m) return null; const v = m.map(toNum); return v.reduce((x, y) => x + y, 0) / v.length; };
function shutterSec(sh) {
  const t = String(sh ?? "").trim(); let m;
  if ((m = t.match(/^1\s*\/\s*(\d+(?:[.,]\d+)?)/))) return 1 / toNum(m[1]);
  if ((m = t.match(/^(\d+(?:[.,]\d+)?)\s*(s|sec|")/i))) return toNum(m[1]) || null;
  if ((m = t.match(/^(\d+(?:[.,]\d+)?)$/))) { const v = toNum(m[1]); return v >= 2 ? 1 / v : v || null; }
  return null;
}
function rollIso(r) { const v = toNum(r && r.iso); if (v > 0) return v; const m = String((r && r.stock) || "").match(/(\d{2,4})\D*$/); return m ? +m[1] : 100; }
function settingsEV(s, iso) { const N = apNum(s.aperture), t = shutterSec(s.shutter); return N && t ? Math.log2(N * N / t) - Math.log2(iso / 100) : null; }
function meterEV(s) { const v = toNum(s.meterValue); if (v === null) return null; if (s.meterUnit === "EV") return v; return v > 0 ? Math.log2(v / 2.5) : null; }
const guessEV = s => toNum(s.guessEV);
const r1 = v => (Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, "").replace(/^-0$/, "0");
const stopsWord = a => r1(a) === "1" ? "stop" : "stops";
function expoVerdict(d) { const a = Math.abs(d); if (a < 0.25) return ["on", "matches meter"]; return [d > 0 ? "over" : "under", `${r1(a)} ${stopsWord(a)} ${d > 0 ? "over" : "under"}`]; }
function guessVerdict(d) { const a = Math.abs(d); if (a < 0.25) return ["on", "guess spot on"]; return [a <= 1 ? "on" : "over", `guess ${r1(a)} ${stopsWord(a)} too ${d > 0 ? "bright" : "dark"}`]; }
function evParts(s, iso) {
  const se = settingsEV(s, iso), me = meterEV(s), ge = guessEV(s), out = [];
  if (se !== null) out.push(["", "EV " + r1(se)]);
  if (me !== null) { out.push(["", "meter " + r1(me)]); if (se !== null) out.push(expoVerdict(me - se)); }
  if (ge !== null) out.push(me !== null ? guessVerdict(ge - me) : ["", "guessed " + r1(ge)]);
  return out;
}
const evLineHTML = (s, iso) => { const p = evParts(s, iso); return p.length ? `<span class="ev-line">${p.map(([c, t]) => `<span class="${c}">${esc(t)}</span>`).join("")}</span>` : ""; };
/* ---------- location ----------
   Stored as one string "lat, lon" (5 decimals, about 1 m) plus locAcc in metres when it came from GPS. */
let geoOn = false;   // the "Tag where I am" switch, remembered from frame to frame
const geoPref = () => geoOn;
const setGeoPref = on => { geoOn = !!on; Store.kv.set("geoTag", geoOn).catch(() => {}); };
function parseLoc(t) {
  const m = String(t ?? "").match(/(-?\d+(?:\.\d+)?)\s*°?\s*([NS])?\s*[,; ]\s*(-?\d+(?:\.\d+)?)\s*°?\s*([EW])?/i);
  if (!m) return null;
  let lat = parseFloat(m[1]), lon = parseFloat(m[3]);
  if (m[2] && /s/i.test(m[2])) lat = -Math.abs(lat);
  if (m[4] && /w/i.test(m[4])) lon = -Math.abs(lon);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}
const fmtLoc = (lat, lon) => `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
function mapURL(loc) { const p = parseLoc(loc); return p ? `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lon}#map=16/${p.lat}/${p.lon}` : ""; }
const mapLinkHTML = (loc, label) => { const u = mapURL(loc); return u ? `<a class="loc-link" href="${esc(u)}" target="_blank" rel="noopener">${esc(label || "Map · " + loc)}</a>` : ""; };
function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("This browser can’t share its location"));
    navigator.geolocation.getCurrentPosition(p => resolve(p.coords), e => reject(new Error(
      e.code === 1 ? "Location is blocked. Tap the icon left of the address bar (or Android Settings › Apps › this app › Permissions) and allow location" : e.code === 3 ? "No GPS fix yet, try again" : "Location unavailable")),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 });
  });
}
function meterLabel(s) { const v = String(s.meterValue ?? "").trim(); return v ? `${v} ${s.meterUnit === "EV" ? "EV" : "lux"}` : ""; }

function toast(msg) {
  const host = $("#toastHost");
  host.innerHTML = `<div class="toast" role="status">${esc(msg)}</div>`;
  clearTimeout(toast.t); toast.t = setTimeout(() => host.innerHTML = "", 2600);
}

/* ---------- data ---------- */
function shotsCol(rollId) { return db.doc("rolls/" + rollId).collection("shots"); }

function subscribeShots(rollId) {
  if (shotsFor === rollId) return;
  if (unsubShots) unsubShots();
  shots = []; shotsFor = rollId;
  if (!db || !rollId) return;
  unsubShots = shotsCol(rollId).onSnapshot(snap => {
    shots = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    render();
    if (!snap.metadata.fromCache && !snap.metadata.hasPendingWrites) syncCount(rollId, shots);
  }, e => { toast("Couldn’t load shots (" + e.code + ")"); });
}

async function saveRoll(roll) {
  const { id, ...data } = roll;
  data.updatedAt = new Date().toISOString();
  await db.doc("rolls/" + id).set(data);
}
async function saveShot(rollId, shot) {
  const { id, ...data } = shot;
  await shotsCol(rollId).doc(id).set(data);
}
async function syncCount(rollId, list) {
  const r = rolls.find(x => x.id === rollId); if (!r) return;
  const count = list.length;
  const dates = list.map(x => x.date).filter(Boolean).sort();
  const firstShot = dates[0] || "", lastShot = dates[dates.length - 1] || "";
  if (r.shotCount !== count || (r.firstShot || "") !== firstShot || (r.lastShot || "") !== lastShot) {
    try { await db.doc("rolls/" + rollId).update({ shotCount: count, firstShot, lastShot }); } catch (e) {}
  }
}

/* ---------- routing ---------- */
function route() {
  const m = location.hash.match(/^#roll-([A-Za-z0-9-]+)$/);
  currentId = m ? m[1] : null;
  if (!currentId && rollsLoaded && !route.didAuto) {
    route.didAuto = true;
    const loaded = rolls.filter(r => r.status !== "archived");
    if (loaded.length === 1 && !location.hash) { currentId = loaded[0].id; history.replaceState(null, "", "#roll-" + currentId); }
  }
  subscribeShots(currentId);
  render();
}
window.addEventListener("hashchange", route);

/* ---------- render ---------- */
function hydrateBlobs(root) {
  root.querySelectorAll("img[data-blob]").forEach(async img => {
    const id = img.dataset.blob; img.removeAttribute("data-blob");
    const url = await Store.blobUrl(id);
    if (url) { img.src = url; img.hidden = false; }
  });
}
const fmtStamp = iso => { if (!iso) return "never"; const d = new Date(iso); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
function bannerHTML() {
  const st = Sync.status;
  if (st.folder.state === "needs-permission") return `<div class="banner warn">Your backup folder “${esc(st.folder.name)}” needs access again. <button class="btn small" data-banner="reconnect">Reconnect</button></div>`;
  if (st.folder.error) return `<div class="banner warn">Folder backup failed: ${esc(st.folder.error)}. <button class="btn small" data-banner="settings">Settings</button></div>`;
  if (st.github.error) return `<div class="banner warn">GitHub sync failed: ${esc(st.github.error)}. <button class="btn small" data-banner="settings">Settings</button></div>`;
  if (rolls.length && st.folder.state !== "ready" && st.github.state !== "on" && !backupFileLast)
    return `<div class="banner">This log only lives in this browser on this device. <button class="btn small" data-banner="settings">Set up a backup</button></div>`;
  return "";
}
function wireBanner(main) {
  main.querySelectorAll("[data-banner]").forEach(b => b.onclick = async () => {
    if (b.dataset.banner === "reconnect") { try { if (await Sync.reconnectFolder()) toast("Folder reconnected"); } catch (e) { toast("Couldn’t reconnect"); } }
    else openSettings();
  });
}
function render() {
  const main = $("#main");
  $("#backBtn").hidden = !currentId;
  $("#newRollBtn").hidden = !!currentId;
  $("#settingsBtn").hidden = !!currentId;
  if (!db) { return; }
  if (!rollsLoaded) { main.innerHTML = `<p class="status">Loading your rolls…</p>`; return; }
  if (currentId) renderRoll(main); else renderList(main);
  main.insertAdjacentHTML("afterbegin", bannerHTML());
  wireBanner(main); hydrateBlobs(main);
}

function rollRange(r) {
  const a = r.firstShot, b = r.lastShot;
  if (!a) return "";
  const [ay, am, ad] = a.split("-"), [by, bm, bd] = (b || a).split("-");
  if (a === b || !b) return `${ad}.${am}.${ay}`;
  return ay === by ? `${ad}.${am}. – ${bd}.${bm}.${by}` : `${ad}.${am}.${ay} – ${bd}.${bm}.${by}`;
}
const DEV = [["devLab", "Lab"], ["devOptions", "Development options"], ["devSent", "Sent to lab"], ["devBack", "Back from lab"], ["devNotes", "Development notes"]];
function devBlock(r) {
  const rows = DEV.filter(([k]) => r[k]).map(([k, l]) => `<div class="dev-row"><span class="lbl">${l}</span><span>${esc(k === "devSent" || k === "devBack" ? fmtDate(r[k]) : r[k])}</span></div>`);
  return rows.length ? `<div class="dev-card"><div class="edge">Development</div>${rows.join("")}</div>` : "";
}
function rollMeta(r) {
  const bits = [r.camera || "No camera set"];
  if (r.loadedOn) bits.push("loaded " + fmtDate(r.loadedOn));
  if (r.status === "archived" && r.archivedOn) bits.push("archived " + fmtDate(r.archivedOn));
  return bits.join(" · ");
}

function renderList(main) {
  $("#topTitle").textContent = "Film log";
  const loaded = rolls.filter(r => r.status !== "archived").sort((a, b) => (b.loadedOn || "").localeCompare(a.loadedOn || ""));
  const archived = rolls.filter(r => r.status === "archived").sort((a, b) => (b.archivedOn || b.loadedOn || "").localeCompare(a.archivedOn || a.loadedOn || ""));
  const card = r => `<button class="roll-card" data-open="${esc(r.id)}">
      <span class="name">${esc(r.stock || "Untitled roll")}</span>
      <span class="count">${r.shotCount ?? 0}/${r.exposures || 36}</span>
      ${rollRange(r) ? `<span class="range">${esc(rollRange(r))}</span>` : ""}
      <span class="meta">${r.status !== "archived" ? '<span class="pill loaded">In camera</span> ' : ""}${esc(rollMeta(r))}</span>
    </button>`;
  if (!rolls.length) {
    main.innerHTML = `<p class="status">No rolls yet. Tap “+ Roll” when you load a film, then log each frame as you shoot it.</p>
      <div class="roll-actions"><a class="btn small" href="docs.html">How it works</a><button class="btn small" id="restoreHintBtn">Restore a backup</button><button class="btn small" id="importBtn">Import Markdown</button></div>`;
    $("#importBtn").onclick = () => openImport(null);
    $("#restoreHintBtn").onclick = openSettings;
    return;
  }
  main.innerHTML = `
    <div class="section-label edge">In camera</div>
    ${loaded.length ? loaded.map(card).join("") : `<p class="hint">Nothing loaded. Tap “+ Roll” when you load the next film.</p>`}
    <div class="section-label edge">Archive · ${archived.length} ${archived.length === 1 ? "roll" : "rolls"}</div>
    ${archived.length ? archived.map(card).join("") : `<p class="hint">Finished rolls land here when you archive them.</p>`}
    <div class="roll-actions" style="margin-top:20px"><button class="btn small" id="exportAllBtn">Export everything (Markdown)</button><button class="btn small" id="importBtn">Import Markdown</button></div>`;
  main.querySelectorAll("[data-open]").forEach(b => b.onclick = () => location.hash = "roll-" + b.dataset.open);
  $("#exportAllBtn").onclick = exportAll;
  $("#importBtn").onclick = () => openImport(null);
}

function sortedShots(desc) {
  return [...shots].sort((a, b) => desc ? (b.n - a.n) : (a.n - b.n));
}

function shotHTML(s, iso) {
  const kept = s.metering === "Kept settings";
  const when = [fmtDate(s.date), s.time ? (s.timeApprox ? "~" : "") + s.time : (s.timeApprox ? "time unknown" : "")].filter(Boolean).join(" ");
  return `<button class="shot" data-shot="${esc(s.id)}">
    <span class="n">${esc(s.n)}<small>▶${esc(s.n)}A</small></span>
    <span class="body">
      <span class="expo"><b>${esc(apLabel(s.aperture))}</b><b>${esc(shutterLabel(s.shutter))}</b><span>${esc(s.lens || "")}</span>
        <span class="meter-chip ${kept ? "kept" : ""}">${esc(s.metering || "")}${s.meteringNote ? " · " + esc(s.meteringNote) : ""}</span></span>
      ${evLineHTML(s, iso)}
      ${when || s.loc ? `<span class="when">${esc(when)}${when && s.loc ? " · " : ""}${s.loc ? "<span data-map>Map</span>" : ""}</span>` : ""}
      ${s.subject ? `<span class="subject">${esc(s.subject)}</span>` : ""}
      ${s.intention ? `<span class="intent">${esc(s.intention)}</span>` : ""}
      ${s.notes ? `<span class="notes">${esc(s.notes)}</span>` : ""}
      ${s.photo ? `<img class="thumb" data-blob="${esc(s.photo)}" alt="Frame ${esc(s.n)}" hidden>` : ""}
      ${s.lessons ? `<span class="lessons">${esc(s.lessons)}</span>` : ""}
    </span></button>`;
}

function renderRoll(main) {
  const r = rolls.find(x => x.id === currentId);
  if (!r) { main.innerHTML = `<p class="status">This roll isn’t in your log. <a href="#">Back to all rolls</a></p>`; $("#topTitle").textContent = "Film log"; return; }
  $("#topTitle").textContent = r.stock || "Roll";
  const isLoaded = r.status !== "archived";
  const list = sortedShots(isLoaded);
  const nextN = shots.reduce((m, s) => Math.max(m, s.n || 0), 0) + 1;
  const exp = r.exposures || 36;
  const iso = rollIso(r);
  const guessed = shots.filter(s => guessEV(s) !== null && meterEV(s) !== null);
  const metered = shots.filter(s => meterEV(s) !== null && settingsEV(s, iso) !== null);
  const avg = (l, f) => l.reduce((a, s) => a + Math.abs(f(s)), 0) / l.length;
  const evSummary = [
    guessed.length ? `Light guesses: <b>${guessed.length}</b>, off by <b>${r1(avg(guessed, s => guessEV(s) - meterEV(s)))}</b> ${stopsWord(avg(guessed, s => guessEV(s) - meterEV(s)))} on average` : "",
    metered.length ? `Settings vs meter: <b>${metered.length}</b> ${metered.length === 1 ? "frame" : "frames"}, <b>${r1(avg(metered, s => meterEV(s) - settingsEV(s, iso)))}</b> ${stopsWord(avg(metered, s => meterEV(s) - settingsEV(s, iso)))} apart on average` : ""
  ].filter(Boolean);
  const meter = Array.from({ length: exp }, (_, i) => `<span class="${i < shots.length ? "on" : ""}"></span>`).join("");
  main.innerHTML = `
    <section class="roll-head">
      <div class="title-row"><h2>${esc(r.stock || "Untitled roll")}</h2>${isLoaded ? '<span class="pill loaded">In camera</span>' : '<span class="pill">Archived</span>'}</div>
      ${rollRange(r) ? `<div class="range">${esc(rollRange(r))}</div>` : ""}
      <div class="edge">${esc(rollMeta(r))} · ${shots.length}/${exp} frames</div>
      <div class="frame-meter" aria-hidden="true">${meter}</div>
      ${evSummary.length ? `<div class="ev-summary">${evSummary.join("<br>")}</div>` : ""}
      ${r.notes ? `<div class="roll-notes">${esc(r.notes)}</div>` : ""}
      ${devBlock(r)}
      <div class="roll-actions">
        <button class="btn small" id="editRollBtn">Edit roll</button>
        <button class="btn small" id="exportRollBtn">Export</button>
        <button class="btn small" id="importRollBtn">Import</button>
        ${isLoaded ? `<button class="btn small" id="archiveBtn">Archive roll</button>` : `<button class="btn small" id="unarchiveBtn">Move back to camera</button>`}
      </div>
    </section>
    ${isLoaded ? `<div class="log-row" style="${shots.length ? "" : "grid-template-columns:1fr"}"><button class="btn primary log-btn" id="logBtn">Log frame <span class="num">${nextN}</span></button>${shots.length ? `<button class="btn seq-btn" id="seqBtn" title="Copy the last frame, settings kept">Sequence shot</button>` : ""}</div>` : `<div class="section-label edge">Frames</div>`}
    <div id="shotList">${list.length ? list.map(s => shotHTML(s, iso)).join("") : `<p class="hint">No frames logged on this roll yet.</p>`}</div>
    ${!isLoaded ? `<button class="btn small" id="addLateBtn" style="margin-top:14px">Add a frame</button>` : ""}`;
  $("#editRollBtn").onclick = () => openRollSheet(r);
  $("#exportRollBtn").onclick = () => openExport(r.stock || "roll", rollMarkdown(r, sortedShots(false)));
  $("#importRollBtn").onclick = () => openImport(r);
  if ($("#logBtn")) $("#logBtn").onclick = () => openShotSheet(r, null);
  if ($("#seqBtn")) $("#seqBtn").onclick = () => openShotSheet(r, null, true);
  if ($("#addLateBtn")) $("#addLateBtn").onclick = () => openShotSheet(r, null);
  if ($("#archiveBtn")) $("#archiveBtn").onclick = () => armConfirm($("#archiveBtn"), "Tap again to archive", async () => {
    try { await db.doc("rolls/" + r.id).update({ status: "archived", archivedOn: nowParts().date }); toast("Roll archived"); } catch (e) { toast("Couldn’t archive (" + (e.code || e) + ")"); }
  });
  if ($("#unarchiveBtn")) $("#unarchiveBtn").onclick = async () => {
    try { await db.doc("rolls/" + r.id).update({ status: "loaded" }); } catch (e) { toast("Couldn’t update (" + (e.code || e) + ")"); }
  };
  main.querySelectorAll("[data-map]").forEach(m => { m.className = "loc-link"; m.setAttribute("role", "link"); m.onclick = ev => { ev.stopPropagation(); const sh = shots.find(x => x.id === m.closest("[data-shot]").dataset.shot); const u = sh && mapURL(sh.loc); if (u) window.open(u, "_blank", "noopener"); }; });
  main.querySelectorAll("[data-shot]").forEach(b => b.onclick = () => openShotSheet(r, shots.find(s => s.id === b.dataset.shot)));
}

function armConfirm(btn, label, fn) {
  if (btn.dataset.armed) { fn(); return; }
  const orig = btn.textContent; btn.dataset.armed = "1"; btn.textContent = label; btn.classList.add("danger");
  setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = orig; btn.classList.remove("danger"); } }, 3500);
}

/* ---------- sheets ---------- */
function openSheet(html) {
  sheetOpen = true;
  $("#sheetHost").innerHTML = `<div class="scrim" id="scrim"></div><div class="sheet" role="dialog" aria-modal="true"><div class="sheet-inner">${html}</div></div>`;
  $("#scrim").onclick = closeSheet;
  document.querySelectorAll("[data-close]").forEach(b => b.onclick = closeSheet);
  hydrateBlobs($("#sheetHost"));
}
function closeSheet() { sheetOpen = false; $("#sheetHost").innerHTML = ""; }
document.addEventListener("keydown", e => { if (e.key === "Escape" && sheetOpen) closeSheet(); });

function chipRow(id, values, current) {
  return `<div class="chips" data-for="${id}">${values.map(v => `<button type="button" data-v="${esc(v)}" class="${v === current ? "on" : ""}">${esc(v)}</button>`).join("")}</div>`;
}
function wireChips(root) {
  root.querySelectorAll(".chips").forEach(row => {
    const input = $("#" + row.dataset.for);
    const sync = () => row.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.v === input.value.trim()));
    row.querySelectorAll("button").forEach(b => b.onclick = () => { input.value = b.dataset.v; sync(); });
    input.addEventListener("input", sync);
  });
}

const GEAR = {
  lens: { doc: "settings/lenses", noun: "lens", ph: "e.g. Helios 44-2 58mm f/2", get: () => lenses, set: l => { lenses = l; } },
  camera: { doc: "settings/cameras", noun: "camera", ph: "e.g. Pentax Spotmatic", get: () => cameras, set: l => { cameras = l; } },
};
function gearOptions(kind, current) {
  const g = GEAR[kind]; const list = g.get().slice(); if (current && !list.includes(current)) list.push(current);
  return list.map(l => `<option ${l === current ? "selected" : ""}>${esc(l)}</option>`).join("") + `<option value="__add">Add a ${g.noun}…</option>`;
}
function gearField(kind, id, current, label) {
  return `<div class="field"><label for="${id}">${label}</label><select id="${id}">${gearOptions(kind, current)}</select>
    <div class="add-lens" id="${id}-add" hidden><input id="${id}-new" type="text" placeholder="${esc(GEAR[kind].ph)}"><button type="button" class="btn" id="${id}-addbtn">Add</button></div></div>`;
}
function wireGear(kind, id) {
  const g = GEAR[kind]; const sel = $("#" + id); let last = sel.value;
  sel.onchange = () => { if (sel.value === "__add") { $("#" + id + "-add").hidden = false; $("#" + id + "-new").focus(); sel.value = last; } else last = sel.value; };
  $("#" + id + "-addbtn").onclick = async () => {
    const name = $("#" + id + "-new").value.trim(); if (!name) return;
    if (!g.get().includes(name)) {
      g.set([...g.get(), name]);
      try { await db.doc(g.doc).set({ list: g.get() }); } catch (e) { toast("Couldn’t save " + g.noun + " (" + (e.code || e) + ")"); }
    }
    sel.innerHTML = gearOptions(kind, name); sel.value = name; last = name;
    $("#" + id + "-add").hidden = true; $("#" + id + "-new").value = ""; toast(g.noun[0].toUpperCase() + g.noun.slice(1) + " added");
  };
}
const lensField = (id, cur, label) => gearField("lens", id, cur, label);
const wireLens = id => wireGear("lens", id);
const gearValue = (id, fallback) => $("#" + id).value === "__add" ? fallback : $("#" + id).value;

function openShotSheet(roll, shot, seq) {
  const isNew = !shot;
  const prev = sortedShots(true)[0];
  const np = nowParts();
  seq = !!(seq && isNew && prev);
  const s = shot || (seq ? {
    ...prev, id: newId("s"), n: shots.reduce((m, x) => Math.max(m, x.n || 0), 0) + 1,
    metering: "Kept settings", meteringNote: "", guessEV: "", meterValue: "",
    date: np.date, time: np.time, timeApprox: false, photo: "", lessons: ""
  } : {
    id: newId("s"), n: shots.reduce((m, x) => Math.max(m, x.n || 0), 0) + 1,
    aperture: "", shutter: "", lens: roll.lens || prev?.lens || lenses[0], metering: "Luxmeter app",
    meteringNote: "", guessEV: "", meterValue: "", meterUnit: prev?.meterUnit || "lux",
    date: np.date, time: np.time, timeApprox: false, subject: "", intention: "", notes: ""
  });
  const iso = rollIso(roll);
  openSheet(`
    <form id="shotForm" autocomplete="off">
    <div class="sheet-head"><h3>${seq ? `Sequence shot <span class="hint">copied from frame ${esc(prev.n)}</span>` : isNew ? "Log frame" : "Edit frame"}</h3><button type="button" class="btn ghost small" data-close>Cancel</button><button class="btn primary small" type="submit">Save</button></div>
    <div style="display:grid;gap:14px;padding-top:12px">
      ${isNew ? "" : `<div class="expo-summary" id="expoSummary">
        <div class="top"><span class="edge">Frame ${esc(s.n)} · settings</span><button type="button" class="btn small" id="editExpoBtn">Edit settings</button></div>
        <div class="big"><span>${esc(apLabel(s.aperture))}</span><span>${esc(s.shutter)}</span></div>
        <div class="sub">${esc(s.lens)}</div>
        <div class="sub">${esc(s.metering)}${s.meteringNote ? " · " + esc(s.meteringNote) : ""}${meterLabel(s) ? " · " + esc(meterLabel(s)) : ""}</div>
        ${evLineHTML(s, iso)}
        <div class="sub">${esc(fmtDate(s.date))} ${s.time ? (s.timeApprox ? "~" : "") + esc(s.time) : ""}</div>
        ${s.loc ? mapLinkHTML(s.loc) : ""}
      </div>`}
      <div id="expoFields" style="display:grid;gap:14px" ${isNew ? "" : "hidden"}>
      <div>
        <div class="field"><label for="f-n">Frame #</label><input id="f-n" class="mono" type="number" inputmode="numeric" min="0" max="99" value="${esc(s.n)}"></div>
      </div>
      ${lensField("f-lens", s.lens, "Lens")}
      <div class="field"><label for="f-meter">How metered</label>
        <select id="f-meter">${METERING.map(m => `<option ${m === s.metering ? "selected" : ""}>${esc(m)}</option>`).join("")}</select>
        <input id="f-meternote" type="text" placeholder="Metering note (optional, e.g. +1 stop, shade under tree)" value="${esc(s.meteringNote)}">
        ${isNew && prev ? `<span class="hint">“Kept settings” copies f/${esc(prev.aperture)} · ${esc(prev.shutter)} from frame ${esc(prev.n)}.</span>` : ""}
      </div>
      <div class="field"><span class="lbl">Light (optional)</span>
        <div class="row2">
          <div class="field"><label for="f-guess">My guess, EV</label><input id="f-guess" class="mono" type="text" inputmode="decimal" placeholder="before metering" value="${esc(s.guessEV ?? "")}"></div>
          <div class="field"><label for="f-meterval">Meter said</label><div class="meter-in"><input id="f-meterval" class="mono" type="text" inputmode="decimal" placeholder="${s.meterUnit === "EV" ? "EV" : "lux"}" value="${esc(s.meterValue ?? "")}"><select id="f-meterunit" aria-label="Unit"><option ${s.meterUnit !== "EV" ? "selected" : ""}>lux</option><option ${s.meterUnit === "EV" ? "selected" : ""}>EV</option></select></div></div>
        </div>
        <span class="hint">Just for fun: guess the light first, then check the app. EV is at ISO 100, like the app; this roll counts as ISO ${esc(iso)}.</span>
      </div>
      <div class="field"><label for="f-ap">Aperture f/</label><input id="f-ap" class="mono" type="text" inputmode="decimal" placeholder="2.8" value="${esc(s.aperture)}">${chipRow("f-ap", APERTURES, s.aperture)}</div>
      <div class="field"><label for="f-sh">Shutter</label><input id="f-sh" class="mono" type="text" placeholder="1/125" value="${esc(s.shutter)}">${chipRow("f-sh", SHUTTERS, s.shutter)}</div>
      <div class="ev-live" id="evLive" aria-live="polite"></div>
      <div class="field"><span class="lbl">Date and time</span>
        <div class="row3">
          <input id="f-date" type="date" aria-label="Date" value="${esc(s.date)}">
          <input id="f-time" type="time" aria-label="Time" value="${esc(s.time)}">
          <button type="button" class="btn" id="nowBtn">Now</button>
        </div>
        <label class="check"><input id="f-approx" type="checkbox" ${s.timeApprox ? "checked" : ""}> Time is approximate</label>
      </div>
      <div class="field"><span class="lbl">Location (optional)</span>
        <label class="check"><input id="f-geo" type="checkbox" ${(isNew ? geoPref() : !!s.loc) ? "checked" : ""}> Tag where I am (phone GPS)</label>
        <input id="f-loc" type="hidden" value="${esc(isNew && !geoPref() ? "" : s.loc || "")}">
        <span class="hint" id="geoStatus"></span>
        <span id="geoMap">${isNew ? "" : mapLinkHTML(s.loc, "Check on map")}</span>
      </div>
      </div>
      <div class="field"><label for="f-subject">What I shot</label><input id="f-subject" type="text" placeholder="Subject and place" value="${esc(s.subject)}"></div>
      <div class="field"><label for="f-intent">Intention (optional)</label><textarea id="f-intent" rows="2" placeholder="What I wanted to capture">${esc(s.intention)}</textarea></div>
      <div class="field"><label for="f-notes">Notes (optional)</label><textarea id="f-notes" rows="3" placeholder="Doubts, what to try next time">${esc(s.notes)}</textarea></div>
      <div class="dev-section">
        <div class="edge">After development</div>
        <div class="field photo-box"><span class="lbl">Scan or photo</span>
          <img id="f-photo-img" alt="Scan of this frame" ${s.photo ? `data-blob="${esc(s.photo)}"` : ""} hidden>
          <div class="photo-actions">
            <label class="btn small" for="f-photo-file" id="f-photo-label">${s.photo ? "Replace scan" : "Add scan"}</label>
            <input id="f-photo-file" type="file" accept="image/*" hidden>
            <button type="button" class="btn small ghost" id="f-photo-remove" ${s.photo ? "" : "hidden"}>Remove</button>
            <span class="hint" id="f-photo-status"></span></div>
        </div>
        <div class="field"><label for="f-lessons">Lessons learned</label><textarea id="f-lessons" rows="3" placeholder="How it came out, what to do differently">${esc(s.lessons || "")}</textarea></div>
      </div>
      <div class="sheet-foot">
        <button class="btn primary grow" type="submit">${isNew ? "Save frame" : "Save changes"}</button>
        ${isNew ? "" : `<button type="button" class="btn danger" id="delShotBtn">Delete</button>`}
      </div>
    </div></form>`);
  const root = $("#sheetHost");
  wireChips(root);
  wireLens("f-lens");
  const readLight = () => ({ aperture: $("#f-ap").value, shutter: $("#f-sh").value, guessEV: $("#f-guess").value.trim(), meterValue: $("#f-meterval").value.trim(), meterUnit: $("#f-meterunit").value });
  const updateEV = () => { if (!$("#evLive")) return; const p = evParts(readLight(), iso); $("#evLive").innerHTML = p.map(([c, t]) => `<span class="${c}">${esc(t)}</span>`).join(" · "); };
  ["input", "change", "click"].forEach(ev => $("#shotForm").addEventListener(ev, () => setTimeout(updateEV)));
  $("#f-meterunit").addEventListener("change", () => { $("#f-meterval").placeholder = $("#f-meterunit").value; });
  updateEV();
  if ($("#editExpoBtn")) $("#editExpoBtn").onclick = () => { $("#expoSummary").hidden = true; $("#expoFields").hidden = false; };
  let locAcc = s.locAcc ?? null, locFromGps = s.loc || "", locPending = null;
  const showLoc = () => { $("#geoMap").innerHTML = mapLinkHTML($("#f-loc").value.trim(), "Check on map"); };
  function tagHere() {
    const st = $("#geoStatus"); st.textContent = "Finding you…";
    const mine = locPending = getPosition().then(c => {
      if (!$("#f-loc") || locPending !== mine || !$("#f-geo").checked) return;
      const v = fmtLoc(c.latitude, c.longitude); $("#f-loc").value = v; locAcc = Math.round(c.accuracy); locFromGps = v;
      st.textContent = `Tagged, accurate to about ${locAcc} m`; showLoc();
    }, e => { if ($("#geoStatus") && locPending === mine) st.textContent = e.message; }).finally(() => { if (locPending === mine) locPending = null; });
    return mine;
  }
  $("#f-geo").onchange = () => {
    const on = $("#f-geo").checked;
    if (isNew) setGeoPref(on);
    if (on) tagHere(); else { locPending = null; $("#f-loc").value = ""; $("#geoStatus").textContent = ""; showLoc(); }
  };
  if (isNew && $("#f-geo").checked) tagHere();
  $("#nowBtn").onclick = () => { const p = nowParts(); $("#f-date").value = p.date; $("#f-time").value = p.time; $("#f-approx").checked = false; toast("Stamped " + p.time); };
  $("#f-meter").onchange = () => {
    if ($("#f-meter").value === "Kept settings" && isNew && prev) {
      $("#f-ap").value = prev.aperture || ""; $("#f-sh").value = prev.shutter || "";
      $("#f-ap").dispatchEvent(new Event("input")); $("#f-sh").dispatchEvent(new Event("input"));
    }
  };
  let photoId = s.photo || "";
  if ($("#f-photo-file")) {
    $("#f-photo-file").onchange = async ev => {
      const file = ev.target.files && ev.target.files[0]; if (!file) return;
      const st = $("#f-photo-status"); st.textContent = "Uploading…";
      const btns = root.querySelectorAll("[type=submit]"); btns.forEach(b => b.disabled = true);
      try {
        const blob = await shrinkImage(file);
        const res = await assets.upload(blob, { type: blob.type || "image/jpeg" });
        photoId = res.id;
        const img = $("#f-photo-img"); img.removeAttribute("data-blob"); img.src = res.url; img.hidden = false;
        $("#f-photo-remove").hidden = false; $("#f-photo-label").textContent = "Replace scan";
        st.textContent = "Uploaded. Save to keep it.";
      } catch (e) { st.textContent = "Upload failed (" + (e.code || e.message || e) + ")"; }
      btns.forEach(b => b.disabled = false);
      ev.target.value = "";
    };
    $("#f-photo-remove").onclick = () => { photoId = ""; $("#f-photo-img").hidden = true; $("#f-photo-remove").hidden = true; $("#f-photo-label").textContent = "Add scan"; $("#f-photo-status").textContent = "Save to remove it."; };
  }
  if ($("#delShotBtn")) $("#delShotBtn").onclick = () => armConfirm($("#delShotBtn"), "Tap again to delete", async () => {
    try { await shotsCol(roll.id).doc(s.id).delete(); if (s.photo) assets.delete(s.photo).catch(() => {}); closeSheet(); toast("Frame deleted"); } catch (e) { toast("Couldn’t delete (" + (e.code || e) + ")"); }
  });
  $("#shotForm").onsubmit = async e => {
    e.preventDefault();
    if (locPending) { root.querySelectorAll("[type=submit]").forEach(b => b.disabled = true); await locPending; }
    const data = {
      id: s.id, n: parseInt($("#f-n").value, 10) || 0, aperture: $("#f-ap").value.trim(), shutter: $("#f-sh").value.trim(),
      lens: $("#f-lens").value === "__add" ? s.lens : $("#f-lens").value, metering: $("#f-meter").value, meteringNote: $("#f-meternote").value.trim(),
      date: $("#f-date").value, time: $("#f-time").value, timeApprox: $("#f-approx").checked,
      subject: $("#f-subject").value.trim(), intention: $("#f-intent").value.trim(), notes: $("#f-notes").value.trim(),
      guessEV: $("#f-guess").value.trim(), meterValue: $("#f-meterval").value.trim(), meterUnit: $("#f-meterunit").value,
      loc: (p => p ? fmtLoc(p.lat, p.lon) : "")(parseLoc($("#f-loc").value)),
      photo: photoId, lessons: $("#f-lessons").value.trim(),
      updatedAt: new Date().toISOString()
    };
    data.locAcc = data.loc && data.loc === locFromGps && locAcc !== null ? locAcc : null;
    const btns = root.querySelectorAll("[type=submit]"); btns.forEach(b => b.disabled = true);
    try {
      await saveShot(roll.id, data); closeSheet(); toast(`Frame ${data.n} saved`);
      if (assets && s.photo && s.photo !== photoId) assets.delete(s.photo).catch(() => {});
    }
    catch (err) { btns.forEach(b => b.disabled = false); toast("Couldn’t save (" + (err.code || err) + "). Try again."); }
  };
}

function openRollSheet(roll) {
  const isNew = !roll;
  const r = roll || { id: newId("r"), stock: "", iso: "", exposures: 36, camera: cameras[0], lens: lenses[0], loadedOn: nowParts().date, notes: "", status: "loaded" };
  openSheet(`
    <form id="rollForm" autocomplete="off">
    <div class="sheet-head"><h3>${isNew ? "Load a new roll" : "Edit roll"}</h3><button type="button" class="btn ghost small" data-close>Cancel</button><button class="btn primary small" type="submit">Save</button></div>
    <div style="display:grid;gap:14px;padding-top:12px">
      <div class="field"><label for="r-stock">Film</label><input id="r-stock" type="text" list="stocks" placeholder="Kodak Gold 200" value="${esc(r.stock)}" required>
        <datalist id="stocks">${STOCKS.map(s => `<option value="${esc(s)}">`).join("")}</datalist></div>
      <div class="row2">
        <div class="field"><label for="r-exp">Exposures</label><input id="r-exp" class="mono" type="number" inputmode="numeric" value="${esc(r.exposures)}"></div>
        <div class="field"><label for="r-loaded">Loaded on</label><input id="r-loaded" type="date" value="${esc(r.loadedOn)}"></div>
      </div>
      <div class="field"><label for="r-iso">Shot at ISO (optional)</label><input id="r-iso" class="mono" type="text" inputmode="numeric" placeholder="From the film name: ${esc(rollIso(r))}" value="${esc(r.iso || "")}"><span class="hint">Only needed when you push, pull or rate the film differently. Used for the EV numbers.</span></div>
      <div class="row2">
        ${gearField("camera", "r-camera", r.camera || cameras[0], "Camera")}
        ${lensField("r-lens", r.lens || lenses[0], "Default lens")}
      </div>
      <div class="field"><label for="r-notes">Roll notes</label><textarea id="r-notes" rows="4" placeholder="Loading issues, anything about the roll as a whole">${esc(r.notes)}</textarea></div>
      <div class="dev-section">
        <div class="edge">Development</div>
        <div class="field"><label for="r-devLab">Lab</label><input id="r-devLab" type="text" placeholder="Lab name and city" value="${esc(r.devLab || "")}"></div>
        <div class="field"><label for="r-devOptions">Development options</label><input id="r-devOptions" type="text" placeholder="e.g. C-41, push +1, scans 3000×2000 TIFF" value="${esc(r.devOptions || "")}"></div>
        <div class="row2">
          <div class="field"><label for="r-devSent">Sent to lab</label><input id="r-devSent" type="date" value="${esc(r.devSent || "")}"></div>
          <div class="field"><label for="r-devBack">Back from lab</label><input id="r-devBack" type="date" value="${esc(r.devBack || "")}"></div>
        </div>
        <div class="field"><label for="r-devNotes">Development notes</label><textarea id="r-devNotes" rows="3" placeholder="Price, turnaround, how the scans came out">${esc(r.devNotes || "")}</textarea></div>
      </div>
      <div class="sheet-foot">
        <button class="btn primary grow" type="submit">${isNew ? "Load roll" : "Save roll"}</button>
        ${isNew ? "" : `<button type="button" class="btn danger" id="delRollBtn">Delete roll</button>`}
      </div>
    </div></form>`);
  wireLens("r-lens");
  wireGear("camera", "r-camera");
  if ($("#delRollBtn")) $("#delRollBtn").onclick = () => armConfirm($("#delRollBtn"), "Tap again: deletes roll and all frames", async () => {
    try {
      const snap = await shotsCol(r.id).get();
      for (const d of snap.docs) { const ph = d.data().photo; await shotsCol(r.id).doc(d.id).delete(); if (ph) assets.delete(ph).catch(() => {}); }
      await db.doc("rolls/" + r.id).delete();
      closeSheet(); location.hash = ""; toast("Roll deleted");
    } catch (e) { toast("Couldn’t delete (" + (e.code || e) + ")"); }
  });
  $("#rollForm").onsubmit = async e => {
    e.preventDefault();
    const data = { ...r, stock: $("#r-stock").value.trim(), exposures: parseInt($("#r-exp").value, 10) || 36, loadedOn: $("#r-loaded").value,
      iso: $("#r-iso").value.trim(), camera: gearValue("r-camera", r.camera || cameras[0]), lens: $("#r-lens").value === "__add" ? (r.lens || lenses[0]) : $("#r-lens").value, notes: $("#r-notes").value.trim(),
      ...Object.fromEntries(DEV.map(([k]) => [k, $("#r-" + k).value.trim()])) };
    try { await saveRoll(data); closeSheet(); toast(isNew ? "Roll loaded" : "Roll saved"); if (isNew) location.hash = "roll-" + data.id; }
    catch (err) { toast("Couldn’t save (" + (err.code || err) + ")"); }
  };
}

async function shrinkImage(file, max = 2400) {
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (k === 1 && file.size < 8e6 && /^image\/(jpeg|png|webp)$/.test(file.type)) return file;
    const c = document.createElement("canvas"); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise(res => c.toBlob(b => res(b || file), "image/jpeg", 0.88));
  } catch (e) { return file; }
}

/* ---------- export ---------- */
const cell = v => String(v ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ");
function rollMarkdown(r, list) {
  const lines = [`# ${r.stock || "Roll"}`, "",
    `- Camera: ${r.camera || ""}`, `- Loaded: ${r.loadedOn || ""}`];
  if (r.status === "archived") lines.push(`- Archived: ${r.archivedOn || ""}`);
  if (r.iso) lines.push(`- ISO: ${r.iso}`);
  lines.push(`- Frames: ${list.length}/${r.exposures || 36}`);
  if (r.firstShot) lines.push(`- Shot: ${r.firstShot}${r.lastShot && r.lastShot !== r.firstShot ? " to " + r.lastShot : ""}`);
  for (const [k, l] of DEV) if (r[k]) lines.push(`- ${l}: ${String(r[k]).replace(/\n+/g, " ")}`);
  lines.push("");
  if (r.notes) lines.push(r.notes, "");
  lines.push("| # | Aperture | Shutter | Lens | How metered | My guess (EV) | Meter said | Date and time | Location | Subject | Intention | Notes | Lessons learned |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const s of list) {
    const when = `${s.date || ""} ${s.time ? (s.timeApprox ? "~" : "") + s.time : (s.timeApprox ? "?" : "")}`.trim();
    const met = s.metering + (s.meteringNote ? ` (${s.meteringNote})` : "");
    lines.push(`| ${s.n} | ${cell(s.aperture)} | ${cell(s.shutter)} | ${cell(s.lens)} | ${cell(met)} | ${cell(s.guessEV)} | ${cell(meterLabel(s))} | ${cell(when)} | ${cell(s.loc)} | ${cell(s.subject)} | ${cell(s.intention)} | ${cell(s.notes)} | ${cell(s.lessons)} |`);
  }
  return lines.join("\n") + "\n";
}
async function exportAll() {
  try {
    const parts = [];
    const sorted = [...rolls].sort((a, b) => (a.loadedOn || "").localeCompare(b.loadedOn || ""));
    for (const r of sorted) {
      const snap = await shotsCol(r.id).get();
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.n - b.n);
      parts.push(rollMarkdown(r, list));
    }
    openExport("film-log", parts.join("\n---\n\n"));
  } catch (e) { toast("Couldn’t export (" + (e.code || e) + ")"); }
}
/* ---------- import ---------- */
const splitRow = line => line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, "|"));
function parseRollMd(text) {
  const lines = text.split(/\r?\n/);
  const roll = { stock: "", camera: "", loadedOn: "", archivedOn: "", notes: "", dev: {} };
  const noteLines = []; const frames = []; let header = null;
  for (const raw of lines) {
    const line = raw.trim();
    let m;
    if (!roll.stock && (m = line.match(/^#\s+(.+)/))) { roll.stock = m[1].trim(); continue; }
    if ((m = line.match(/^-\s*([A-Za-z ]+):\s*(.*)$/)) && DEV.some(([, l]) => l.toLowerCase() === m[1].trim().toLowerCase())) {
      roll.dev[DEV.find(([, l]) => l.toLowerCase() === m[1].trim().toLowerCase())[0]] = m[2].trim(); continue;
    }
    if ((m = line.match(/^-\s*(Camera|Loaded|Archived|Frames|Shot|ISO):\s*(.*)$/i))) {
      const k = m[1].toLowerCase(), v = m[2].trim();
      if (k === "camera") roll.camera = v; else if (k === "loaded") roll.loadedOn = v; else if (k === "archived") roll.archivedOn = v;
      continue;
    }
    if (line.startsWith("|")) {
      const cells = splitRow(line);
      if (!header) { header = cells.map(c => c.toLowerCase()); continue; }
      if (cells.every(c => /^:?-{2,}:?$/.test(c) || c === "")) continue;
      const get = name => { const i = header.findIndex(h => h.startsWith(name)); return i >= 0 ? (cells[i] || "") : ""; };
      const n = parseInt(get("#"), 10); if (!n) continue;
      let met = get("how metered"), metNote = "";
      const mm = met.match(/^(.*?)\s*\((.*)\)\s*$/); if (mm) { met = mm[1]; metNote = mm[2]; }
      const when = get("date"); const wm = when.match(/(\d{4}-\d{2}-\d{2})?\s*(~|\?)?\s*(\d{1,2}:\d{2})?/) || [];
      frames.push({ n, aperture: get("aperture"), shutter: get("shutter"), lens: get("lens"),
        metering: METERING.includes(met) ? met : (met ? "Other" : "Luxmeter app"), meteringNote: METERING.includes(met) ? metNote : [met, metNote].filter(Boolean).join(" · "),
        date: wm[1] || "", time: wm[3] ? wm[3].padStart(5, "0") : "", timeApprox: !!wm[2],
        subject: get("subject"), intention: get("intention"), notes: get("notes"), lessons: get("lessons") });
      const f = frames[frames.length - 1];
      if (header.some(h => h.startsWith("location"))) { const pl = parseLoc(get("location")); f.loc = pl ? fmtLoc(pl.lat, pl.lon) : ""; }
      if (header.some(h => h.startsWith("my guess"))) f.guessEV = get("my guess");
      if (header.some(h => h.startsWith("meter said"))) { const ms = get("meter said"); const um = ms.match(/^(.*?)\s*(lux|ev)?\s*$/i); f.meterValue = um ? um[1].trim() : ms; f.meterUnit = um && um[2] && um[2].toLowerCase() === "ev" ? "EV" : "lux"; }
      continue;
    }
    if (header) continue;
    if (roll.stock && line) noteLines.push(raw);
  }
  roll.notes = noteLines.join("\n").trim();
  return { roll, frames };
}
const FIELDS = ["aperture", "shutter", "lens", "metering", "meteringNote", "guessEV", "meterValue", "meterUnit", "date", "time", "timeApprox", "subject", "intention", "notes", "lessons", "loc"];
const FIELD_DEFAULT = { timeApprox: false, meterUnit: "lux" };
async function planImport(text, target) {
  const parts = text.split(/\n-{3,}\s*\n/).map(parseRollMd).filter(p => p.frames.length || p.roll.stock);
  if (target && parts.length > 1) throw new Error("This text has several rolls. Import it from the roll list instead.");
  const plan = [];
  for (const p of parts) {
    const r = target || rolls.find(x => x.stock === p.roll.stock && x.loadedOn === p.roll.loadedOn);
    let existing = [];
    if (r) existing = (await shotsCol(r.id).get()).docs.map(d => ({ id: d.id, ...d.data() }));
    const adds = [], changes = [];
    for (const f of p.frames) {
      const old = existing.find(e => e.n === f.n);
      if (!old) adds.push(f);
      else if (FIELDS.some(k => k in f && (old[k] ?? (k in FIELD_DEFAULT ? FIELD_DEFAULT[k] : "")) !== f[k])) changes.push({ id: old.id, f });
    }
    const rollChanged = !!r && ((p.roll.notes && p.roll.notes !== (r.notes || "")) || Object.entries(p.roll.dev).some(([k, v]) => v !== (r[k] || "")));
    plan.push({ part: p, roll: r, adds, changes, rollChanged });
  }
  return plan;
}
async function applyImport(plan) {
  for (const item of plan) {
    let rollId = item.roll && item.roll.id;
    if (!rollId) {
      rollId = newId("r");
      const pr = item.part.roll;
      await db.doc("rolls/" + rollId).set({ stock: pr.stock || "Imported roll", exposures: 36, camera: pr.camera || cameras[0], lens: lenses[0],
        loadedOn: pr.loadedOn || "", notes: pr.notes, status: pr.archivedOn ? "archived" : "loaded", archivedOn: pr.archivedOn || "", shotCount: item.adds.length, ...pr.dev });
    } else {
      const upd = {};
      if (item.part.roll.notes && item.part.roll.notes !== (item.roll.notes || "")) upd.notes = item.part.roll.notes;
      for (const [k, v] of Object.entries(item.part.roll.dev)) if (v !== (item.roll[k] || "")) upd[k] = v;
      if (Object.keys(upd).length) await db.doc("rolls/" + rollId).update(upd);
    }
    const stamp = new Date().toISOString();
    for (const f of item.adds) await shotsCol(rollId).doc(newId("s")).set({ ...f, photo: "", updatedAt: stamp });
    for (const c of item.changes) await shotsCol(rollId).doc(c.id).update({ ...c.f, updatedAt: stamp });
  }
}
function openImport(target) {
  openSheet(`
    <div class="sheet-head"><h3>${target ? "Import into " + esc(target.stock) : "Import Markdown"}</h3><button type="button" class="btn ghost small" data-close>Close</button></div>
    <p class="hint">Paste a roll exported from here as Markdown (and maybe edited in Obsidian). Frames are matched by number: new numbers are added, changed ones are updated, and scans stay attached. Nothing is deleted.</p>
    <div class="photo-actions"><label class="btn small" for="importFile">Choose .md file</label><input id="importFile" type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" hidden></div>
    <textarea id="importText" class="export" placeholder="| # | Aperture | Shutter | Lens | How metered | Date and time | Subject | Intention | Notes | Lessons learned |"></textarea>
    <div id="importPlan" class="hint"></div>
    <div class="sheet-foot"><button class="btn grow" id="checkImportBtn">Check</button><button class="btn primary" id="applyImportBtn" hidden>Apply</button></div>`);
  let plan = null;
  const reset = () => { plan = null; $("#applyImportBtn").hidden = true; $("#importPlan").textContent = ""; };
  $("#importText").addEventListener("input", reset);
  $("#importFile").onchange = async ev => { const f = ev.target.files[0]; if (f) { $("#importText").value = await f.text(); reset(); } };
  $("#checkImportBtn").onclick = async () => {
    const out = $("#importPlan");
    try {
      plan = await planImport($("#importText").value, target);
      if (!plan.length) { out.textContent = "No frames found. Paste the table including its header row."; return; }
      out.innerHTML = plan.map(i => `<div><b>${esc(i.part.roll.stock || (i.roll && i.roll.stock) || "Roll")}</b>${i.roll ? "" : " (new roll)"}: ${i.adds.length} new ${i.adds.length === 1 ? "frame" : "frames"}, ${i.changes.length} changed${i.changes.length ? " (" + i.changes.map(c => c.f.n).join(", ") + ")" : ""}${i.rollChanged ? ", roll notes or development updated" : ""}</div>`).join("");
      $("#applyImportBtn").hidden = !plan.some(i => i.adds.length || i.changes.length || i.rollChanged || !i.roll);
      if ($("#applyImportBtn").hidden) out.innerHTML += "<div>Everything already matches.</div>";
    } catch (e) { out.textContent = e.message || String(e); }
  };
  $("#applyImportBtn").onclick = async () => {
    const b = $("#applyImportBtn"); b.disabled = true;
    try { await applyImport(plan); closeSheet(); toast("Import applied"); }
    catch (e) { b.disabled = false; toast("Import stopped (" + (e.code || e.message || e) + ")"); }
  };
}

function openExport(name, text) {
  const file = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + ".md";
  openSheet(`
    <div class="sheet-head"><h3>Export as Markdown</h3><button type="button" class="btn ghost small" data-close>Close</button></div>
    <p class="hint">Paste into Obsidian or keep it as a backup.</p>
    <textarea id="exportText" class="export" readonly>${esc(text)}</textarea>
    <div class="sheet-foot"><button class="btn primary grow" id="copyBtn">Copy</button>${downloads ? `<button class="btn" id="saveBtn">Save ${esc(file)}</button>` : ""}</div>`);
  $("#copyBtn").onclick = () => {
    navigator.clipboard.writeText(text).then(() => toast("Copied"), () => { const t = $("#exportText"); t.focus(); t.select(); toast("Selected, copy it from the menu"); });
  };
  if ($("#saveBtn")) $("#saveBtn").onclick = async () => {
    try { await downloads.save({ filename: file, data: text }); } catch (e) { if (e && e.code !== "cancelled") toast("Not saved"); }
  };
}

/* ---------- settings: backups, sync, help ---------- */
let backupFileLast = "";
function folderBlock() {
  const f = Sync.status.folder;
  if (f.state === "unsupported") return `<p class="hint">This browser can’t write to a folder (Chrome on Android needs a recent version, Firefox and Safari can’t). Use a backup file or GitHub sync instead.</p>`;
  if (f.state === "none") return `<p class="hint">Pick a folder and every save is copied there as plain files. If the browser data is ever lost, pick the same folder again to get the log back.</p>
    <div class="roll-actions"><button class="btn" id="folderPick">Choose folder</button></div>`;
  return `<p class="hint">Folder “<b>${esc(f.name)}</b>” · <span id="folderStatus">${f.state === "ready" ? "last copy " + esc(fmtStamp(f.last)) : "needs access again"}</span>${f.error ? `<br>Problem: ${esc(f.error)}` : ""}</p>
    <div class="roll-actions">${f.state === "ready" ? `<button class="btn small" id="folderNow">Copy now</button>` : `<button class="btn small primary" id="folderReconnect">Reconnect</button>`}
      <button class="btn small" id="folderRestore">Restore from folder</button><button class="btn small" id="folderPick">Change</button><button class="btn small ghost" id="folderForget">Stop</button></div>`;
}
function githubBlock() {
  const g = Sync.github() || {}, st = Sync.status.github, on = st.state === "on";
  return `${on ? `<p class="hint">Syncing to <b>${esc(g.owner)}/${esc(g.repo)}</b> · <span id="ghStatus">${st.busy ? "syncing…" : "last sync " + esc(fmtStamp(st.last))}</span>${st.error ? `<br>Problem: ${esc(st.error)}` : ""}</p>
      <div class="roll-actions"><button class="btn small primary" id="ghNow">Sync now</button><button class="btn small" id="ghRestore">Restore from GitHub</button><button class="btn small ghost" id="ghOff">Turn off</button></div>`
    : `<p class="hint">Optional. Pushes the log to a private GitHub repository of yours. You need an empty private repository and a fine-grained token with “Contents: Read and write” for only that repository. <a href="docs.html#github">Step by step</a></p>`}
    <details ${on ? "" : "open"}><summary class="lbl">${on ? "Change GitHub settings" : "Set up"}</summary>
    <form id="ghForm" autocomplete="off" style="display:grid;gap:12px;padding-top:10px">
      <div class="row2">
        <div class="field"><label for="gh-owner">Owner</label><input id="gh-owner" type="text" autocapitalize="off" spellcheck="false" placeholder="your user name" value="${esc(g.owner || "")}"></div>
        <div class="field"><label for="gh-repo">Repository</label><input id="gh-repo" type="text" autocapitalize="off" spellcheck="false" placeholder="film-log-data" value="${esc(g.repo || "")}"></div>
      </div>
      <div class="row2">
        <div class="field"><label for="gh-branch">Branch</label><input id="gh-branch" type="text" autocapitalize="off" spellcheck="false" value="${esc(g.branch || "main")}"></div>
        <div class="field"><label for="gh-token">Access token</label><input id="gh-token" type="password" autocomplete="off" placeholder="github_pat_…" value="${esc(g.token || "")}"></div>
      </div>
      <label class="check"><input id="gh-scans" type="checkbox" ${g.scans ? "checked" : ""}> Also sync scans (bigger, slower)</label>
      <label class="check"><input id="gh-auto" type="checkbox" ${g.auto ? "checked" : ""}> Sync by itself after changes when online</label>
      <span class="hint" id="ghMsg">The token is stored only in this browser and is sent only to api.github.com.</span>
      <div class="roll-actions"><button class="btn" id="ghSave" type="submit">Save and test</button></div>
    </form></details>`;
}
const restoreMsg = r => r.rolls || r.scans ? `Restored: ${r.rolls} ${r.rolls === 1 ? "roll" : "rolls"} changed, ${r.added} frames added, ${r.updated} updated, ${r.scans} scans` : "Nothing new to restore";
function openSettings() {
  openSheet(`
    <div class="sheet-head"><h3>Settings and backup</h3><button type="button" class="btn ghost small" data-close>Close</button></div>
    <p class="hint">Your log is stored in this browser on this device and works offline. Nothing is sent anywhere unless you set it up below. Because browser data can be wiped, keep at least one backup.</p>
    <div class="dev-section"><div class="edge">Folder on this device</div>${folderBlock()}</div>
    <div class="dev-section"><div class="edge">GitHub sync</div>${githubBlock()}</div>
    <div class="dev-section"><div class="edge">Backup file</div>
      <p class="hint">One file with everything, saved to your downloads. Last saved: ${esc(fmtStamp(backupFileLast))}.</p>
      <label class="check"><input id="bk-scans" type="checkbox" checked> Include scans</label>
      <div class="roll-actions"><button class="btn small" id="bkSave">Save backup file</button><label class="btn small" for="bkFile">Restore backup file</label><input id="bkFile" type="file" accept=".json,application/json" hidden></div></div>
    <div class="dev-section"><div class="edge">Markdown</div>
      <div class="roll-actions"><button class="btn small" id="setExport">Export everything</button><button class="btn small" id="setImport">Import Markdown</button></div></div>
    <div class="dev-section"><div class="edge">About</div>
      <p class="hint">Film Log ${VERSION} · <a href="docs.html">How to use it</a> · free software under the WTFPL, no warranty · written with an AI assistant, see the docs.</p></div>`);
  const again = msg => { openSettings(); if (msg) toast(msg); };
  const run = async (btn, fn) => { btn.disabled = true; try { const m = await fn(); again(m); } catch (e) { btn.disabled = false; if (e && e.name === "AbortError") return; toast(e.message || String(e)); } };
  const on = (id, fn) => { const b = $("#" + id); if (b) b.onclick = () => run(b, fn); };
  on("folderPick", async () => {
    await Sync.chooseFolder();
    if (!rolls.length && await Sync.folderHasData()) return restoreMsg(await Sync.restoreFolder());
    await Sync.syncNow("folder"); return "Folder set, log copied";
  });
  on("folderNow", async () => { await Sync.syncNow("folder"); return "Copied to folder"; });
  on("folderReconnect", async () => (await Sync.reconnectFolder()) ? "Folder reconnected" : "Access was not given");
  on("folderRestore", async () => restoreMsg(await Sync.restoreFolder()));
  on("folderForget", async () => { await Sync.forgetFolder(); return "Folder backup stopped. The files stay where they are"; });
  on("ghNow", async () => { await Sync.syncNow("github"); return "Synced to GitHub"; });
  on("ghRestore", async () => restoreMsg(await Sync.restoreGithub()));
  on("ghOff", async () => { await Sync.setGithub(null); return "GitHub sync turned off, token removed from this device"; });
  $("#ghForm").onsubmit = async e => {
    e.preventDefault();
    const cfg = { owner: $("#gh-owner").value.trim(), repo: $("#gh-repo").value.trim().replace(/\.git$/, ""), branch: $("#gh-branch").value.trim() || "main",
      token: $("#gh-token").value.trim(), scans: $("#gh-scans").checked, auto: $("#gh-auto").checked };
    const msg = $("#ghMsg"), btn = $("#ghSave");
    if (!cfg.owner || !cfg.repo || !cfg.token) { msg.textContent = "Fill in owner, repository and token."; return; }
    btn.disabled = true; msg.textContent = "Checking…";
    try {
      const info = await Sync.testGithub(cfg);
      if (!info.private && btn.dataset.public !== cfg.owner + "/" + cfg.repo) {
        btn.dataset.public = cfg.owner + "/" + cfg.repo; btn.disabled = false; btn.textContent = "Use public repository anyway";
        msg.textContent = "Careful: this repository is public. Everyone could read your log, including locations. Make it private on GitHub, or tap again to use it anyway."; return;
      }
      if (!info.canPush) throw new Error("This token can read the repository but not write to it. It needs “Contents: Read and write”");
      await Sync.setGithub(cfg); await Sync.syncNow("github"); again("GitHub sync is on, log pushed");
    } catch (err) { btn.disabled = false; msg.textContent = err.message || String(err); }
  };
  on("bkSave", async () => {
    const text = await Sync.backupFile($("#bk-scans").checked);
    Store.saveFile(`film-log-backup-${nowParts().date}.json`, text, "application/json");
    backupFileLast = new Date().toISOString(); await Store.kv.set("backupFileLast", backupFileLast); return "Backup file saved";
  });
  $("#bkFile").onchange = async ev => {
    const f = ev.target.files[0]; if (!f) return;
    try { again(restoreMsg(await Sync.restoreBackup(await f.text()))); } catch (e) { toast(e.message || String(e)); }
  };
  $("#setExport").onclick = exportAll;
  $("#setImport").onclick = () => openImport(null);
}

/* ---------- boot ---------- */
$("#backBtn").onclick = () => { location.hash = ""; };
$("#newRollBtn").onclick = () => openRollSheet(null);
$("#settingsBtn").onclick = openSettings;

(async () => {
  try { await Store.open(); }
  catch (e) { $("#main").innerHTML = `<p class="status">This browser won’t let the log store data (${esc(e && e.message || e)}). Private or incognito windows often block it.</p>`; return; }
  db = Store.db; downloads = Store.downloads; assets = Store.assets;
  backupFileLast = (await Store.kv.get("backupFileLast")) || "";
  geoOn = !!(await Store.kv.get("geoTag"));
  if (!geoOn) { try { if (localStorage.getItem("filmlog.geoTag") === "1") setGeoPref(true); } catch (e) {} }
  await Sync.init(rollMarkdown);
  let statusKey = "";
  Sync.onStatus(st => {
    const key = [st.folder.state, st.folder.error, st.github.state, st.github.error].join("|");
    if ($("#folderStatus") && st.folder.state === "ready") $("#folderStatus").textContent = "last copy " + fmtStamp(st.folder.last);
    if ($("#ghStatus")) $("#ghStatus").textContent = st.github.busy ? "syncing…" : "last sync " + fmtStamp(st.github.last);
    if (key !== statusKey) { statusKey = key; if (rollsLoaded) render(); }
  });
  db.doc("settings/cameras").onSnapshot(d => { const l = d.exists && d.data().list; if (Array.isArray(l) && l.length) cameras = l.slice(); });
  db.doc("settings/lenses").onSnapshot(d => { const l = d.exists && d.data().list; if (Array.isArray(l) && l.length) lenses = l.slice(); });
  db.collection("rolls").onSnapshot(snap => {
    rolls = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    rollsLoaded = true;
    route();
  });
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
})();
