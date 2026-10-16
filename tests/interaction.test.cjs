'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { nearPoint, cropRectangle } = require('../src/geometry.cjs');
const { createGestureTracker, createMouseSelectionMonitor } = require('../src/mouse-selection.cjs');
const { Preferences } = require('../src/preferences.cjs');
const flush = () => new Promise(resolve => setImmediate(resolve));

test('nearby popup stays inside negative-coordinate and small monitor work areas', () => {
  for (const area of [{ x: -1920, y: -100, width: 1920, height: 1080 }, { x: 0, y: 0, width: 320, height: 200 }]) {
    for (const point of [{ x: area.x, y: area.y }, { x: area.x + area.width, y: area.y + area.height }]) {
      const result = nearPoint(point, { width: 580, height: 550 }, area);
      assert.ok(result.x >= area.x && result.y >= area.y);
      assert.ok(result.x + result.width <= area.x + area.width);
      assert.ok(result.y + result.height <= area.y + area.height);
    }
  }
});
test('crop uses actual image-to-DIP ratio for mixed-DPI displays', () => {
  assert.deepEqual(cropRectangle({ x: 10, y: 20, width: 100, height: 50 }, { width: 1280, height: 720 }, { width: 1920, height: 1080 }), { x: 15, y: 30, width: 150, height: 75 });
  assert.deepEqual(cropRectangle({ x: 0, y: 0, width: 1280, height: 720 }, { width: 1280, height: 720 }, { width: 1920, height: 1080 }), { x: 0, y: 0, width: 1920, height: 1080 });
});
test('crop rejects non-finite, tiny, negative and out-of-screen input', () => {
  for (const rect of [null, {}, { x: NaN, y: 0, width: 20, height: 20 }, { x: -1, y: 0, width: 20, height: 20 }, { x: 0, y: 0, width: 7, height: 20 }, { x: 90, y: 0, width: 20, height: 20 }]) {
    assert.throws(() => cropRectangle(rect, { width: 100, height: 100 }, { width: 200, height: 200 }));
  }
});
test('gesture tracker reads only after drag release or a nearby double click', () => {
  const track = createGestureTracker();
  const sample = (down, x, time, hwnd = 1) => track({ down, point: { x, y: 0 }, hwnd, time });
  assert.equal(sample(true, 0, 0), null);
  assert.equal(sample(false, 0, 30), null);
  assert.equal(sample(true, 0, 100), null);
  assert.ok(sample(false, 0, 130));
  assert.equal(sample(true, 0, 1000), null);
  assert.equal(sample(true, 20, 1100), null);
  assert.ok(sample(false, 20, 1200));
  assert.equal(sample(true, 0, 2000), null);
  assert.equal(sample(false, 20, 2100, 2), null);
});
function fixture(overrides = {}) {
  const state = { down: false, textCursor: false, escape: false, hwnd: 5, pid: 10, point: { x: 10, y: 10 }, blocked: false, ownPoint: false, reads: [], selections: [], errors: [], dismisses: 0 };
  const monitor = createMouseSelectionMonitor({
    native: { textCursor: () => state.textCursor, mouseDown: () => state.down, escapeDown: () => state.escape, foreground: () => state.hwnd, windowProcess: () => state.pid },
    getPoint: () => state.point, toPhysical: point => ({ x: point.x * 2, y: point.y * 2 }), processId: 20,
    readSelection: async input => { state.reads.push(input); return { text: 'selected' }; }, cancelRead: () => {},
    isBlocked: () => state.blocked, isOwnPoint: () => state.ownPoint,
    onSelection: item => state.selections.push(item), onDismiss: () => state.dismisses++, onError: error => state.errors.push(error),
    ...overrides,
  });
  function drag() { state.down = true; monitor.tick(); state.point = { x: state.point.x + 20, y: 10 }; state.down = false; monitor.tick(); }
  return { state, monitor, drag };
}
test('monitor captures physical-coordinate accessibility text without translating or using clipboard', async () => {
  const { state, drag, monitor } = fixture();
  drag(); await flush();
  assert.deepEqual(state.reads[0], { hwnd: 5, x: 60, y: 20, ownProcess: 20 });
  assert.equal(state.selections[0].text, 'selected');
  monitor.stop();
});
test('monitor ignores own windows, popup clicks and work in progress', async () => {
  for (const property of ['pid', 'blocked', 'ownPoint']) {
    const { state, drag, monitor } = fixture();
    state[property] = property === 'pid' ? 20 : true;
    drag(); await flush();
    assert.equal(state.reads.length, 0);
    monitor.stop();
  }
});
test('stale selection results never reappear after dismissal, focus changes or disabling', async () => {
  for (const action of ['dismiss', 'stop', 'focus']) {
    let resolve;
    const { state, drag, monitor } = fixture({ readSelection: () => new Promise(done => { resolve = done; }) });
    drag(); await flush();
    if (action === 'focus') state.hwnd = 6; else monitor[action]();
    resolve({ text: 'stale' }); await flush();
    assert.equal(state.selections.length, 0);
    monitor.stop();
  }
});
test('empty, oversized and malformed accessibility results are not offered', async () => {
  for (const result of [{ text: '' }, { text: ' ' }, { text: 'x'.repeat(24001) }, { text: 7 }, null]) {
    const { state, drag, monitor } = fixture({ readSelection: async () => result });
    drag(); await flush();
    assert.equal(state.selections.length, 0);
    monitor.stop();
  }
});
test('helper errors are handled, and Escape dismisses a pending candidate', async () => {
  const { state, drag, monitor } = fixture({ readSelection: async () => { throw new Error('unsupported'); } });
  drag(); await flush();
  assert.equal(state.errors[0].message, 'unsupported');
  const before = state.dismisses;
  state.escape = true; monitor.tick();
  assert.ok(state.dismisses > before);
  monitor.stop();
});
test('mouse preference persists independently from credentials and rejects invalid input', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'huanyi-preferences-'));
  const resolved = path.resolve(directory);
  assert.ok(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}huanyi-preferences-`));
  t.after(() => fs.rm(resolved, { recursive: true, force: true }));
  const file = path.join(directory, 'preferences.json');
  const store = new Preferences(file);
  assert.equal((await store.load()).mouseSelectionEnabled, true);
  await store.save(false);
  assert.equal((await new Preferences(file).load()).mouseSelectionEnabled, false);
  await assert.rejects(store.save('true'), /参数/);
  await fs.writeFile(file, '{broken');
  assert.equal((await new Preferences(file).load()).mouseSelectionEnabled, false, 'corrupt preference must fail closed');
});


test('browser text gesture offers a button before accessibility has finished, without copying', async () => {
  let resolve;
  let readCount = 0;
  const { state, drag, monitor } = fixture({ readSelection: () => { readCount++; return new Promise(done => { resolve = done; }); } });
  state.textCursor = true;
  drag();
  assert.equal(state.selections.length, 1, 'Button is immediate, not gated on TextPattern');
  assert.equal(readCount, 0, 'No synchronous accessibility startup blocks the affordance');
  const candidate = state.selections[0];
  assert.equal(candidate.text, undefined);
  assert.equal(candidate.isCurrent(), true);
  await flush();
  resolve({ text: null });
  assert.deepEqual(await candidate.readResult, { text: null });
  await flush();
  assert.equal(state.selections.length, 1, 'Unsupported UIA retains the click-to-copy candidate');
  monitor.stop();
  assert.equal(candidate.isCurrent(), false);
});
test('text gesture survives helper failure so its explicit click can use copy fallback', async () => {
  const { state, drag, monitor } = fixture({ readSelection: async () => { throw new Error('UIA unavailable'); } });
  state.textCursor = true; drag(); await flush();
  assert.equal(state.selections.length, 1);
  assert.equal(await state.selections[0].readResult, null);
  assert.equal(state.errors.length, 1);
  monitor.stop();
});
test('password or oversized accessibility results withdraw a provisional button', async () => {
  for (const result of [{ blocked: 'password' }, { blocked: 'too-long' }, { text: 'x'.repeat(24001) }]) {
    const { state, drag, monitor } = fixture({ readSelection: async () => result });
    state.textCursor = true; drag();
    const candidate = state.selections[0];
    const dismisses = state.dismisses;
    await flush();
    assert.ok(state.dismisses > dismisses);
    assert.equal(candidate.isCurrent(), false);
    monitor.stop();
  }
});
test('button remains tied to its gesture and cannot be revived after a new click', async () => {
  let resolve;
  const { state, drag, monitor } = fixture({ readSelection: () => new Promise(done => { resolve = done; }) });
  state.textCursor = true; drag(); await flush();
  const candidate = state.selections[0];
  monitor.dismiss(); resolve({ text: 'old selection' }); await flush();
  assert.equal(candidate.isCurrent(), false);
  assert.equal(state.selections.length, 1, 'No second show from late completion');
  monitor.stop();
});
test('text cursor at press is retained even if release is over a nontext margin', () => {
  const track = createGestureTracker(700);
  track({ down: true, point: { x: 10, y: 10 }, time: 0, hwnd: 1, textCursor: true });
  const result = track({ down: false, point: { x: 40, y: 10 }, time: 120, hwnd: 1, textCursor: false });
  assert.equal(result.textCursor, true);
});
