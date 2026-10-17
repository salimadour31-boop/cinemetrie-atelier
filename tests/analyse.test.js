// Unit tests of js/analyse.js with synthetic frames (no browser needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { features, frameDiff, detectCuts, shotsFromCuts, stats, timecode, toCSV, toEDL, toVTT, toJSON, parseProject, palette, estimateFps, hex, FEAT_W, FEAT_H } from '../js/analyse.js';

let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
// a "scene": base colours + a moving gradient + a moving blob + noise; brightness scale for dark footage
function frame(scene, t, { bright = 1, noise = 6 } = {}) {
  const px = new Uint8ClampedArray(FEAT_W * FEAT_H * 4);
  const c1 = scene.c1, c2 = scene.c2, bx = 32 + 20 * Math.sin(scene.bx + t * scene.v);   // blob sways (no teleport)
  for (let y = 0; y < FEAT_H; y++) for (let x = 0; x < FEAT_W; x++) {
    const i = (y * FEAT_W + x) * 4, a = (x + t * scene.v * 8) / FEAT_W % 1;
    const inBlob = (x - bx) ** 2 + (y - FEAT_H / 2) ** 2 < 60;
    for (let c = 0; c < 3; c++) px[i + c] = bright * ((inBlob ? scene.blob[c] : c1[c] * (1 - a) + c2[c] * a) + (rnd() - 0.5) * noise);
    px[i + 3] = 255;
  }
  return px;
}
const scenes = Array.from({ length: 12 }, (_, k) => ({ c1: [40 + 17 * k % 200, 200 - 13 * k % 180, 90 + 29 * k % 160], c2: [220 - 23 * k % 200, 60 + 31 * k % 190, 30 + 41 * k % 220], blob: [(k * 70) % 255, (k * 130) % 255, (k * 200) % 255], bx: k * 5, v: 0.5 + (k % 3) * 0.4 }));

// Build a sampled clip: list of shot lengths (s), sampling fps; returns samples + true cut times
function clip(lengths, fps = 12, opt = {}) {
  const samples = [], cuts = []; let t0 = 0;
  lengths.forEach((L, k) => {
    if (k) cuts.push(t0);
    for (let t = 0; t < L - 1e-9; t += 1 / fps) samples.push({ t: +(t0 + t).toFixed(6), f: features(frame(scenes[k % scenes.length], t, opt)) });
    t0 += L;
  });
  return { samples, cuts, duration: t0 };
}
const near = (found, truth, tol) => truth.every(c => found.some(f => Math.abs(f - c) <= tol)) && found.every(f => truth.some(c => Math.abs(f - c) <= tol));

test('features: histogram sums to 1, mean colour', () => {
  const f = features(frame(scenes[0], 0));
  assert.ok(Math.abs(f.hist.reduce((a, b) => a + b, 0) - 1) < 1e-5);
  assert.equal(f.mean.length, 3);
  assert.ok(frameDiff(f, f) < 1e-6);
});

test('frameDiff: same scene small, different scenes large', () => {
  const a = features(frame(scenes[0], 0)), b = features(frame(scenes[0], 0.1)), c = features(frame(scenes[5], 0));
  assert.ok(frameDiff(a, b) < 0.1, 'same scene ' + frameDiff(a, b));
  assert.ok(frameDiff(a, c) > 0.3, 'cut ' + frameDiff(a, c));
});

test('detectCuts: finds every cut of a 10-shot clip, no false cut', () => {
  const { samples, cuts } = clip([2.5, 1.2, 3, 0.8, 4, 2, 1.5, 0.6, 2.2, 3]);
  const found = detectCuts(samples).map(i => samples[i].t);
  assert.ok(near(found, cuts, 0.1), `found ${found} truth ${cuts}`);
});

test('detectCuts: dark footage (brightness 25%) still detected', () => {
  const { samples, cuts } = clip([2, 2, 2, 2, 2], 12, { bright: 0.25, noise: 3 });
  const found = detectCuts(samples).map(i => samples[i].t);
  assert.ok(near(found, cuts, 0.1), `found ${found} truth ${cuts}`);
});

test('detectCuts: single-frame flash is not a cut', () => {
  const { samples } = clip([6], 12);
  const white = new Uint8ClampedArray(FEAT_W * FEAT_H * 4).fill(255);
  samples[30].f = features(white);
  assert.deepEqual(detectCuts(samples), []);
});

test('detectCuts: noisy handheld single shot has no cuts', () => {
  const { samples } = clip([10], 12, { noise: 30 });
  assert.equal(detectCuts(samples).length, 0);
});

test('detectCuts: minShot merges cuts closer than the limit', () => {
  const { samples } = clip([2, 0.25, 2], 12);
  assert.equal(detectCuts(samples, { minShot: 0.4 }).length, 1);
  assert.equal(detectCuts(samples, { minShot: 0.1 }).length, 2);
});

test('detectCuts: higher sensitivity never finds fewer cuts', () => {
  const { samples } = clip([1, 2, 1, 3, 1, 2], 12, { bright: 0.5 });
  const lo = detectCuts(samples, { sensitivity: 0.1 }).length, hi = detectCuts(samples, { sensitivity: 0.9 }).length;
  assert.ok(hi >= lo);
});

test('detectCuts: irregular sampling (dropped frames at high playback speed)', () => {
  const { samples, cuts } = clip([2, 3, 1.5, 2.5], 24);
  const thinned = samples.filter(() => rnd() > 0.5);
  const found = detectCuts(thinned).map(i => thinned[i].t);
  assert.ok(near(found, cuts, 0.25), `found ${found}`);
});

test('shots and stats', () => {
  const shots = shotsFromCuts([2, 3, 7, 7, 0, 12], 10);
  assert.deepEqual(shots, [{ start: 0, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 7 }, { start: 7, end: 10 }]);
  const st = stats(shots);
  assert.equal(st.count, 4); assert.equal(st.asl, 2.5); assert.equal(st.median, 2.5);
  assert.equal(st.min, 1); assert.equal(st.max, 4);
  assert.ok(Math.abs(st.cutsPerMin - 18) < 1e-9);
  assert.deepEqual(st.hist, [0, 1, 2, 1, 0, 0]);
  assert.equal(stats([]), null);
});

test('timecode', () => {
  assert.equal(timecode(0, 25), '00:00:00:00');
  assert.equal(timecode(3661.48, 25), '01:01:01:12');
  assert.equal(timecode(59.99, 24), '00:01:00:00');
  assert.equal(timecode(1 / 30 * 29, 30), '00:00:00:29');
});

test('exports: CSV, EDL, VTT, JSON round trip', () => {
  const shots = [{ start: 0, end: 2 }, { start: 2, end: 5.6, note: 'gros plan, "nuit"' }];
  const csv = toCSV(shots, 25);
  assert.match(csv, /^shot,tc_in,tc_out/);
  assert.match(csv, /2,00:00:02:00,00:00:05:15,2.000,5.600,3.600,"gros plan, ""nuit"""/);
  const edl = toEDL(shots, 25, 'Mon film');
  assert.match(edl, /^TITLE: MON FILM/);
  assert.match(edl, /002  AX       V     C        00:00:02:00 00:00:05:15 00:00:02:00 00:00:05:15/);
  const vtt = toVTT(shots);
  assert.match(vtt, /^WEBVTT/); assert.match(vtt, /00:00:02.000 --> 00:00:05.600/);
  const json = toJSON({ file: 'a.mp4', fps: 25 }, shots, stats(shots));
  const back = parseProject(json);
  assert.deepEqual(back.map(s => [s.start, s.end]), [[0, 2], [2, 5.6]]);
  assert.deepEqual(parseProject(toCSV([{ start: 0, end: 1 }, { start: 1, end: 3 }])).map(s => s.end), [1, 3]);
});

test('palette: finds the dominant colours with their share', () => {
  const px = new Uint8ClampedArray(100 * 4 * 4);
  for (let i = 0; i < 400; i++) { const red = i < 300; px.set(red ? [200, 20, 30, 255] : [10, 40, 220, 255], i * 4); }
  const p = palette(px, 3);
  assert.equal(hex(p[0].rgb), '#c8141e');
  assert.ok(Math.abs(p[0].share - 0.75) < 0.02);
  assert.equal(hex(p[1].rgb), '#0a28dc');
});

test('estimateFps', () => {
  const t = Array.from({ length: 100 }, (_, i) => i / 25);
  assert.equal(estimateFps(t), 25);
  assert.equal(estimateFps(t.filter((_, i) => i % 3 !== 1)), 25);
  assert.equal(estimateFps(Array.from({ length: 50 }, (_, i) => i * 1001 / 24000)), 23.976);
});
