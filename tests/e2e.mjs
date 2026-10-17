// End-to-end test in a real browser (Playwright/Chromium): serves the site, loads the synthetic film
// (tests/make-video.sh), analyses it at several speeds and checks the detected cuts against the truth,
// then exports CSV/EDL/JSON and the contact sheet, re-imports the JSON, and tests editing.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TRUTH = [2.4, 4.0, 7.0, 7.8, 10.0, 11.0];
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webm': 'video/webm' };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html'));
  if (!p.startsWith(root) || !fs.existsSync(p)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res);
}).listen(0);
const url = `http://127.0.0.1:${server.address().port}/`;
let fails = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) fails++; };

const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1280, height: 1400 } });
page.on('pageerror', e => { console.log('page error:', e.message); fails++; });
await page.goto(url);
await page.setInputFiles('#file', path.join(root, 'tests/fixture.webm'));
await page.waitForFunction(() => !document.querySelector('#go').disabled);

for (const speed of ['16', '1', '4']) {
  await page.selectOption('#speed', speed);
  const t0 = Date.now();
  await page.click('#go');
  await page.waitForFunction(() => !window.__cin.busy && window.__cin.shots.length > 0, null, { timeout: 120000 });
  const r = await page.evaluate(() => ({ cuts: window.__cin.shots.slice(1).map(s => s.start), fps: window.__cin.fps, n: window.__cin.samples.length }));
  const frame = 1 / 25;
  const matched = TRUTH.filter(c => r.cuts.some(x => Math.abs(x - c) <= frame + 1e-6)).length;
  const extra = r.cuts.filter(x => !TRUTH.some(c => Math.abs(x - c) <= frame + 1e-6));
  console.log(`speed ${speed}x: ${r.n} frames sampled, fps ${r.fps}, cuts ${r.cuts.map(x => x.toFixed(3)).join(' ')} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  check(r.fps === 25, `speed ${speed}x: frame rate estimated 25`);
  check(matched === TRUTH.length, `speed ${speed}x: all ${TRUTH.length} cuts found within ±1 frame (${matched})`);
  check(extra.length === 0, `speed ${speed}x: no false cut (flash frame and camera pan ignored) ${extra.join(' ')}`);
}

const stats = await page.$$eval('.stat b', els => els.map(e => e.textContent));
check(stats[0] === '7', `7 shots shown (${stats[0]})`);
check(/1\.86/.test(stats[1]), `ASL 13/7 = 1.86 s (${stats[1]})`);
check(await page.$$eval('.shot img', i => i.length) === 7, '7 thumbnails');
check(await page.$$eval('.shot .pal i', i => i.length) >= 7, 'palettes shown');

async function dl(sel) { const [d] = await Promise.all([page.waitForEvent('download'), page.click(sel)]); return fs.readFileSync(await d.path()); }
const csv = (await dl('[data-exp=csv]')).toString();
check(csv.split('\n')[2].startsWith('2,00:00:02:10,00:00:04:00'), 'CSV row 2 timecodes');
const edl = (await dl('[data-exp=edl]')).toString();
check(/007  AX       V     C        00:00:11:00 00:00:13:00/.test(edl), 'EDL last event');
const json = (await dl('[data-exp=json]')).toString();
check(JSON.parse(json).shots.length === 7, 'JSON has 7 shots');
const png = await dl('[data-exp=sheet]');
check(png.slice(1, 4).toString() === 'PNG' && png.length > 50000, `contact sheet PNG (${png.length} bytes)`);
const bar = await dl('[data-exp=barcode]');
check(bar.slice(1, 4).toString() === 'PNG', 'barcode PNG');

// editing: merge shot 2 into 1, then cut again at 2.4 s
await page.click('.shot:nth-child(2) .x');
check(await page.$$eval('.shot', s => s.length) === 6, 'merge removes a cut');
await page.evaluate(() => { document.querySelector('#video').currentTime = 2.4; });
await page.waitForTimeout(300);
await page.click('#cutHere');
await page.waitForFunction(() => window.__cin.shots.length === 7);
check(await page.evaluate(() => Math.abs(window.__cin.shots[1].start - 2.4) < 1e-6), 'cut here at 2.4 s');

// re-import the JSON project
fs.writeFileSync('/tmp/cin-project.json', json);
await page.click('.shot:nth-child(3) .x');
await page.setInputFiles('#importP', '/tmp/cin-project.json');
await page.waitForFunction(() => window.__cin.shots.length === 7);
check(true, 'JSON project re-imported');

// languages
for (const l of ['en', 'kab', 'fr']) { await page.click(`[data-lang=${l}]`); }
check(await page.textContent('#go') === 'Analyser', 'language switch back to French');
await page.click('[data-lang=en]');
await page.waitForFunction(() => document.querySelectorAll('.shot img').length === 7 && !/…/.test(document.querySelector('#status').textContent));
await page.screenshot({ path: path.join(root, 'screenshot.png'), fullPage: false });
await page.click('[data-lang=fr]');

await browser.close(); server.close();
console.log(fails ? `${fails} FAILED` : 'ALL OK');
process.exit(fails ? 1 : 0);
