'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const source = path.resolve(__dirname, '../src/screen-capture.cjs');
const nativeRequire = createRequire(source);
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const calls = { captures: [], cancels: [], errors: [], cropped: [], sourceRequests: [], windows: [], focused: [] };
  const handlers = new Map();
  const display = { id: 3, bounds: { x: -1280, y: 0, width: 1280, height: 720 }, size: { width: 1280, height: 720 }, scaleFactor: 1.5 };
  const screen = Object.assign(new EventEmitter(), { getDisplayNearestPoint: () => display, getCursorScreenPoint: () => ({ x: -100, y: 100 }), getAllDisplays: () => [display] });
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false; this.bounds = options;
      this.webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: () => {} });
      calls.windows.push(this);
    }
    async loadFile(file) { this.url = require('node:url').pathToFileURL(file).href; }
    setBounds(bounds) { this.bounds = bounds; }
    setAlwaysOnTop() {}
    show() { this.visible = true; }
    focus() { calls.focused.push(this); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWOQAAAAASUVORK5CYII=', 'base64');
  function image(width = 1920, height = 1080) {
    return { getSize: () => ({ width, height }), isEmpty: () => false, toDataURL: () => 'data:image/png;base64,FULL_SCREEN_LOCAL_ONLY', toPNG: () => png,
      crop: rect => { calls.cropped.push(rect); return image(rect.width, rect.height); },
      resize: size => image(size.width, size.height) };
  }
  const capturer = { getSources: async options => { calls.sourceRequests.push(options); return [{ display_id: '3', thumbnail: image() }]; } };
  const electron = { BrowserWindow: Window, desktopCapturer: capturer, screen, ipcMain: { handle: (name, fn) => handlers.set(name, fn) } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(source, 'utf8'), { module, exports: module.exports, require: name => name === 'electron' ? electron : nativeRequire(name), __dirname: path.dirname(source), Buffer, setTimeout: callback => setImmediate(callback) }, { filename: source });
  const controller = module.exports.createScreenCapture({
    beforeCapture: () => true,
    getModel: () => 'vision-fixture',
    onCaptured: async (data, point) => calls.captures.push({ data, point }),
    onCancel: visible => calls.cancels.push(visible), onError: error => calls.errors.push(error),
  });
  const event = () => { const window = calls.windows.at(-1); return { sender: window.webContents, senderFrame: { url: window.url } }; };
  return { calls, handlers, controller, event, screen, capturer, display };
}
test('capture only returns cropped pixels, with mixed-DPI coordinate mapping and preview identity', async () => {
  const { calls, handlers, controller, event } = fixture();
  await controller.start();
  assert.equal(controller.busy, true);
  const preview = handlers.get('capture:image')(event());
  assert.equal(preview.model, 'vision-fixture');
  const result = await handlers.get('capture:finish')(event(), { x: 100, y: 80, width: 200, height: 100 });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.cropped[0], { x: 150, y: 120, width: 300, height: 150 });
  assert.equal(calls.captures.length, 1);
  assert.equal(calls.captures[0].data.width, 300);
  assert.equal(calls.captures[0].data.image.includes('FULL_SCREEN'), false);
  assert.equal(calls.captures[0].point.x, -980);
  assert.equal(calls.captures[0].point.y, 180);
  assert.equal(calls.windows[0].destroyed, true);
  assert.equal(controller.busy, false);
  assert.equal(calls.cancels.length, 0, 'Successful capture is not a cancellation');
});
test('capture IPC rejects foreign windows and subframes; tiny drags remain retryable', async () => {
  const { calls, handlers, controller, event } = fixture();
  await controller.start();
  for (const invalid of [{ sender: {}, senderFrame: event().senderFrame }, { ...event(), senderFrame: { url: 'file:///untrusted.html' } }]) {
    assert.equal(handlers.get('capture:image')(invalid), null);
    assert.equal((await handlers.get('capture:finish')(invalid, { x: 0, y: 0, width: 100, height: 100 })).ok, false);
    handlers.get('capture:cancel')(invalid);
    assert.equal(controller.busy, true);
  }
  assert.equal((await handlers.get('capture:finish')(event(), { x: 1, y: 1, width: 3, height: 3 })).ok, false);
  assert.equal(controller.busy, true);
  assert.equal(calls.captures.length, 0);
  handlers.get('capture:cancel')(event());
  assert.equal(controller.busy, false);
  assert.deepEqual(calls.cancels, [true]);
});
test('escape-equivalent cancellation during screenshot retrieval never opens a late overlay', async () => {
  const { calls, controller, capturer } = fixture();
  let resolve;
  capturer.getSources = () => new Promise(done => { resolve = done; });
  const running = controller.start(); await tick();
  controller.cancel();
  resolve([]); await running;
  assert.equal(calls.windows.length, 0);
  assert.equal(calls.captures.length, 0);
  assert.equal(controller.busy, false);
});
test('concurrent capture is rejected without cancelling the existing overlay', async () => {
  const { calls, controller } = fixture();
  await controller.start();
  await assert.rejects(controller.start(), /正在截图/);
  assert.equal(calls.windows.length, 1);
  assert.equal(controller.busy, true);
  controller.cancel(false);
  assert.equal(calls.cancels.length, 0);
});
test('display changes and loss of focus cancel safely without uploads', async () => {
  for (const kind of ['display', 'blur', 'close']) {
    const { calls, screen, controller } = fixture();
    await controller.start();
    if (kind === 'display') screen.emit('display-metrics-changed');
    else if (kind === 'blur') calls.windows[0].emit('blur');
    else calls.windows[0].destroy();
    assert.equal(controller.busy, false);
    assert.equal(calls.captures.length, 0);
  }
});
test('missing monitor image fails explicitly instead of uploading another screen', async () => {
  const { calls, capturer, controller } = fixture();
  capturer.getSources = async () => [{ display_id: 'wrong-monitor' }];
  await assert.rejects(controller.start(), /无法截取/);
  assert.equal(controller.busy, false);
  assert.equal(calls.windows.length, 0);
  assert.equal(calls.captures.length, 0);
  assert.deepEqual(calls.cancels, [true]);
});
