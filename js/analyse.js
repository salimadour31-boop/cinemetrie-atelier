// analyse.js — pure functions (browser + Node): frame features, cut scoring, adaptive shot detection,
// flash rejection, statistics (ASL…), timecode, exports (CSV, EDL CMX3600, WebVTT, JSON), palettes.
// MIT licence.

export const FEAT_W = 64, FEAT_H = 36;

// Features of one RGBA frame (FEAT_W x FEAT_H), designed to be brightness-invariant so that dark footage
// works: 8x8 chromaticity histogram (r/(r+g+b), g/(r+g+b)), 16x9 grey thumbnail normalised to zero mean /
// unit variance (structure), mean colour and mean luma.
export function features(rgba, w = FEAT_W, h = FEAT_H) {
  const hist = new Float32Array(64), grey = new Float32Array(144);
  let r = 0, g = 0, b = 0;
  const n = w * h;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, R = rgba[i], G = rgba[i + 1], B = rgba[i + 2], S = R + G + B;
    if (S < 24) hist[27]++;                                     // near-black: neutral bin
    else hist[Math.min(7, (R / S * 8) | 0) * 8 + Math.min(7, (G / S * 8) | 0)]++;
    r += R; g += G; b += B;
    const gx = Math.min(15, (x * 16 / w) | 0), gy = Math.min(8, (y * 9 / h) | 0);
    grey[gy * 16 + gx] += 0.299 * R + 0.587 * G + 0.114 * B;
  }
  const cell = n / 144;
  for (let i = 0; i < 64; i++) hist[i] /= n;
  let m = 0; for (let i = 0; i < 144; i++) { grey[i] /= cell; m += grey[i]; }
  m /= 144;
  let v = 0; for (let i = 0; i < 144; i++) { grey[i] -= m; v += grey[i] * grey[i]; }
  const sd = Math.sqrt(v / 144);
  for (let i = 0; i < 144; i++) grey[i] = sd > 1.5 ? grey[i] / sd : 0;   // flat picture: no structure
  return { hist, grey, mean: [r / n, g / n, b / n], luma: m, flat: sd <= 1.5 };
}

// Difference between two frames, 0 (same) .. 1 (totally different): colour distribution + structure,
// plus a luma term that only matters between flat pictures (e.g. black -> white).
export function frameDiff(a, b) {
  let h = 0; for (let i = 0; i < 64; i++) h += Math.abs(a.hist[i] - b.hist[i]);
  let c = 0; for (let i = 0; i < 144; i++) c += a.grey[i] * b.grey[i];
  const corr = a.flat || b.flat ? (a.flat && b.flat ? 1 : 0) : c / 144;
  const lum = Math.min(1, Math.abs(a.luma - b.luma) / 128);
  return Math.min(1, 0.45 * (h / 2) + 0.45 * Math.max(0, Math.min(1, 1 - corr)) + 0.1 * lum + (a.flat && b.flat ? 0.9 * lum : 0));
}

// samples: [{t, f}] in time order. Returns cut indices (index of the first sample of the new shot).
// A cut = local maximum of the difference that stands out from its neighbourhood (adaptive, so dark
// and busy footage both work), above an absolute floor, not a flash (frame after resembles frame before),
// and at least minShot seconds after the previous cut.
export function detectCuts(samples, { sensitivity = 0.5, minShot = 0.4, windowSec = 1.5 } = {}) {
  const n = samples.length;
  if (n < 3) return [];
  const d = new Float32Array(n);
  for (let i = 1; i < n; i++) d[i] = frameDiff(samples[i - 1].f, samples[i].f);
  const floor = 0.32 - 0.24 * sensitivity;          // 0.08 .. 0.32
  const k = 4.5 - 3 * sensitivity;                  // 1.5 .. 4.5 standard deviations
  const cuts = [];
  for (let i = 1; i < n; i++) {
    if (d[i] < floor) continue;
    if ((i > 1 && d[i - 1] > d[i]) || (i + 1 < n && d[i + 1] > d[i])) continue;   // local maximum only
    const t = samples[i].t;
    let s = 0, s2 = 0, m = 0;
    for (let j = i - 1; j >= 1 && samples[j].t >= t - windowSec; j--) { s += d[j]; s2 += d[j] * d[j]; m++; }
    for (let j = i + 1; j < n && samples[j].t <= t + windowSec; j++) { s += d[j]; s2 += d[j] * d[j]; m++; }
    if (m >= 2) {
      const mu = s / m, sd = Math.sqrt(Math.max(0, s2 / m - mu * mu));
      if (d[i] < mu + k * sd && d[i] < mu + 0.25) continue;
    }
    // flash / single-frame glitch: picture after (up to 3 samples) matches the picture before
    let flash = false;
    for (let a = 1; a <= 3 && i + a < n && samples[i + a].t - samples[i - 1].t < 0.5; a++)
      if (frameDiff(samples[i - 1].f, samples[i + a].f) < floor * 0.6) { flash = true; break; }
    for (let a = 2; !flash && a <= 4 && i - a >= 0 && samples[i].t - samples[i - a].t < 0.5; a++)
      if (frameDiff(samples[i - a].f, samples[i].f) < floor * 0.6) flash = true;     // end of a flash
    if (flash) continue;
    const prevT = cuts.length ? samples[cuts[cuts.length - 1]].t : samples[0].t;
    if (t - prevT < minShot) {
      // keep the stronger of the two close cuts
      if (cuts.length && d[i] > d[cuts[cuts.length - 1]]) cuts[cuts.length - 1] = i;
      continue;
    }
    cuts.push(i);
  }
  return cuts;
}

// Shots from cut times (seconds). duration = total length.
export function shotsFromCuts(cutTimes, duration) {
  const t = [...new Set(cutTimes.filter(x => x > 0 && x < duration).map(x => +x.toFixed(4)))].sort((a, b) => a - b);
  const bounds = [0, ...t, duration];
  const shots = [];
  for (let i = 0; i + 1 < bounds.length; i++) shots.push({ start: bounds[i], end: bounds[i + 1] });
  return shots;
}

export function stats(shots) {
  const L = shots.map(s => s.end - s.start).filter(x => x > 0);
  const n = L.length;
  if (!n) return null;
  const total = L.reduce((a, b) => a + b, 0), mean = total / n;
  const sorted = [...L].sort((a, b) => a - b);
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const sd = Math.sqrt(L.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  const bins = [1, 2, 4, 8, 16, Infinity], hist = bins.map(() => 0);
  for (const x of L) hist[bins.findIndex(b => x < b)]++;
  return { count: n, total, asl: mean, median, min: sorted[0], max: sorted[n - 1], sd,
           cutsPerMin: n > 1 ? (n - 1) / (total / 60) : 0, hist, binEdges: [0, 1, 2, 4, 8, 16] };
}

// Timecode HH:MM:SS:FF (non-drop-frame) at integer-rounded fps.
export function timecode(sec, fps = 25) {
  const f = Math.round(fps) || 25;
  let frames = Math.round(sec * fps);
  const ff = frames % f; frames = (frames - ff) / f;
  const ss = frames % 60; frames = (frames - ss) / 60;
  const mm = frames % 60, hh = (frames - mm) / 60;
  const p = x => String(x).padStart(2, '0');
  return `${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`;
}
const clock = sec => { const ms = Math.round(sec * 1000); const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60, r = ms % 1000; const p = (x, n = 2) => String(x).padStart(n, '0'); return `${p(h)}:${p(m)}:${p(s)}.${p(r, 3)}`; };

const csvCell = v => { const s = String(v); return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function toCSV(shots, fps = 25) {
  const rows = [['shot', 'tc_in', 'tc_out', 'start_s', 'end_s', 'duration_s', 'note']];
  shots.forEach((s, i) => rows.push([i + 1, timecode(s.start, fps), timecode(s.end, fps), s.start.toFixed(3), s.end.toFixed(3), (s.end - s.start).toFixed(3), s.note || '']));
  return rows.map(r => r.map(csvCell).join(',')).join('\n') + '\n';
}

// CMX3600 EDL: one event per shot, source = record (the analysed file), cut transitions.
export function toEDL(shots, fps = 25, title = 'CINEMETRIE', clip = 'SOURCE') {
  const name = String(title).toUpperCase().replace(/[^A-Z0-9 _-]/g, '_').slice(0, 60);
  const lines = [`TITLE: ${name}`, 'FCM: NON-DROP FRAME', ''];
  shots.forEach((s, i) => {
    const a = timecode(s.start, fps), b = timecode(s.end, fps);
    lines.push(`${String(i + 1).padStart(3, '0')}  AX       V     C        ${a} ${b} ${a} ${b}`);
    lines.push(`* FROM CLIP NAME: ${clip}`);
    lines.push(`* COMMENT: SHOT ${i + 1}${s.note ? ' - ' + s.note.replace(/\n/g, ' ') : ''}`);
    lines.push('');
  });
  return lines.join('\n');
}

export function toVTT(shots, label = 'Plan') {
  return 'WEBVTT\n\n' + shots.map((s, i) => `${i + 1}\n${clock(s.start)} --> ${clock(s.end)}\n${label} ${i + 1}${s.note ? ' — ' + s.note : ''}\n`).join('\n');
}

export function toJSON(meta, shots, st) {
  return JSON.stringify({ tool: 'cinemetrie-atelier', version: 1, ...meta, stats: st,
    shots: shots.map((s, i) => ({ n: i + 1, start: +s.start.toFixed(3), end: +s.end.toFixed(3), duration: +(s.end - s.start).toFixed(3), palette: s.palette || [], note: s.note || '' })) }, null, 2);
}

// Re-import a JSON project or a CSV produced by this tool.
export function parseProject(text) {
  const tx = text.trim();
  if (tx.startsWith('{')) { const j = JSON.parse(tx); return (j.shots || []).map(s => ({ start: +s.start, end: +s.end, note: s.note || '' })); }
  const lines = tx.split(/\r?\n/).slice(1).filter(Boolean);
  return lines.map(l => { const c = l.split(','); return { start: +c[3], end: +c[4], note: c.slice(6).join(',').replace(/^"|"$/g, '') }; });
}

// Deterministic k-means palette of an RGBA buffer -> k colours sorted by share: [{rgb:[r,g,b], share}].
export function palette(rgba, k = 5, iters = 12) {
  const px = [];
  for (let i = 0; i < rgba.length; i += 4 * 2) px.push([rgba[i], rgba[i + 1], rgba[i + 2]]);
  if (!px.length) return [];
  const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  // farthest-point initialisation from the mean (deterministic)
  const mean = [0, 1, 2].map(c => px.reduce((s, p) => s + p[c], 0) / px.length);
  const C = [px.reduce((best, p) => d2(p, mean) < d2(best, mean) ? p : best, px[0]).slice()];
  while (C.length < k) {
    let far = px[0], fd = -1;
    for (const p of px) { const m = Math.min(...C.map(c => d2(p, c))); if (m > fd) { fd = m; far = p; } }
    if (fd <= 0) break;
    C.push(far.slice());
  }
  const lab = new Int32Array(px.length);
  for (let it = 0; it < iters; it++) {
    const sum = C.map(() => [0, 0, 0, 0]);
    px.forEach((p, i) => { let bi = 0, bd = Infinity; C.forEach((c, j) => { const d = d2(p, c); if (d < bd) { bd = d; bi = j; } }); lab[i] = bi; const s = sum[bi]; s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3]++; });
    C.forEach((c, j) => { if (sum[j][3]) { c[0] = sum[j][0] / sum[j][3]; c[1] = sum[j][1] / sum[j][3]; c[2] = sum[j][2] / sum[j][3]; } });
  }
  const cnt = C.map(() => 0); lab.forEach(l => cnt[l]++);
  return C.map((c, j) => ({ rgb: c.map(Math.round), share: cnt[j] / px.length })).filter(c => c.share > 0).sort((a, b) => b.share - a.share);
}
export const hex = rgb => '#' + rgb.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

// Estimate the frame rate from presented media times (median of the smallest positive steps).
export function estimateFps(times) {
  const steps = [];
  for (let i = 1; i < times.length; i++) { const d = times[i] - times[i - 1]; if (d > 0.004) steps.push(d); }
  if (!steps.length) return 25;
  steps.sort((a, b) => a - b);
  const base = steps[Math.floor(steps.length * 0.1)];
  const fps = 1 / base;
  const common = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];
  let best = common[0]; for (const c of common) if (Math.abs(c - fps) < Math.abs(best - fps)) best = c;
  return Math.abs(best - fps) / fps < 0.04 ? best : Math.round(fps * 100) / 100;
}
