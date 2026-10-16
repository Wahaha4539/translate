'use strict';

const { app, BrowserWindow, Tray, Menu, globalShortcut, clipboard, ClipboardItem, ipcMain, nativeImage, screen, safeStorage, session, dialog } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { SettingsStore } = require('./settings.cjs');
const { validateRequest, MAX_SOURCE_LENGTH } = require('./contracts.cjs');
const { translate } = require('./provider.cjs');
const { createSelectionReader } = require('./selection.cjs');
const { createWindowsNative } = require('./windows-native.cjs');
const { WindowsHelper } = require('./windows-helper.cjs');
const { createMouseSelectionMonitor } = require('./mouse-selection.cjs');
const { Preferences } = require('./preferences.cjs');
const { nearPoint } = require('./geometry.cjs');
const { createScreenCapture } = require('./screen-capture.cjs');

const SHORTCUT = process.env.HUANYI_TEST_USER_DATA && process.env.HUANYI_TEST_WINDOW_SHORTCUT || 'CommandOrControl+Alt+T';
const SELECTION_SHORTCUT = process.env.HUANYI_TEST_USER_DATA && process.env.HUANYI_TEST_SELECTION_SHORTCUT || 'CommandOrControl+Alt+D';
const CAPTURE_SHORTCUT = process.env.HUANYI_TEST_USER_DATA && process.env.HUANYI_TEST_CAPTURE_SHORTCUT || 'CommandOrControl+Alt+S';
app.setName('Huanyi');
if (process.env.HUANYI_TEST_USER_DATA) app.setPath('userData', process.env.HUANYI_TEST_USER_DATA);
let window;
let tray;
let store;
let quitting = false;
let activeRequest = null;
let settingsQueue = Promise.resolve();
let shortcutRegistered = false;
let selectionShortcutRegistered = false;
let selectionReader;
let selectionCapture = null;
let selectionTask = null;
let captureShortcutRegistered = false;
let native;
let preferences;
let mouseMonitor;
let buttonWindow;
let candidate = null;
let candidateTimer;
let mouseWarning = '';
let screenCapture;
let compact = false;
let fullBounds;
const selectionHelper = new WindowsHelper();
const rendererUrl = pathToFileURL(path.join(__dirname, 'renderer/index.html')).href;

function stopTranslation() {
  activeRequest?.controller.abort();
}

function hideWindow() {
  mouseMonitor?.dismiss();
  screenCapture?.cancel(false);
  send('capture:busy', false);
  selectionCapture?.abort();
  stopTranslation();
  window?.hide();
}

function send(channel, data) {
  if (window && !window.isDestroyed()) window.webContents.send(channel, data);
}

async function showWindow(useClipboard = false, point = null) {
  if (!window || window.isDestroyed()) return;
  setCompact(Boolean(point), point);
  if (!point && !window.isVisible()) {
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const [width, height] = window.getSize();
    window.setPosition(
      Math.round(workArea.x + Math.max(0, (workArea.width - width) / 2)),
      Math.round(workArea.y + Math.max(0, (workArea.height - height) / 2)),
    );
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  if (useClipboard && !activeRequest) {
    try {
      const text = await clipboard.readText();
      if (text.trim()) send('clipboard:captured', text);
    } catch {
      send('app:notice', '剪贴板暂时无法读取，你可以直接粘贴原文。');
    }
  }
}

async function translateSelection(selected = null) {
  if (selectionCapture) return;
  if (activeRequest) {
    send('app:notice', '正在翻译，请先等待完成或停止当前请求。');
    return;
  }
  if (screenCapture?.busy) return;
  if (!selected) mouseMonitor?.dismiss();
  const controller = new AbortController();
  selectionCapture = controller;
  try {
    let captured;
    if (selected) {
      const accessible = selected.readResult ? await selected.readResult : { text: selected.text };
      if (controller.signal.aborted || quitting || selected.isCurrent?.() === false) return;
      if (native.foreground() !== selected.hwnd) throw new Error('选区所在窗口已切换，请重新划词。');
      if (accessible?.blocked) throw new Error(accessible.blocked === 'password' ? '密码控件不支持划词翻译。' : '选中文字超过 24,000 字符，请分段翻译。');
      if (typeof accessible?.text === 'string' && accessible.text.length > MAX_SOURCE_LENGTH) throw new Error('选中文字超过 24,000 字符，请分段翻译。');
      captured = typeof accessible?.text === 'string' && accessible.text.trim()
        ? { text: accessible.text }
        : await selectionReader.capture({ signal: controller.signal, expectedWindow: selected.hwnd });
    } else {
      captured = await selectionReader.capture({ signal: controller.signal });
    }
    if (controller.signal.aborted || quitting) return;
    selectionCapture = null;
    // Focus the translator only after the source application has copied its selection.
    if (selected) mouseMonitor?.dismiss();
    await showWindow(false, selected?.point);
    send('selection:captured', captured);
  } catch (error) {
    if (!controller.signal.aborted && !quitting && selected?.isCurrent?.() !== false) {
      await showWindow(false, selected?.point);
      send('app:notice', error.message || '未获取到选中文字，请手动复制后翻译。');
    }
  } finally {
    if (selected) mouseMonitor?.dismiss();
    if (selectionCapture === controller) selectionCapture = null;
  }
}

function setCompact(value, point) {
  if (!window || window.isDestroyed()) return;
  if (value) {
    if (!compact) fullBounds = window.getBounds();
    const area = screen.getDisplayNearestPoint(point).workArea;
    window.setMinimumSize(Math.min(440, area.width), Math.min(460, area.height));
    window.setBounds(nearPoint(point, { width: 580, height: 550 }, area));
  } else if (compact) {
    const area = screen.getDisplayMatching(fullBounds).workArea;
    window.setMinimumSize(Math.min(740, area.width), Math.min(560, area.height));
    window.setBounds({
      x: Math.max(area.x, Math.min(fullBounds.x, area.x + area.width - Math.min(fullBounds.width, area.width))),
      y: Math.max(area.y, Math.min(fullBounds.y, area.y + area.height - Math.min(fullBounds.height, area.height))),
      width: Math.min(fullBounds.width, area.width), height: Math.min(fullBounds.height, area.height),
    });
  }
  compact = value;
  send('window:compact', compact);
}

function dismissMouseButton() {
  candidate = null;
  buttonWindow?.hide();
}

function isButtonPoint(point) {
  if (!buttonWindow?.isVisible()) return false;
  const bounds = buttonWindow.getBounds();
  return point.x >= bounds.x && point.x <= bounds.x + bounds.width && point.y >= bounds.y && point.y <= bounds.y + bounds.height;
}

async function createMouseButton() {
  const file = path.join(__dirname, 'renderer/selection-button.html');
  const url = pathToFileURL(file).href;
  buttonWindow = new BrowserWindow({
    width: 94, height: 38, frame: false, transparent: true, show: false, focusable: false,
    resizable: false, movable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'button-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
  });
  buttonWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  buttonWindow.webContents.on('will-navigate', event => event.preventDefault());
  const trusted = event => event.sender === buttonWindow.webContents && event.senderFrame?.url === url;
  ipcMain.handle('mouse:dismiss', event => { if (trusted(event)) dismissMouseButton(); });
  ipcMain.handle('mouse:translate', async event => {
    if (!trusted(event) || !candidate || activeRequest || selectionCapture || screenCapture?.busy) return { ok: false };
    const selected = candidate;
    const valid = native.foreground() === selected.hwnd && Date.now() < selected.expires;
    if (!valid) { mouseMonitor.dismiss(); return { ok: false }; }
    // Do not cancel the accessibility promise on this click. Await its password/
    // length checks first, then use copy-and-restore only when no text is available.
    dismissMouseButton();
    if (selectionTask) return { ok: false };
    selectionTask = translateSelection(selected).finally(() => { selectionTask = null; });
    await selectionTask;
    return { ok: true };
  });
  await buttonWindow.loadFile(file);
  mouseMonitor = createMouseSelectionMonitor({
    native, getPoint: () => screen.getCursorScreenPoint(), toPhysical: point => screen.dipToScreenPoint(point),
    readSelection: input => selectionHelper.run(input),
    cancelRead: () => { if (selectionHelper.pending) selectionHelper.stop(); },
    isBlocked: () => Boolean(activeRequest || selectionCapture || screenCapture?.busy || quitting),
    isOwnPoint: isButtonPoint,
    onDismiss: dismissMouseButton,
    onSelection: selected => {
      candidate = { ...selected, expires: Date.now() + 12000 };
      const area = screen.getDisplayNearestPoint(selected.point).workArea;
      buttonWindow.setBounds(nearPoint(selected.point, { width: 94, height: 38 }, area));
      buttonWindow.showInactive();
    },
    onError: error => { mouseWarning = error.message; send('app:notice', `鼠标划词暂不可用：${error.message}`); },
  });
  if (preferences.mouseSelectionEnabled) mouseMonitor.start();
  candidateTimer = setInterval(() => {
    if (candidate && (Date.now() >= candidate.expires || native.foreground() !== candidate.hwnd)) dismissMouseButton();
  }, 150);
  candidateTimer.unref();
}

async function setMouseEnabled(enabled) {
  const result = await preferences.save(enabled);
  if (enabled) { mouseWarning = ''; mouseMonitor.start(); }
  else { mouseMonitor.stop(); selectionHelper.stop(); }
  updateTrayMenu();
  send('preferences:changed', result);
  return result;
}

async function startCapture() {
  if (screenCapture?.busy) return;
  if (!store.publicSettings().hasApiKey || !store.publicSettings().model) { await showWindow(false); send('settings:required'); return; }
  if (activeRequest || selectionCapture) throw new Error('请先停止当前翻译或取词，再截图。');
  try { await screenCapture.start(); } catch (error) { await showWindow(false); send('app:notice', error.message); throw error; }
}

function isTrusted(event) {
  return window && event.sender === window.webContents && event.senderFrame?.url === rendererUrl;
}

function handle(channel, callback) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isTrusted(event)) return { ok: false, error: '拒绝未经授权的请求。' };
    try {
      return { ok: true, data: await callback(...args) };
    } catch (error) {
      return { ok: false, error: error.message || '操作失败，请重试。' };
    }
  });
}

function setupIPC() {
  handle('settings:read', () => ({ ...store.publicSettings(), ...preferences.publicState(), shortcutRegistered, selectionShortcutRegistered, captureShortcutRegistered, mouseWarning }));
  handle('preferences:save', enabled => {
    const task = settingsQueue.then(() => setMouseEnabled(enabled));
    settingsQueue = task.catch(() => {});
    return task;
  });
  handle('capture:start', startCapture);
  handle('window:expand', () => setCompact(false));
  handle('settings:save', input => {
    if (activeRequest || selectionCapture || screenCapture?.busy) throw new Error('请先停止当前翻译、取词或截图，再修改模型设置。');
    const task = settingsQueue.then(() => store.save(input));
    settingsQueue = task.catch(() => {});
    return task;
  });
  handle('clipboard:read', () => {
    if (selectionCapture) throw new Error('正在获取选中文字，请稍候。');
    return clipboard.readText();
  });
  handle('clipboard:write', async text => {
    if (selectionCapture) throw new Error('正在获取选中文字，请稍候。');
    if (typeof text !== 'string' || text.length > 100000) throw new Error('无法复制这段文字。');
    await clipboard.writeText(text);
  });
  handle('window:hide', hideWindow);
  handle('window:pin', value => {
    window.setAlwaysOnTop(value === true);
    return window.isAlwaysOnTop();
  });
  handle('translate:stop', stopTranslation);
  handle('translate:start', async input => {
    if (screenCapture?.busy) throw new Error('正在截图，请稍候。');
    mouseMonitor?.dismiss();
    if (selectionCapture) throw new Error('正在获取选中文字，请稍候。');
    if (activeRequest) throw new Error('上一条翻译尚未结束。');
    if (typeof input?.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(input.id)) throw new Error('请求编号不正确。');
    const request = validateRequest(input);
    const operation = { id: input.id, controller: new AbortController() };
    activeRequest = operation;
    try {
      return await translate(store.privateSettings(), request, {
        signal: operation.controller.signal,
        onDelta: text => send('translate:delta', { id: operation.id, text }),
      });
    } finally {
      if (activeRequest === operation) activeRequest = null;
    }
  });
}

async function createWindow() {
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  window = new BrowserWindow({
    width: Math.min(980, workArea.width),
    height: Math.min(710, workArea.height),
    minWidth: Math.min(740, workArea.width),
    minHeight: Math.min(560, workArea.height),
    title: '唤译 · 随叫随到的翻译助手',
    icon: path.join(__dirname, '../assets/icon.png'),
    show: false,
    frame: false,
    autoHideMenuBar: true,
    skipTaskbar: true,
    backgroundColor: '#f5f6f2',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('close', event => {
    if (!quitting) {
      event.preventDefault();
      hideWindow();
    }
  });
  window.on('closed', () => { window = null; });
  await window.loadFile(path.join(__dirname, 'renderer/index.html'));
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '../assets/icon.png')).resize({ width: 24, height: 24 });
  tray = new Tray(icon);
  tray.setToolTip('唤译 · 鼠标划词 · Ctrl + Alt + S 截图翻译');
  updateTrayMenu();
  tray.on('click', () => { void showWindow(true); });
}

function updateTrayMenu() {
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '鼠标划词按钮', type: 'checkbox', checked: preferences.mouseSelectionEnabled, click: item => { const task = settingsQueue.then(() => setMouseEnabled(item.checked)); settingsQueue = task.catch(error => send('app:notice', error.message)); } },
    { label: '截图翻译：Ctrl + Alt + S', click: () => { void startCapture().catch(error => send('app:notice', error.message)); } },
    { type: 'separator' },
    { label: '打开唤译', click: () => { void showWindow(true); } },
    { label: '唤出窗口：Ctrl + Alt + T', enabled: false },
    { label: '选中文字直接翻译：Ctrl + Alt + D', enabled: false },
    { type: 'separator' },
    { label: '退出唤译', click: () => { app.quit(); } },
  ]));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { void showWindow(true); });
  app.whenReady().then(async () => {
    store = new SettingsStore(path.join(app.getPath('userData'), 'settings.json'), {
      available: () => safeStorage.isAsyncEncryptionAvailable(),
      encrypt: value => safeStorage.encryptStringAsync(value),
      decrypt: async value => (await safeStorage.decryptStringAsync(value)).result,
    });
    await store.load();
    preferences = new Preferences(path.join(app.getPath('userData'), 'preferences.json'));
    await preferences.load();
    native = createWindowsNative();
    selectionReader = createSelectionReader({ clipboard, ClipboardItem, native });
    screenCapture = createScreenCapture({
      getModel: () => store.publicSettings().model,
      beforeCapture: () => { const visible = window?.isVisible(); mouseMonitor?.dismiss(); window?.hide(); send('capture:busy', true); return visible; },
      onCaptured: async (captured, point) => { await showWindow(false, point); send('capture:busy', false); send('image:captured', captured); },
      onCancel: visible => { send('capture:busy', false); if (visible) { window.show(); window.focus(); } },
      onError: error => { send('capture:busy', false); send('app:notice', error.message); },
    });
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    setupIPC();
    shortcutRegistered = globalShortcut.register(SHORTCUT, () => {
      if (window && window.isVisible() && window.isFocused()) hideWindow();
      else void showWindow(true);
    });
    selectionShortcutRegistered = globalShortcut.register(SELECTION_SHORTCUT, () => {
      if (!selectionTask) selectionTask = translateSelection().finally(() => { selectionTask = null; });
    });
    captureShortcutRegistered = globalShortcut.register(CAPTURE_SHORTCUT, () => {
      void startCapture().catch(error => send('app:notice', error.message));
    });
    await createWindow();
    await createMouseButton();
    createTray();
    await showWindow(false);
  }).catch(error => {
    dialog.showErrorBox('唤译启动失败', error.message);
    quitting = true;
    app.quit();
  });
  app.on('activate', () => { void showWindow(false); });
  app.on('window-all-closed', () => { /* Tray owns the application lifetime. */ });
  app.on('before-quit', event => {
    if (selectionTask && !quitting) {
      // Give the in-flight capture's finally block time to restore the clipboard.
      event.preventDefault();
      selectionTask.finally(() => app.quit());
    }
    quitting = true;
    screenCapture?.cancel(false);
    mouseMonitor?.stop();
    selectionHelper.stop();
    clearInterval(candidateTimer);
    selectionCapture?.abort();
    stopTranslation();
  });
  app.on('will-quit', () => { globalShortcut.unregisterAll(); tray?.destroy(); });
}
