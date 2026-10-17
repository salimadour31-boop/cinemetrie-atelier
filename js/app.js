// app.js — UI: load a local video, scan it (requestVideoFrameCallback while playing fast, or seek
// stepping), detect cuts, refine them to the exact frame by seeking, then show stats, charts, shots,
// and export. Everything stays in the tab.
import { FEAT_W, FEAT_H, features, frameDiff, detectCuts, shotsFromCuts, stats, timecode, toCSV, toEDL, toVTT, toJSON, parseProject, palette, hex, estimateFps } from './analyse.js';
import { STR } from './i18n.js';

const $ = s => document.querySelector(s);
const video = $('#video'), fileIn = $('#file'), drop = $('#drop');
const small = document.createElement('canvas'); small.width = FEAT_W; small.height = FEAT_H;
const sctx = small.getContext('2d', { willReadFrequently: true });
const thumbC = document.createElement('canvas'); thumbC.width = 320; thumbC.height = 180;
const tctx = thumbC.getContext('2d', { willReadFrequently: true });

const state = { lang: localStorage.getItem('cin-lang') || (navigator.language || 'fr').slice(0, 2), file: null, samples: [], shots: [], fps: 25, duration: 0, busy: false, cancel: false };
if (!STR[state.lang]) state.lang = 'fr';
const T = k => STR[state.lang][k] ?? STR.fr[k];
window.__cin = state;                      // exposed for the end-to-end test

function applyLang() {
  document.documentElement.lang = state.lang === 'kab' ? 'kab' : state.lang;
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = T(el.dataset.i18n); });
  document.querySelectorAll('.lang button').forEach(b => b.classList.toggle('on', b.dataset.lang === state.lang));
  render();
}
document.querySelectorAll('.lang button').forEach(b => b.onclick = () => { state.lang = b.dataset.lang; localStorage.setItem('cin-lang', state.lang); applyLang(); });

const status = (msg, p) => { $('#status').textContent = msg; if (p != null) $('#bar').style.width = (100 * Math.max(0, Math.min(1, p))) + '%'; };
$('#sens').oninput = e => $('#sensOut').textContent = Math.round(e.target.value * 100) + '%';

// ---------- loading ----------
function load(file) {
  if (!file) return;
  state.file = file; state.samples = []; state.shots = [];
  video.src = URL.createObjectURL(file); video.hidden = false; drop.hidden = true;
  video.onloadedmetadata = () => { state.duration = video.duration; $('#go').disabled = false; $('#cutHere').disabled = false; status(file.name + ' · ' + timecode(video.duration, 25), 0); render(); };
  video.onerror = () => status('⚠ ' + file.name + ' : format non lu par ce navigateur / unsupported format', 0);
}
fileIn.onchange = () => load(fileIn.files[0]);
['dragover', 'dragenter'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
document.addEventListener('dragleave', () => drop.classList.remove('over'));
document.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f && /video|matroska/.test(f.type || 'video')) load(f); });

// ---------- frame access ----------
function grab() { sctx.drawImage(video, 0, 0, FEAT_W, FEAT_H); return sctx.getImageData(0, 0, FEAT_W, FEAT_H).data; }
function seek(t) {
  return new Promise(res => {
    const done = () => { video.removeEventListener('seeked', done); res(); };
    video.addEventListener('seeked', done);
    video.currentTime = Math.max(0, Math.min(state.duration - 1e-3, t));
  });
}

// Frame rate: play ~16 frames at normal speed and look at the presented media times.
async function probeFps() {
  if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) return null;
  const times = [];
  video.pause(); await seek(Math.min(1, state.duration / 3));
  video.muted = true; video.playbackRate = 1;
  await new Promise(resolve => {
    let live = true; const finish = () => { live = false; resolve(); };
    const timer = setTimeout(finish, 2500);
    const onFrame = (now, meta) => { if (!live) return; times.push(meta.mediaTime); if (times.length >= 16 || video.ended) { clearTimeout(timer); finish(); } else video.requestVideoFrameCallback(onFrame); };
    video.requestVideoFrameCallback(onFrame);
    video.play().catch(() => { clearTimeout(timer); finish(); });
  });
  video.pause();
  return times.length >= 4 ? estimateFps(times) : null;
}

async function scanPlaying(rate) {
  const samples = [];
  video.pause(); await seek(0);
  video.muted = true; video.playbackRate = rate;
  await new Promise((done) => {
    let live = true; const resolve = () => { live = false; done(); };   // ignore callbacks after the end
    const onFrame = (now, meta) => {
      if (!live) return;
      if (state.cancel) { video.pause(); resolve(); return; }
      const px = grab();
      samples.push({ t: meta.mediaTime, f: features(px) });
      status(T('scanning') + ' ' + Math.round(100 * meta.mediaTime / state.duration) + '%', meta.mediaTime / state.duration * 0.8);
      if (!video.ended) video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
    video.onended = () => { video.onended = null; resolve(); };
    video.play().catch(() => resolve());
  });
  video.pause(); video.playbackRate = 1;
  return samples;
}
async function scanSeeking(step) {
  const samples = [];
  video.pause();
  for (let t = 0; t < state.duration && !state.cancel; t += step) {
    await seek(t); samples.push({ t, f: features(grab()) });
    status(T('scanning') + ' ' + Math.round(100 * t / state.duration) + '%', t / state.duration * 0.8);
  }
  return samples;
}

// binary search between the last frame of shot A (ta) and the first sampled frame of shot B (tb)
async function refine(ta, fa, tb, fb) {
  const fr = 1 / state.fps;
  let lo = Math.round(ta / fr) * fr, hi = Math.round(tb / fr) * fr, guard = 0;
  while (hi - lo > fr * 1.01 && guard++ < 12) {
    const mid = Math.round(((lo + hi) / 2) / fr) * fr;
    if (mid <= lo + 1e-6 || mid >= hi - 1e-6) break;
    await seek(mid + fr * 0.25);
    const f = features(grab());
    if (frameDiff(f, fa) <= frameDiff(f, fb)) lo = mid; else hi = mid;
  }
  return Math.round(hi / fr) * fr;
}

async function analyse() {
  if (state.busy) { state.cancel = true; return; }
  state.busy = true; state.cancel = false;
  $('#go').textContent = T('cancel');
  try {
    const rate = +$('#speed').value;
    const probed = await probeFps();
    const samples = 'requestVideoFrameCallback' in HTMLVideoElement.prototype ? await scanPlaying(rate) : (status(T('noRVFC')), await scanSeeking(1 / 8));
    if (state.cancel || samples.length < 2) return;
    samples.sort((a, b) => a.t - b.t);
    state.samples = samples;
    state.fps = probed || estimateFps(samples.map(s => s.t));
    const idx = detectCuts(samples, { sensitivity: +$('#sens').value, minShot: +$('#minShot').value });
    let cuts = idx.map(i => samples[i].t);
    if ($('#precise').checked) {
      for (let k = 0; k < idx.length && !state.cancel; k++) {
        const i = idx[k];
        status(T('refining') + ` ${k + 1}/${idx.length}`, 0.8 + 0.1 * k / idx.length);
        // always refine: while playing fast, the drawn picture can be one frame ahead of its media time,
        // so search a little outside the sampled interval (shots are longer than minShot anyway)
        const m = 2 / state.fps;
        cuts[k] = await refine(Math.max(0, samples[i - 1].t - m), samples[i - 1].f, Math.min(state.duration, samples[i].t + m), samples[i].f);
      }
    }
    state.shots = shotsFromCuts(cuts, state.duration);
    await thumbnails();
    status(`${T('done')} · ${state.shots.length} ${T('shots').toLowerCase()} · ${samples.length} images`, 1);
  } finally {
    state.busy = false; state.cancel = false; $('#go').textContent = T('analyse'); render();
  }
}
$('#go').onclick = analyse;

async function thumbnails() {
  const todo = state.shots.filter(s => !s.thumb);
  for (let k = 0; k < todo.length; k++) {
    const s = todo[k];
    await seek(s.start + Math.min(0.5 * (s.end - s.start), 1.0));
    tctx.drawImage(video, 0, 0, 320, 180);
    s.thumb = thumbC.toDataURL('image/jpeg', 0.82);
    s.palette = palette(grab(), 5).map(c => ({ hex: hex(c.rgb), share: +c.share.toFixed(3) }));
    status(T('thumbs') + ` ${k + 1}/${todo.length}`, 0.9 + 0.1 * k / todo.length);
  }
}

// ---------- editing ----------
$('#cutHere').onclick = async () => {
  const t = Math.round(video.currentTime * state.fps) / state.fps;
  const cuts = state.shots.slice(1).map(s => s.start);
  if (!state.shots.length) state.shots = [{ start: 0, end: state.duration }];
  const i = state.shots.findIndex(s => t > s.start + 1e-3 && t < s.end - 1e-3);
  if (i < 0) return;
  const s = state.shots[i];
  state.shots.splice(i, 1, { start: s.start, end: t, note: s.note }, { start: t, end: s.end });
  void cuts;
  render(); await thumbnails(); status(`${state.shots.length} ${T('shots').toLowerCase()}`, 1); render();
};
function mergePrev(i) {
  if (i <= 0) return;
  const a = state.shots[i - 1], b = state.shots[i];
  state.shots.splice(i - 1, 2, { ...a, end: b.end, note: [a.note, b.note].filter(Boolean).join(' / ') });
  render();
}

// ---------- rendering ----------
const fmt = x => (x == null || !isFinite(x)) ? '–' : x.toFixed(x < 10 ? 2 : 1) + ' ' + T('secs');
function render() {
  const st = stats(state.shots);
  const items = [
    [T('shots'), st ? st.count : '–'], [T('asl'), fmt(st?.asl)], [T('median'), fmt(st?.median)], [T('cpm'), st ? st.cutsPerMin.toFixed(1) : '–'],
    [T('shortest'), fmt(st?.min)], [T('longest'), fmt(st?.max)], [T('duration'), state.duration ? timecode(state.duration, state.fps) : '–'], [T('fps'), state.samples.length ? state.fps : '–'],
  ];
  $('#stats').innerHTML = items.map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join('');
  drawRhythm(st); drawHist(st); drawBarcode();
  const box = $('#shots');
  box.innerHTML = '';
  state.shots.forEach((s, i) => {
    const d = document.createElement('div'); d.className = 'shot';
    d.innerHTML = `${s.thumb ? `<img alt="" src="${s.thumb}">` : '<div class="ph"></div>'}
      ${i ? `<button class="x" title="${T('merge')}">✕</button>` : ''}
      <div class="pal">${(s.palette || []).map(c => `<i style="background:${c.hex};flex:${Math.max(0.05, c.share)}"></i>`).join('')}</div>
      <div class="meta"><span><b>#${i + 1}</b> · ${timecode(s.start, state.fps)} → ${timecode(s.end, state.fps)}</span><span>${fmt(s.end - s.start)}</span>
      <input placeholder="${T('note')}" value="${(s.note || '').replace(/"/g, '&quot;')}"></div>`;
    d.querySelector('img, .ph').onclick = () => { video.currentTime = s.start + 0.5 / state.fps; };
    const x = d.querySelector('.x'); if (x) x.onclick = () => mergePrev(i);
    d.querySelector('input').onchange = e => { s.note = e.target.value; };
    box.appendChild(d);
  });
}
video.ontimeupdate = () => {
  const t = video.currentTime;
  document.querySelectorAll('.shot').forEach((el, i) => { const s = state.shots[i]; el.classList.toggle('cur', !!s && t >= s.start && t < s.end); });
};

function drawRhythm(st) {
  const c = $('#rhythm'), g = c.getContext('2d'), W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  if (!st) return;
  const maxL = Math.log(1 + st.max);
  state.shots.forEach((s, i) => {
    const x = s.start / state.duration * W, w = Math.max(1, (s.end - s.start) / state.duration * W - 1);
    const h = Math.log(1 + s.end - s.start) / maxL * (H - 24);
    g.fillStyle = s.palette?.[0]?.hex || (i % 2 ? '#8fd3c1' : '#6fb3a3');
    g.fillRect(x, H - h, w, h);
  });
  const y = H - Math.log(1 + st.asl) / maxL * (H - 24);
  g.strokeStyle = '#ffb454'; g.setLineDash([6, 4]); g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); g.setLineDash([]);
  g.fillStyle = '#ffb454'; g.font = '13px system-ui'; g.fillText('ASL ' + st.asl.toFixed(2) + ' s', 8, y - 6);
}
function drawHist(st) {
  const c = $('#hist'), g = c.getContext('2d'), W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  if (!st) return;
  const m = Math.max(...st.hist), bw = W / 6;
  st.hist.forEach((v, i) => {
    const h = m ? v / m * (H - 44) : 0;
    g.fillStyle = '#8fd3c1'; g.fillRect(i * bw + 8, H - 22 - h, bw - 16, h);
    g.fillStyle = '#e9ecf2'; g.font = '13px system-ui'; g.textAlign = 'center';
    g.fillText(v, i * bw + bw / 2, H - 28 - h);
    g.fillStyle = '#969eaf'; g.fillText(T('bins')[i], i * bw + bw / 2, H - 6);
  });
}
function drawBarcode(target) {
  const c = target || $('#barcode'), g = c.getContext('2d'), W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  const s = state.samples; if (!s.length) return;
  for (let i = 0; i < s.length; i++) {
    const x0 = i === 0 ? 0 : s[i].t / state.duration * W, x1 = (i + 1 < s.length ? s[i + 1].t : state.duration) / state.duration * W;
    const m = s[i].f.mean; g.fillStyle = `rgb(${m[0] | 0},${m[1] | 0},${m[2] | 0})`;
    g.fillRect(Math.floor(x0), 0, Math.max(1, Math.ceil(x1) - Math.floor(x0)), H);
  }
}

// ---------- exports ----------
function download(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const base = () => (state.file?.name || 'video').replace(/\.[^.]+$/, '');
async function contactSheet() {
  const cols = 5, tw = 320, th = 180, pad = 14, lab = 34, head = 70;
  const rows = Math.ceil(state.shots.length / cols);
  const c = document.createElement('canvas'); c.width = cols * (tw + pad) + pad; c.height = head + rows * (th + lab + pad) + pad;
  const g = c.getContext('2d');
  g.fillStyle = '#111319'; g.fillRect(0, 0, c.width, c.height);
  const st = stats(state.shots);
  g.fillStyle = '#e9ecf2'; g.font = 'bold 24px system-ui'; g.fillText(`${T('sheetTitle')} — ${state.file?.name || ''}`, pad, 34);
  g.fillStyle = '#969eaf'; g.font = '15px system-ui';
  g.fillText(`${st.count} ${T('shots').toLowerCase()} · ASL ${st.asl.toFixed(2)} s · ${T('median')} ${st.median.toFixed(2)} s · ${T('duration')} ${timecode(state.duration, state.fps)} · ${state.fps} fps`, pad, 58);
  for (let i = 0; i < state.shots.length; i++) {
    const s = state.shots[i], x = pad + (i % cols) * (tw + pad), y = head + Math.floor(i / cols) * (th + lab + pad);
    if (s.thumb) { const im = new Image(); im.src = s.thumb; await im.decode(); g.drawImage(im, x, y, tw, th); }
    (s.palette || []).reduce((ox, p) => { const w = p.share * tw; g.fillStyle = p.hex; g.fillRect(x + ox, y + th, w, 6); return ox + w; }, 0);
    g.fillStyle = '#ffb454'; g.font = 'bold 14px system-ui'; g.fillText(`#${i + 1}`, x, y + th + 24);
    g.fillStyle = '#e9ecf2'; g.font = '13px system-ui'; g.fillText(`${timecode(s.start, state.fps)} · ${(s.end - s.start).toFixed(2)} s${s.note ? ' · ' + s.note.slice(0, 24) : ''}`, x + 40, y + th + 24);
  }
  return new Promise(res => c.toBlob(res, 'image/png'));
}
document.querySelectorAll('[data-exp]').forEach(b => b.onclick = async () => {
  if (!state.shots.length) return;
  const k = b.dataset.exp, st = stats(state.shots);
  if (k === 'csv') download(base() + '-plans.csv', toCSV(state.shots, state.fps), 'text/csv');
  if (k === 'edl') download(base() + '.edl', toEDL(state.shots, state.fps, base(), state.file?.name || 'SOURCE'), 'text/plain');
  if (k === 'vtt') download(base() + '-plans.vtt', toVTT(state.shots, T('plan')), 'text/vtt');
  if (k === 'json') download(base() + '-cinemetrie.json', toJSON({ file: state.file?.name, fps: state.fps, duration: state.duration }, state.shots, st), 'application/json');
  if (k === 'sheet') download(base() + '-planche.png', await contactSheet());
  if (k === 'barcode') { const c = document.createElement('canvas'); c.width = 1920; c.height = 400; drawBarcode(c); c.toBlob(bl => download(base() + '-barcode.png', bl)); }
});
$('#importP').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  const shots = parseProject(await f.text());
  if (!shots.length) return;
  state.shots = shots;
  if (!state.duration) state.duration = shots[shots.length - 1].end;
  render();
  if (video.src) { await thumbnails(); render(); }
  status(`${f.name} · ${state.shots.length} ${T('shots').toLowerCase()}`, 1);
};

applyLang();
