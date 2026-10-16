'use strict';
// Run the actual main-process orchestration against inert adapters, never Electron.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const file = path.resolve(__dirname, '../src/main.cjs');
const nativeRequire = createRequire(file);
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture({ configured = true } = {}) {
  const handlers = new Map(), shortcuts = new Map(), windows = [], sent = [], requests = [], dialogs = [];
  const native = { foreground: () => state.foreground, windowProcess: () => 999, mouseDown: () => false, escapeDown: () => false };
  const state = { foreground: 123, mouseDismisses: 0, mouseStarts: 0, mouseStops: 0, helperStops: 0, captures: 0, cancels: [], clipboardReads: 0, selectionReads: [], translated: null };
  const app = Object.assign(new EventEmitter(), { setName() {}, getPath: () => 'C:/inert-profile', requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(), quit: () => { state.quit = true; } });
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.bounds = { x: 0, y: 0, width: options.width, height: options.height }; this.visible = false; this.pinned = options.alwaysOnTop || false; windows.push(this);
      this.webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {}, send: (channel, data) => sent.push({ channel, data }) });
    }
    async loadFile(file) { this.url = pathToFileURL(file).href; }
    isDestroyed() { return false; } isVisible() { return this.visible; } isFocused() { return this.focused; } isMinimized() { return false; }
    getBounds() { return { ...this.bounds }; } getSize() { return [this.bounds.width, this.bounds.height]; }
    setBounds(bounds) { this.bounds = { ...bounds }; } setMinimumSize() {} setPosition(x, y) { this.bounds.x = x; this.bounds.y = y; }
    show() { this.visible = true; } showInactive() { this.visible = true; } hide() { this.visible = false; } focus() { this.focused = true; }
    setAlwaysOnTop(value) { this.pinned = value; } isAlwaysOnTop() { return this.pinned; }
  }
  const display = { workArea: { x: 0, y: 0, width: 1280, height: 720 } };
  const electron = { app, BrowserWindow: Window,
    Tray: class extends EventEmitter { setToolTip() {} setContextMenu(menu) { state.menu = menu; } destroy() {} },
    Menu: { buildFromTemplate: items => items },
    globalShortcut: { register: (key, fn) => { shortcuts.set(key, fn); return true; }, unregisterAll() {} },
    clipboard: { readText: async () => { state.clipboardReads++; return 'inert clipboard'; }, writeText: async () => {} }, ClipboardItem: class {},
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
    screen: { getDisplayNearestPoint: () => display, getDisplayMatching: () => display, getCursorScreenPoint: () => ({ x: 100, y: 100 }), dipToScreenPoint: point => point },
    safeStorage: {}, session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } }, dialog: { showErrorBox: (...args) => dialogs.push(args) },
  };
  class SettingsStore {
    publicSettings() { return { baseUrl: 'http://127.0.0.1/v1', model: configured ? 'vision-fixture' : '', hasApiKey: configured }; }
    privateSettings() { return { ...this.publicSettings(), apiKey: 'inert-key' }; }
    async load() {} async save() { return this.publicSettings(); }
  }
  class Preferences {
    constructor() { this.mouseSelectionEnabled = true; } async load() {} publicState() { return { mouseSelectionEnabled: this.mouseSelectionEnabled }; }
    async save(value) { this.mouseSelectionEnabled = value; return this.publicState(); }
  }
  const overrides = {
    electron, './settings.cjs': { SettingsStore }, './preferences.cjs': { Preferences },
    './windows-native.cjs': { createWindowsNative: () => native },
    './windows-helper.cjs': { WindowsHelper: class { stop() { state.helperStops++; } } },
    './selection.cjs': { createSelectionReader: () => ({ capture: async options => { state.selectionReads.push(options); return { text: 'hotkey fixture' }; } }) },
    './provider.cjs': { translate: async (_settings, request, options) => { requests.push(request); state.translated = options; return { text: 'inert translation' }; } },
    './mouse-selection.cjs': { createMouseSelectionMonitor: options => { state.mouse = options; return { start: () => { state.mouseStarts++; }, stop: () => { state.mouseStops++; }, dismiss: () => { state.mouseDismisses++; options.onDismiss(); } }; } },
    './screen-capture.cjs': { createScreenCapture: options => { state.captureOptions = options; const capture = { busy: false, start: async () => { state.captures++; capture.busy = true; options.beforeCapture(); }, cancel: restore => { state.cancels.push(restore); capture.busy = false; } }; state.capture = capture; return capture; } },
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    require: name => overrides[name] || nativeRequire(name), __dirname: path.dirname(file), process: { env: {}, pid: 100 },
    AbortController, console, setInterval: () => ({ unref() {} }), clearInterval() {},
  }, { filename: file });
  for (let i = 0; i < 8 && !state.menu && !dialogs.length; i++) await tick();
  assert.deepEqual(dialogs, []);
  assert.ok(state.menu, 'Main process finishes initialization');
  const mainWindow = windows.find(w => w.url.endsWith('/renderer/index.html'));
  const buttonWindow = windows.find(w => w.url.endsWith('/renderer/selection-button.html'));
  const event = window => ({ sender: window.webContents, senderFrame: { url: window.url } });
  const invoke = (name, ...args) => handlers.get(name)(event(mainWindow), ...args);
  return { app, handlers, shortcuts, windows, mainWindow, buttonWindow, sent, requests, state, event, invoke };
}
test('main process shows a nonactivating selection button and only translates after its trusted click', async () => {
  const f = await fixture();
  assert.equal(f.buttonWindow.options.focusable, false);
  assert.equal(f.buttonWindow.visible, false);
  const focused = f.mainWindow.focused;
  f.state.mouse.onSelection({ text: 'selected text', point: { x: 800, y: 600 }, hwnd: 123 });
  assert.equal(f.buttonWindow.visible, true);
  assert.equal(f.mainWindow.focused, focused);
  assert.equal(f.requests.length, 0);
  assert.equal(f.state.clipboardReads, 0);
  assert.equal((await f.handlers.get('mouse:translate')(f.event(f.mainWindow))).ok, false);
  assert.equal((await f.handlers.get('mouse:translate')(f.event(f.buttonWindow))).ok, true);
  assert.equal(f.buttonWindow.visible, false);
  assert.equal(f.mainWindow.bounds.width, 580);
  assert.ok(f.mainWindow.bounds.y + f.mainWindow.bounds.height <= 720);
  assert.equal(f.sent.filter(item => item.channel === 'selection:captured').at(-1).data.text, 'selected text');
});
test('mouse candidate is rejected after switching windows; hide cancels a pending candidate', async () => {
  const f = await fixture();
  f.state.mouse.onSelection({ text: 'stale', point: { x: 10, y: 10 }, hwnd: 123 });
  f.state.foreground = 456;
  assert.equal((await f.handlers.get('mouse:translate')(f.event(f.buttonWindow))).ok, false);
  assert.equal(f.sent.some(item => item.channel === 'selection:captured'), false);
  const prior = f.state.mouseDismisses;
  await f.invoke('window:hide');
  assert.equal(f.mainWindow.visible, false);
  assert.ok(f.state.mouseDismisses > prior);
});
test('model configuration is required before any screen capture', async () => {
  const f = await fixture({ configured: false });
  assert.equal((await f.invoke('capture:start')).ok, true);
  assert.equal(f.state.captures, 0);
  assert.ok(f.sent.some(item => item.channel === 'settings:required'));
});
test('capture entry hides windows and repeated requests leave the existing overlay untouched', async () => {
  const f = await fixture();
  await f.invoke('capture:start');
  assert.equal(f.state.captures, 1);
  assert.equal(f.mainWindow.visible, false);
  await f.invoke('capture:start');
  assert.equal(f.state.captures, 1);
  assert.equal(f.mainWindow.visible, false);
  const blocked = await f.invoke('translate:start', { id: 'test', text: 'no', target: 'auto', style: 'natural' });
  assert.equal(blocked.ok, false);
  assert.equal(f.requests.length, 0);
  f.state.capture.busy = false;
  await f.state.captureOptions.onCaptured({ image: 'inert-image', width: 20, height: 20 }, { x: 800, y: 600 });
  assert.equal(f.mainWindow.visible, true);
  assert.ok(f.sent.some(item => item.channel === 'image:captured'));
});
test('main IPC rejects foreign renderers and pin/preferences acknowledgements reflect actual state', async () => {
  const f = await fixture();
  assert.equal((await f.handlers.get('window:pin')(f.event(f.buttonWindow), true)).ok, false);
  assert.equal(f.mainWindow.pinned, false);
  assert.equal((await f.invoke('window:pin', true)).data, true);
  assert.equal((await f.invoke('window:pin', false)).data, false);
  assert.equal((await f.invoke('preferences:save', false)).data.mouseSelectionEnabled, false);
  assert.equal(f.state.mouseStops, 1);
  await f.invoke('window:expand');
  assert.equal(f.mainWindow.bounds.width, 980);
});


test('UIA-unavailable candidate copies only on trusted click and locks to the original window', async () => {
  const f = await fixture();
  f.state.mouse.onSelection({ point: { x: 200, y: 200 }, hwnd: 123, readResult: Promise.resolve({ text: null }), isCurrent: () => true });
  assert.equal(f.state.selectionReads.length, 0);
  assert.equal(f.requests.length, 0);
  const result = await f.handlers.get('mouse:translate')(f.event(f.buttonWindow));
  assert.equal(result.ok, true);
  assert.equal(f.state.selectionReads.length, 1);
  assert.equal(f.state.selectionReads[0].expectedWindow, 123);
  assert.ok(f.state.selectionReads[0].signal);
  assert.equal(f.mainWindow.bounds.width, 580);
  assert.equal(f.sent.find(item => item.channel === 'selection:captured').data.text, 'hotkey fixture');
});
test('cached accessible text avoids clipboard fallback even when a provisional candidate was shown', async () => {
  const f = await fixture();
  f.state.mouse.onSelection({ point: { x: 200, y: 200 }, hwnd: 123, readResult: Promise.resolve({ text: 'browser text' }), isCurrent: () => true });
  await f.handlers.get('mouse:translate')(f.event(f.buttonWindow));
  assert.equal(f.state.selectionReads.length, 0);
  assert.equal(f.sent.find(item => item.channel === 'selection:captured').data.text, 'browser text');
});
test('password and oversized candidates never fall back to copying', async () => {
  for (const blocked of ['password', 'too-long']) {
    const f = await fixture();
    f.state.mouse.onSelection({ point: { x: 200, y: 200 }, hwnd: 123, readResult: Promise.resolve({ blocked }), isCurrent: () => true });
    await f.handlers.get('mouse:translate')(f.event(f.buttonWindow));
    assert.equal(f.state.selectionReads.length, 0);
    assert.equal(f.sent.some(item => item.channel === 'selection:captured'), false);
  }
});
test('waiting mouse click cannot copy from a different foreground or a dismissed gesture', async () => {
  for (const action of ['switch', 'dismiss']) {
    const f = await fixture();
    let resolve;
    let current = true;
    f.state.mouse.onSelection({ point: { x: 200, y: 200 }, hwnd: 123, readResult: new Promise(done => { resolve = done; }), isCurrent: () => current });
    const clicked = f.handlers.get('mouse:translate')(f.event(f.buttonWindow));
    if (action === 'switch') f.state.foreground = 456; else current = false;
    resolve({ text: null }); await clicked;
    assert.equal(f.state.selectionReads.length, 0);
    assert.equal(f.sent.some(item => item.channel === 'selection:captured'), false);
  }
});
