'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSelectionReader } = require('../src/selection.cjs');

class Item {
  constructor(values) { this.values = values; this.types = Object.keys(values); }
  async getType(type) { return this.values[type]; }
}

function fixture(options = {}) {
  let sequence = 10;
  let owner = 123;
  let foreground = 900;
  let clock = 0;
  let held = false;
  let values = { 'text/plain': 'old clipboard', 'text/html': '<b>old clipboard</b>' };
  const writes = [];
  const native = {
    foreground: () => foreground,
    windowProcess: () => 123,
    sequence: () => sequence,
    clipboardOwnerProcess: () => owner,
    shortcutHeld: () => held,
    copy: () => change({ 'text/plain': options.selection ?? 'selected text' }, 123),
  };
  function change(next, pid = 456) { values = next; sequence++; owner = pid; }
  const clipboard = {
    read: async () => [new Item(values)],
    readText: async () => values['text/plain'] || '',
    writeText: async value => { writes.push(value); change({ 'text/plain': value }); },
    write: async items => { writes.push('restore'); change(items[0]?.values || {}); },
  };
  const reader = createSelectionReader({
    native, clipboard, ClipboardItem: Item, processId: 456, makeMarker: () => 'unique marker',
    now: () => clock, sleep: async ms => { clock += ms; await options.onSleep?.(ms); },
    releaseTimeoutMs: 100, copyTimeoutMs: 100,
  });
  return { reader, native, clipboard, writes, change, values: () => values,
    focus: value => { foreground = value; }, hold: value => { held = value; } };
}

test('captures selection and restores every original clipboard format', async () => {
  const f = fixture({ selection: '选中文字\n第二行' });
  assert.deepEqual(await f.reader.capture(), { text: '选中文字\n第二行', warning: '' });
  assert.deepEqual(f.values(), { 'text/plain': 'old clipboard', 'text/html': '<b>old clipboard</b>' });
  assert.deepEqual(f.writes, ['unique marker', 'restore']);
});

test('selection equal to old clipboard remains distinguishable from a failed copy', async () => {
  const f = fixture({ selection: 'old clipboard' });
  assert.equal((await f.reader.capture()).text, 'old clipboard');
});

test('unsupported copy never returns stale clipboard and restores the marker', async () => {
  const f = fixture();
  f.native.copy = () => {};
  await assert.rejects(f.reader.capture(), /未获取到/);
  assert.equal(f.values()['text/plain'], 'old clipboard');
});

test('nontext and oversized selections are not translated', async () => {
  for (const selection of ['  ', 'a'.repeat(24001)]) {
    const f = fixture({ selection });
    await assert.rejects(f.reader.capture(), /不包含|24,000/);
    assert.equal(f.values()['text/plain'], 'old clipboard');
  }
});

test('failed input injection restores the clipboard and releases capture lock', async () => {
  const f = fixture();
  const copy = f.native.copy;
  f.native.copy = () => { throw new Error('input rejected'); };
  await assert.rejects(f.reader.capture(), /input rejected/);
  assert.equal(f.values()['text/plain'], 'old clipboard');
  f.native.copy = copy;
  assert.equal((await f.reader.capture()).text, 'selected text');
});

test('waits for hotkey release before copying', async () => {
  let f;
  let sleeps = 0;
  f = fixture({ onSleep: () => { sleeps++; f.hold(false); } });
  f.hold(true);
  const copy = f.native.copy;
  f.native.copy = () => { assert.ok(sleeps > 0); copy(); };
  assert.equal((await f.reader.capture()).text, 'selected text');
});

test('held keys and changed focus abort without touching the clipboard', async () => {
  const held = fixture();
  held.hold(true);
  await assert.rejects(held.reader.capture(), /松开/);
  assert.deepEqual(held.writes, []);
  let switched;
  switched = fixture({ onSleep: () => switched.focus(901) });
  switched.hold(true);
  await assert.rejects(switched.reader.capture(), /窗口已切换/);
  assert.deepEqual(switched.writes, []);
});

test('clipboard from another process is neither translated nor overwritten', async () => {
  const f = fixture();
  f.native.copy = () => f.change({ 'text/plain': 'unrelated clipboard' }, 789);
  await assert.rejects(f.reader.capture(), /其他软件修改/);
  assert.equal(f.values()['text/plain'], 'unrelated clipboard');
  assert.deepEqual(f.writes, ['unique marker']);
});

test('new clipboard writes during text read are not restored over or translated', async () => {
  const f = fixture();
  f.clipboard.readText = async () => { f.change({ 'text/plain': 'new user copy' }); return 'selected text'; };
  await assert.rejects(f.reader.capture(), /再次变化/);
  assert.equal(f.values()['text/plain'], 'new user copy');
  assert.deepEqual(f.writes, ['unique marker']);
});

test('snapshot failure leaves original clipboard untouched', async () => {
  const f = fixture();
  f.clipboard.read = async () => [{ types: ['custom'], getType: async () => { throw new Error('unsupported format'); } }];
  await assert.rejects(f.reader.capture(), /unsupported format/);
  assert.deepEqual(f.writes, []);
});

test('own app selection is rejected before injecting any keys', async () => {
  const f = fixture();
  f.native.windowProcess = () => 456;
  await assert.rejects(f.reader.capture(), /其他软件/);
  assert.deepEqual(f.writes, []);
});

test('cancellation restores temporary clipboard and allows the next capture', async () => {
  const controller = new AbortController();
  const f = fixture({ onSleep: () => controller.abort() });
  f.native.copy = () => {};
  await assert.rejects(f.reader.capture({ signal: controller.signal }), /已取消/);
  assert.equal(f.values()['text/plain'], 'old clipboard');
});

test('clipboard restore failure is visible but valid captured text remains usable', async () => {
  const f = fixture();
  f.clipboard.write = async () => { throw new Error('locked'); };
  const captured = await f.reader.capture();
  assert.equal(captured.text, 'selected text');
  assert.match(captured.warning, /未能恢复/);
});

test('concurrent capture does not inject keys a second time', async () => {
  const f = fixture();
  const first = f.reader.capture();
  await assert.rejects(f.reader.capture(), /正在获取/);
  await first;
});


test('an empty original clipboard is restored to empty, not to the marker', async () => {
  const f = fixture();
  f.clipboard.read = async () => [];
  assert.equal((await f.reader.capture()).text, 'selected text');
  assert.deepEqual(f.values(), {});
});

test('native foreground errors do not leave capture permanently busy', async () => {
  const f = fixture();
  const foreground = f.native.foreground;
  f.native.foreground = () => { throw new Error('native foreground failed'); };
  await assert.rejects(f.reader.capture(), /native foreground failed/);
  f.native.foreground = foreground;
  assert.equal((await f.reader.capture()).text, 'selected text');
});


test('mouse fallback refuses a different foreground before snapshot or input injection', async () => {
  const f = fixture();
  let copied = false;
  f.native.copy = () => { copied = true; };
  await assert.rejects(f.reader.capture({ expectedWindow: 901 }), /窗口已切换/);
  assert.equal(copied, false);
  assert.deepEqual(f.writes, []);
});
test('mouse fallback can copy the expected window and restores the original clipboard', async () => {
  const f = fixture();
  assert.equal((await f.reader.capture({ expectedWindow: 900 })).text, 'selected text');
  assert.deepEqual(f.writes, ['unique marker', 'restore']);
});
