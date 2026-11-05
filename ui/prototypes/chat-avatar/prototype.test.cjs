const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const { resolve } = require('node:path');

async function setup({ reduced = false } = {}) {
  const { Window } = await import(pathToFileURL(resolve(__dirname, '../../../apps/web/node_modules/happy-dom/lib/index.js')).href);
  const window = new Window();
  const timers = new Map();
  let timerId = 0;
  window.setInterval = callback => { timers.set(++timerId, callback); return timerId; };
  window.clearInterval = id => timers.delete(id);
  const frames = new Map();
  let frameId = 0;
  let now = 0;
  Object.defineProperty(window, 'performance', { value: { now: () => now }, configurable: true });
  window.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
  window.cancelAnimationFrame = id => frames.delete(id);
  const media = new window.EventTarget();
  media.matches = reduced;
  window.matchMedia = () => media;
  const advance = ms => {
    now += ms;
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach(callback => callback(now));
  };
  const html = readFileSync(resolve(__dirname, 'index.html'), 'utf8');
  window.document.write(html);
  window.eval(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
  return { window, document: window.document, timers, frames, advance, tick: () => [...timers.values()].forEach(callback => callback()) };
}

test('nine robot expressions update the message and distinguish active from terminal states', async () => {
  const { window, document } = await setup();
  try {
    assert.equal(document.querySelectorAll('.state-card').length, 9);
    for (const state of ['connecting', 'thinking', 'searching', 'working', 'writing', 'waiting', 'done', 'failed', 'stopped']) {
      document.querySelector(`[data-select="${state}"]`).click();
      const preview = document.querySelector('#preview');
      assert.equal(preview.dataset.state, state);
      assert.equal(document.querySelectorAll('[data-select][aria-pressed="true"]').length, 1);
      assert.equal(preview.dataset.active, String(['connecting', 'thinking', 'searching', 'working', 'writing'].includes(state)));
      assert.ok(document.querySelector('#reply').textContent.length > 0);
    }
    document.querySelector('#theme').click();
    assert.equal(document.body.dataset.theme, 'dark');
  } finally { await window.happyDOM.abort(); }
});

test('mouthless expressions distinguish every state; writing looks around and done rests', async () => {
  const { window, document, advance, frames } = await setup();
  try {
    document.querySelector('[data-select="writing"]').click();
    advance(300);
    const eye = document.querySelector('#small-avatar .eye-left');
    assert.equal(document.querySelectorAll('.mouth').length, 0);
    assert.equal(document.querySelectorAll('.brows, .brow-left, .brow-right').length, 0);
    const expressions = [...document.querySelectorAll('.state-card')].map(card =>
      [...card.querySelectorAll('.eye')].map(path => path.getAttribute('d')).join('|'));
    assert.equal(new Set(expressions).size, 9, 'each state has its own eye expression');
    const gaze = document.querySelector('#small-avatar .gaze-pose');
    const openEye = eye.getAttribute('d');
    const initialGaze = gaze.getAttribute('transform');
    advance(200);
    assert.equal(eye.getAttribute('d'), openEye);
    assert.notEqual(gaze.getAttribute('transform'), initialGaze);
    document.querySelector('[data-select="done"]').click();
    advance(300);
    assert.notEqual(eye.getAttribute('d'), openEye);
    assert.equal(frames.size, 0);
    const settled = document.querySelector('#small-avatar').innerHTML;
    advance(1000);
    assert.equal(document.querySelector('#small-avatar').innerHTML, settled);
  } finally { await window.happyDOM.abort(); }
});

test('working and writing turn visibly in both directions and move their gaze', async () => {
  const { window } = await setup();
  try {
    for (const state of ['working', 'writing']) {
      const poses = Array.from({ length: 81 }, (_, i) => window.eval(`sampleFace('${state}', ${i * 100}).pose`));
      const angles = poses.map(pose => pose[0]);
      const gaze = poses.map(pose => pose[2]);
      assert.ok(Math.max(...angles) - Math.min(...angles) >= 16, `${state} needs a visible head turn`);
      assert.ok(Math.max(...gaze) - Math.min(...gaze) >= 2, `${state} needs a visible gaze shift`);
    }
  } finally { await window.happyDOM.abort(); }
});

test('expression morph preserves the SVG, has intermediate shapes, and retargets from the visible face', async () => {
  const { window, document, advance, frames } = await setup();
  try {
    const svg = document.querySelector('#small-avatar svg');
    const eye = svg.querySelector('.eye-left');
    assert.ok(eye, 'the preview needs a persistent eye path');
    const original = eye.getAttribute('d');
    document.querySelector('[data-select="done"]').click();
    assert.equal(document.querySelector('#small-avatar svg'), svg);
    assert.equal(eye.getAttribute('d'), original, 'no jump when switching');
    advance(140);
    const halfway = eye.getAttribute('d');
    assert.notEqual(halfway, original);
    document.querySelector('[data-select="stopped"]').click();
    assert.equal(eye.getAttribute('d'), halfway, 'rapid switch starts at current shape');
    advance(300);
    assert.equal(eye.getAttribute('d'), document.querySelector('[data-select="stopped"] .eye-left').getAttribute('d'));
    assert.equal(frames.size, 0, 'terminal expressions stop rendering after settling');
    assert.equal(document.querySelectorAll('.ring').length, 0);
  } finally { await window.happyDOM.abort(); }
});

test('pause freezes the in-flight morph and reduced motion updates without animated frames', async () => {
  const { window, document, advance } = await setup();
  try {
    const eye = document.querySelector('#small-avatar .eye-left');
    assert.ok(eye);
    document.querySelector('[data-select="done"]').click();
    advance(90);
    document.querySelector('#pause').click();
    const frozen = eye.getAttribute('d');
    advance(1000);
    assert.equal(eye.getAttribute('d'), frozen);
    document.querySelector('#pause').click();
    advance(90);
    assert.notEqual(eye.getAttribute('d'), frozen);
  } finally { await window.happyDOM.abort(); }
  const reduced = await setup({ reduced: true });
  try {
    reduced.document.querySelector('[data-select="done"]').click();
    assert.equal(reduced.frames.size, 0);
    assert.equal(reduced.document.querySelector('#small-avatar .eye-left').getAttribute('d'), reduced.document.querySelector('[data-select="done"] .eye-left').getAttribute('d'));
  } finally { await reduced.window.happyDOM.abort(); }
});

test('demo pauses for confirmation, resumes explicitly, ends at done; manual choice cancels playback', async () => {
  const { window, document, timers, tick } = await setup();
  const state = () => document.querySelector('#preview').dataset.state;
  try {
    document.querySelector('#demo').click();
    assert.equal(state(), 'connecting');
    tick(); assert.equal(state(), 'thinking');
    document.querySelector('#pause').click();
    tick(); assert.equal(state(), 'thinking');
    document.querySelector('#pause').click();
    tick(); assert.equal(state(), 'searching');
    tick(); assert.equal(state(), 'working');
    tick(); assert.equal(state(), 'waiting');
    assert.equal(timers.size, 0);
    assert.equal(document.querySelector('#continue').hidden, false);
    document.querySelector('#continue').click();
    assert.equal(state(), 'writing');
    tick(); assert.equal(state(), 'done');
    assert.equal(timers.size, 0);
    document.querySelector('#demo').click();
    document.querySelector('[data-select="failed"]').click();
    tick(); assert.equal(state(), 'failed');
    assert.equal(timers.size, 0);
  } finally { await window.happyDOM.abort(); }
});
