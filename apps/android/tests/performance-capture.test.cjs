const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/atlas-performance.js'), 'utf8');

function sample(atlas = false) {
  let now = 100;
  let frame;
  const marker = {};
  const sky = atlas ? {
    isConnected: true,
    setAttribute() {}, removeAttribute() {}, addEventListener() {}, removeEventListener() {},
    querySelector(selector) {
      if (selector === '.atlas-star') return marker;
      if (selector === 'canvas[data-atlas-renderer]') return { dataset: { atlasRenderer: 'webgl2' } };
      return null;
    },
    querySelectorAll() { return [marker]; },
  } : null;
  const document = {
    hidden: false,
    scripts: [{ src: 'https://example.test/assets/index-build123.js' }],
    querySelector() { return sky; },
    getElementsByTagName() { return { length: 42 }; },
    addEventListener() {}, removeEventListener() {},
  };
  const window = {};
  const context = {
    document, window,
    location: { pathname: '/chat', search: '?session=private' },
    innerWidth: 390, innerHeight: 844, devicePixelRatio: 3,
    performance: {
      now: () => now,
      getEntriesByType: () => [{ startTime: 120, duration: 80 }],
    },
    MutationObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: callback => { frame = callback; return 1; },
    cancelAnimationFrame() {}, setTimeout: () => 1, clearTimeout() {},
  };
  assert.equal(vm.runInNewContext(script, context), true);
  now = 116;
  frame(now);
  now = 15100;
  return window.__workstepAtlasSample(true);
}

test('collects useful metrics on a regular page without a memory atlas', () => {
  const report = sample();
  assert.equal(report.path, '/chat');
  assert.equal(report.atlas, null);
  assert.equal(report.nodes, 42);
  assert.equal(report.idle[0], 1);
  assert.equal(report.resources[0], 1);
  assert.equal(report.longTasks, -1);
  assert.equal(JSON.stringify(report).includes('private'), false);
});

test('adds atlas details when the atlas is open', () => {
  const report = sample(true);
  assert.equal(report.atlas.stars, 1);
  assert.equal(report.atlas.renderer, 'webgl2');
});
