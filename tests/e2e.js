// End-to-end check of the app in headless Chromium. Needs Playwright (npm i playwright). Run: node tests/e2e.js
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((q, r) => { let p = decodeURIComponent(q.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html'; const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); });
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

// fake GitHub repository
const repo = { files: new Map(), commits: 0, calls: [] };
const gsha = buf => crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest('hex');
async function ghRoute(route) {
  const q = route.request(); const u = new URL(q.url()); const m = q.method(); const p = u.pathname.replace('/repos/example/film-log-data', '');
  repo.calls.push(m + ' ' + p);
  const json = (s, o) => route.fulfill({ status: s, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(o) });
  if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
  if (q.headers()['authorization'] !== 'Bearer good') return json(401, { message: 'Bad credentials' });
  if (p === '') return json(200, { full_name: 'example/film-log-data', private: repo.private !== false, default_branch: 'main', permissions: { push: true } });
  if (p.startsWith('/git/trees/')) { if (!repo.files.size) return json(409, { message: 'Git Repository is empty.' }); return json(200, { tree: [...repo.files].map(([path, b]) => ({ path, type: 'blob', sha: gsha(b) })) }); }
  if (p.startsWith('/git/blobs/')) { const sha = p.split('/').pop(); for (const b of repo.files.values()) if (gsha(b) === sha) return json(200, { content: b.toString('base64').replace(/(.{60})/g, '$1\n'), encoding: 'base64' }); return json(404, {}); }
  if (p.startsWith('/contents/')) { const fp = decodeURIComponent(p.slice(10)); const body = JSON.parse(q.postData() || '{}'); const cur = repo.files.get(fp);
    if (m === 'PUT') { if (cur && body.sha !== gsha(cur)) return json(409, { message: 'sha mismatch' }); if (!cur && body.sha) return json(422, { message: 'sha given for new file' }); repo.files.set(fp, Buffer.from(body.content, 'base64')); repo.commits++; return json(cur ? 200 : 201, { content: {} }); }
    if (m === 'DELETE') { if (!cur) return json(404, {}); if (body.sha !== gsha(cur)) return json(409, {}); repo.files.delete(fp); repo.commits++; return json(200, {}); } }
  return json(404, { message: 'Not Found' });
}

(async () => {
  await new Promise(r => server.listen(8765, r)); const URL0 = 'http://localhost:8765/';
  const b = await chromium.launch();
  const ctx = await b.newContext({ locale: 'en-GB', viewport: { width: 390, height: 844 }, geolocation: { latitude: 50.73741, longitude: 7.09823, accuracy: 9 }, permissions: ['geolocation'], acceptDownloads: true });
  await ctx.route('https://api.github.com/**', ghRoute);
  const p = await ctx.newPage(); const errs = [];
  p.on('pageerror', e => errs.push('pageerror ' + e.message)); p.on('console', m => { if (m.type() === 'error') errs.push('console ' + m.text()); });
  const shot = n => p.screenshot({ path: path.join(__dirname, n + '.png') });
  const wipe = async () => { await p.goto('about:blank'); await p.goto(URL0 + 'docs.html'); await p.evaluate(() => new Promise((res, rej) => { const r = indexedDB.deleteDatabase('film-log'); r.onsuccess = res; r.onerror = rej; r.onblocked = res; })); await p.goto(URL0); await p.waitForTimeout(400); };
  const snap = async () => JSON.stringify(await p.evaluate(() => { const S = FilmLogStore; return S.rollIds().map(id => { const b = S.rollBundle(id); return [b.roll.stock, b.roll.camera, b.shots.map(s => [s.n, s.aperture, s.shutter, s.metering, s.subject, s.notes, s.loc, s.photo || ''].join('|'))]; }); }));
  const blobsOk = () => p.evaluate(async () => { const S = FilmLogStore; let n = 0; for (const id of S.rollIds()) for (const s of S.rollBundle(id).shots) if (s.photo) { const bl = await S.getBlob(s.photo); if (bl && bl.size > 100) n++; } return n; });

  await p.goto(URL0); await p.waitForTimeout(500);
  ok((await p.locator('#main').innerText()).includes('No rolls yet'), 'empty state shown');
  await shot('01-empty');
  // new roll
  await p.click('#newRollBtn'); await p.fill('#r-stock', 'Kodak Gold 200'); await p.fill('#r-loaded', '2026-10-12'); await p.click('#rollForm button[type=submit] >> nth=1'); await p.waitForTimeout(300);
  ok(await p.locator('#logBtn').isVisible(), 'roll created and opened');
  ok(!(await p.locator('#seqBtn').count()), 'no sequence button before first frame');
  // frame 1 with GPS + scan
  await p.click('#logBtn'); await p.check('#f-geo'); await p.waitForTimeout(400);
  ok((await p.inputValue('#f-loc')) === '50.73741, 7.09823', 'GPS toggle fills location');
  ok(!(await p.locator('#geoBtn').count()) && await p.locator('#f-loc').getAttribute('type') === 'hidden', 'no manual location box');
  ok((await p.inputValue('#f-meter')) === 'App', 'metering defaults to the neutral App');
  await p.selectOption('#f-meter', '__add'); await p.fill('#f-meter-new', 'My meter app'); await p.click('#f-meter-addbtn'); await p.waitForTimeout(300);
  ok((await p.inputValue('#f-meter')) === 'My meter app', 'own metering method can be added');
  await p.click('.chips[data-for="f-ap"] button[data-v="2.8"]'); await p.click('.chips[data-for="f-sh"] button[data-v="1/125"]');
  ok((await p.inputValue('#f-meterunit')) === 'EV', 'meter reading defaults to EV'); 
  await p.fill('#f-meterval', '9.5'); await p.fill('#f-subject', 'Stream in the forest'); await p.fill('#f-notes', 'Schöne bunte Blätter | soft light');
  const png = await (async () => { const pg = await ctx.newPage(); await pg.setContent('<body style="margin:0;background:radial-gradient(circle at 70% 20%,#f4d58d 0,#e0a84a 18%,transparent 45%),linear-gradient(170deg,#c9a24b 0,#6f8f3a 45%,#2f4a24 75%,#1d2b1a 100%)">'); const buf = await pg.screenshot({ clip: { x: 0, y: 0, width: 300, height: 200 } }); await pg.close(); return buf; })();
  await p.setInputFiles('#f-photo-file', { name: 'scan.png', mimeType: 'image/png', buffer: png }); await p.waitForTimeout(500);
  await p.fill('#f-date', '2026-10-17'); await p.fill('#f-time', '16:20'); await p.fill('#f-guess', '9'); await p.fill('#f-intent', 'Calm, golden afternoon light');
  ok((await p.locator('#f-photo-status').innerText()).startsWith('Uploaded'), 'scan attached');
  await p.fill('#f-lessons', 'Sharp and warm, a touch dark. Open up half a stop under trees.');
  await p.setViewportSize({ width: 390, height: 2050 }); await p.evaluate(() => { document.activeElement.blur(); document.querySelector('.sheet').scrollTop = 0; }); await p.waitForTimeout(2800); await shot('02a-form'); await p.setViewportSize({ width: 390, height: 844 });
  await p.click('#shotForm button[type=submit] >> nth=1'); await p.waitForTimeout(400);
  ok(await p.locator('#shotList img.thumb:not([hidden])').count() === 1, 'scan thumbnail shows in list');
  ok((await p.locator('#shotList').innerText()).includes('EV 8.9') && (await p.locator('#shotList').innerText()).includes('My meter app'), 'EV line and own method show');
  // sequence shot
  await p.click('#seqBtn'); await p.fill('#f-date', '2026-10-17'); await p.fill('#f-time', '16:22'); await p.fill('#f-notes', 'second try'); await p.click('#shotForm button[type=submit] >> nth=1'); await p.waitForTimeout(300);
  await p.waitForTimeout(2800); await shot('02-roll');
  const s1 = await snap(); ok(JSON.parse(s1)[0][2].length === 2 && s1.includes('2|2.8|1/125|Kept settings|Stream in the forest|second try|50.73741, 7.09823|'), 'sequence shot copied frame');
  // the GPS switch is remembered, and switching it off sticks too
  await p.click('#logBtn'); await p.waitForTimeout(400);
  ok(await p.isChecked('#f-geo') && (await p.inputValue('#f-loc')) === '50.73741, 7.09823', 'GPS switch still on for the next frame');
  await p.uncheck('#f-geo'); ok((await p.inputValue('#f-loc')) === '', 'switching off clears the location'); await p.click('[data-close]');
  await p.reload(); await p.waitForTimeout(500);
  await p.click('#seqBtn'); await p.waitForTimeout(300);
  ok(!(await p.isChecked('#f-geo')) && (await p.inputValue('#f-loc')) === '', 'GPS switch stays off after reload, also for sequence shots');
  await p.check('#f-geo'); await p.waitForTimeout(400); await p.click('[data-close]');
  await p.click('[data-shot] .n >> nth=0'); await p.waitForTimeout(200);
  ok(await p.isChecked('#f-geo') && (await p.inputValue('#f-loc')) === '50.73741, 7.09823', 'editing a tagged frame keeps its location'); await p.click('[data-close]');
  await p.click('#logBtn'); await p.waitForTimeout(300); ok((await p.inputValue('#f-meter')) === 'My meter app', 'new frame starts with the method used last'); await p.click('[data-close]');
  // persistence across reload
  await p.reload(); await p.waitForTimeout(500);
  ok(await snap() === s1 && await blobsOk() === 1, 'data and scan survive reload');
  ok((await p.locator('#main').innerText()).includes('only lives in this browser'), 'no-backup banner shown');

  // folder backup (uses an origin-private folder as stand-in for a picked one)
  await p.evaluate(async () => { const set = FilmLogStore.kv.set; FilmLogStore.kv.set = (k, v) => k === 'folder' ? Promise.resolve() : set(k, v); await FilmLogSync.setFolder(await navigator.storage.getDirectory()); await FilmLogSync.syncNow('folder'); });
  const list = () => p.evaluate(async () => { const out = []; const walk = async (d, pre) => { for await (const [n, h] of d.entries()) h.kind === 'file' ? out.push(pre + n) : await walk(h, pre + n + '/'); }; await walk(await navigator.storage.getDirectory(), ''); return out.sort(); });
  let files = await list(); console.log('   folder:', files.join(', '));
  ok(files.includes('settings.json') && files.filter(f => /^rolls\/.*\.(json|md)$/.test(f)).length === 2 && files.filter(f => f.startsWith('scans/')).length === 1, 'folder has json, md and scan');
  const md = await p.evaluate(async () => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('rolls'); for await (const [n, h] of d.entries()) if (n.endsWith('.md')) return (await h.getFile()).text(); });
  ok(md.includes('| 1 | 2.8 | 1/125 |') && md.includes('soft light'), 'markdown mirror readable');
  // auto mirror on change
  await p.click('#logBtn'); await p.selectOption('#f-meterunit', 'lux'); await p.fill('#f-meterval', '2000'); await p.fill('#f-ap', '2.8'); await p.fill('#f-sh', '1/125'); await p.waitForTimeout(100);
  ok((await p.locator('#evLive').innerText()).includes('meter 9.6'), 'lux readings are converted to EV'); await p.fill('#f-meterval', ''); await p.fill('#f-ap', ''); await p.fill('#f-sh', ''); await p.fill('#f-subject', 'Third'); await p.click('#shotForm button[type=submit] >> nth=1'); await p.waitForTimeout(2500);
  const j = await p.evaluate(async () => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('rolls'); for await (const [n, h] of d.entries()) if (n.endsWith('.json')) return JSON.parse(await (await h.getFile()).text()); });
  ok(j.shots.length === 3 && j.shots[0].photoFile.startsWith('scans/'), 'changes are mirrored automatically');
  const s2 = await snap();
  // wipe browser data, restore from folder
  await wipe(); ok(await snap() === '[]', 'browser data wiped');
  console.log('   after wipe folder:', (await list()).join(', '));
  const r1 = await p.evaluate(async () => { const set = FilmLogStore.kv.set; FilmLogStore.kv.set = (k, v) => k === 'folder' ? Promise.resolve() : set(k, v); await FilmLogSync.setFolder(await navigator.storage.getDirectory()); return FilmLogSync.restoreFolder(); });
  ok(await snap() === s2 && await blobsOk() === 1 && r1.added === 3 && r1.scans === 1, 'restore from folder brings back everything ' + JSON.stringify(r1));
  await p.reload(); await p.waitForTimeout(500);
  ok((await p.locator('#main').innerText()).includes('Kodak Gold 200'), 'restored roll shows after reload');

  // settings screen + GitHub sync through the UI
  await p.goto(URL0 + '#'); await p.waitForTimeout(300); await p.click('#backBtn').catch(() => {}); await p.waitForTimeout(200);
  await p.click('#settingsBtn'); await p.waitForTimeout(200); await shot('03-settings');
  await p.fill('#gh-owner', 'example'); await p.fill('#gh-repo', 'film-log-data'); await p.fill('#gh-token', 'bad'); await p.click('#ghSave'); await p.waitForTimeout(400);
  ok((await p.locator('#ghMsg').innerText()).includes('token was rejected'), 'bad token explained');
  repo.private = false; await p.fill('#gh-token', 'good'); await p.click('#ghSave'); await p.waitForTimeout(400);
  ok((await p.locator('#ghMsg').innerText()).includes('public'), 'public repo warning'); repo.private = true;
  await p.fill('#gh-repo', 'film-log-data '); await p.check('#gh-scans'); await p.click('#ghSave'); await p.waitForTimeout(1500);
  console.log('   repo:', [...repo.files.keys()].join(', '));
  ok(repo.files.size === 4 && [...repo.files.keys()].some(f => f.startsWith('scans/')), 'first push to empty repo incl. scan');
  ok(repo.files.get('settings.json').toString().includes('film-log-settings'), 'utf8 content ok');
  const c0 = repo.commits; await p.evaluate(() => FilmLogSync.syncNow('github'));
  ok(repo.commits === c0, 'second sync pushes nothing when unchanged');
  await p.click('[data-close]').catch(() => {});
  // edit a frame -> only roll files change
  await p.click('[data-open]'); await p.waitForTimeout(200); await p.click('[data-shot] .n >> nth=0'); await p.fill('#f-notes', 'Größe geändert ✓'); await p.click('#shotForm button[type=submit] >> nth=1'); await p.waitForTimeout(300);
  await p.evaluate(() => FilmLogSync.syncNow('github'));
  ok(repo.commits === c0 + 2, 'edit pushes only json+md (' + (repo.commits - c0) + ' commits)');
  ok([...repo.files].find(([k]) => k.startsWith('rolls/') && k.endsWith('.json'))[1].toString('utf8').includes('Größe geändert ✓'), 'umlauts survive the round trip');
  const s3 = await snap();
  // wipe and restore from GitHub
  await wipe(); await p.evaluate(async () => { await FilmLogSync.setGithub({ owner: 'example', repo: 'film-log-data', branch: 'main', token: 'good', scans: true }); });
  const r2 = await p.evaluate(() => FilmLogSync.restoreGithub());
  ok(await snap() === s3 && await blobsOk() === 1, 'restore from GitHub brings back everything ' + JSON.stringify(r2));
  // delete roll -> tombstone removes remote files
  await p.reload(); await p.waitForTimeout(400); await p.goto(URL0 + '#roll-' + (await p.evaluate(() => FilmLogStore.rollIds()[0]))); await p.waitForTimeout(300);
  const bk = await p.evaluate(() => FilmLogSync.backupFile(true));
  await p.click('#editRollBtn'); await p.click('#delRollBtn'); await p.click('#delRollBtn'); await p.waitForTimeout(500);
  await p.evaluate(() => FilmLogSync.syncNow('github'));
  ok(repo.files.size === 1 && repo.files.has('settings.json'), 'deleted roll is removed from the repo (' + [...repo.files.keys()] + ')');
  // backup file restore
  const r3 = await p.evaluate(t => FilmLogSync.restoreBackup(t), bk);
  ok(await snap() === s3 && await blobsOk() === 1, 'backup file restores everything ' + JSON.stringify(r3));
  await p.evaluate(() => FilmLogSync.syncNow('github')); ok(repo.files.size === 4, 'restored roll syncs again (tombstone cleared)');
  // save backup via UI download
  await p.goto(URL0); await p.waitForTimeout(300); if (await p.locator('#backBtn').isVisible()) await p.click('#backBtn'); await p.click('#settingsBtn');
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#bkSave')]);
  ok(/film-log-backup-.*\.json/.test(dl.suggestedFilename()), 'backup file download ' + dl.suggestedFilename());
  await p.waitForTimeout(300); await shot('04-settings-on');
  // markdown export still works
  await p.click('#setExport'); await p.waitForTimeout(300);
  ok((await p.locator('#exportText').inputValue()).includes('| Location |'), 'markdown export');
  await p.click('[data-close]');
  // docs page + offline
  await p.goto(URL0 + 'docs.html'); await p.waitForTimeout(300); ok((await p.title()).includes('Film Log'), 'docs page loads'); await p.screenshot({ path: path.join(__dirname, '05-docs.png') });
  await p.goto(URL0); await p.waitForTimeout(1500);
  ok(await p.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())), 'service worker registered');
  await ctx.setOffline(true); await p.reload(); await p.waitForTimeout(600);
  ok((await p.locator('#main').innerText()).includes('Kodak Gold 200'), 'app works offline');
  await p.goto(URL0 + 'docs.html'); ok((await p.locator('h1').first().innerText()).length > 0, 'docs work offline');
  await ctx.setOffline(false);
  const real = errs.filter(e => !/401|409|Failed to load resource/.test(e));
  ok(real.length === 0, 'no script or CSP errors ' + JSON.stringify(real));
  await b.close(); server.close(); console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
