'use strict';
require('./desktop-test-consent.cjs');
const { _electron: electron, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { once } = require('node:events');
const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, '.test-artifacts');
const profile = path.join(artifacts, `interaction-profile-${Date.now()}`);
const nativeFile = path.join(root, 'src/windows-native.cjs');
const requests = [];
const errors = [];
const server = http.createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  requests.push(JSON.parse(body));
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: '你好，这是本机模拟服务的译文。' } }] })}\n\ndata: [DONE]\n\n`);
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  await fs.mkdir(profile, { recursive: true });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const env = { ...process.env, HUANYI_TEST_USER_DATA: profile, HUANYI_TEST_WINDOW_SHORTCUT: 'CommandOrControl+Alt+F11', HUANYI_TEST_SELECTION_SHORTCUT: 'CommandOrControl+Alt+F10', HUANYI_TEST_CAPTURE_SHORTCUT: 'CommandOrControl+Alt+F9' };
  delete env.ELECTRON_RUN_AS_NODE;
  let application;
  let fixture;
  try {
    const launch = process.env.HUANYI_SMOKE_EXECUTABLE ? { executablePath: process.env.HUANYI_SMOKE_EXECUTABLE, args: [] } : { args: [root] };
    application = await electron.launch({ ...launch, env });
    const page = await application.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.locator('#model-status-text')).toHaveText('尚未配置模型');
    await page.locator('#settings-button').click();
    await page.locator('#api-url').fill(`http://127.0.0.1:${server.address().port}/v1`);
    await page.locator('#model-name').fill('interaction-fixture');
    await page.locator('#api-key').fill('local-fixture-only');
    await page.locator('#save-settings').click();
    await page.locator('[data-tone="friendly"]').click();
    await page.locator('#hide-button').click();
    fixture = await electron.launch({ args: [path.join(root, 'scripts/interaction-fixture.cjs')], env: { ...env, HUANYI_FIXTURE_PROFILE: path.join(profile, 'fixture') } });
    const target = await fixture.firstWindow();
    const button = await expect.poll(async () => {
      const windows = application.windows();
      return windows.some(w => w.url().endsWith('selection-button.html'));
    }).toBe(true).then(() => application.windows().find(w => w.url().endsWith('selection-button.html')));
    button.on('pageerror', error => errors.push(error.message));

    async function focusFixture() {
      await expect.poll(() => fixture.evaluate(({ BrowserWindow, app }, file) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.show(); window.focus(); app.focus({ steal: true });
        const koffi = process.mainModule.require(file.replace(/src[\\/]windows-native\.cjs$/, 'node_modules/koffi'));
        const user32 = koffi.load('user32.dll');
        const kernel32 = koffi.load('kernel32.dll');
        const foreground = user32.func('uintptr_t __stdcall GetForegroundWindow()');
        const windowThread = user32.func('uint32_t __stdcall GetWindowThreadProcessId(uintptr_t hwnd, void *pid)');
        const attach = user32.func('int __stdcall AttachThreadInput(uint32_t from, uint32_t to, int attach)');
        const activate = user32.func('int __stdcall SetForegroundWindow(uintptr_t hwnd)');
        const thread = kernel32.func('uint32_t __stdcall GetCurrentThreadId()')();
        const foregroundThread = windowThread(foreground(), null);
        const handle = Number(window.getNativeWindowHandle().readBigUInt64LE());
        const joined = foregroundThread && foregroundThread !== thread && attach(thread, foregroundThread, 1);
        try { activate(handle); } finally { if (joined) attach(thread, foregroundThread, 0); }
        return process.mainModule.require(file).createWindowsNative().windowProcess(foreground()) === process.pid;
      }, nativeFile), { timeout: 10000 }).toBe(true);
    }
    async function nativeMouse(point, flags = 0, allowedPid = 0) {
      await fixture.evaluate(({ screen }, { point, flags, file, allowedPid }) => {
        const native = process.mainModule.require(file).createWindowsNative();
        if (flags !== 4 && native.windowProcess(native.foreground()) !== process.pid) throw new Error(`Fixture lost foreground before native mouse input (${native.windowProcess(native.foreground())} != ${process.pid}, x=${point.x}, y=${point.y})`);
        const koffi = process.mainModule.require(file.replace(/src[\\/]windows-native\.cjs$/, 'node_modules/koffi'));
        const user = koffi.load('user32.dll');
        const physical = screen.dipToScreenPoint({ x: Math.round(point.x), y: Math.round(point.y) });
        if (flags !== 4) user.func('int __stdcall SetCursorPos(int x, int y)')(physical.x, physical.y);
        if (flags === 2) { const h = user.func('uintptr_t __stdcall WindowFromPoint(int64_t point)')(BigInt(physical.x >>> 0) | (BigInt(physical.y >>> 0) << 32n)); if (native.windowProcess(h) !== (allowedPid || process.pid)) throw new Error(`Mouse target is not fixture: physical=${JSON.stringify(physical)} point=${JSON.stringify(point)} cursor=${JSON.stringify(screen.getCursorScreenPoint())} hitPid=${native.windowProcess(h)} own=${process.pid}`); }
        if (flags) user.func('void __stdcall mouse_event(uint32_t flags, uint32_t dx, uint32_t dy, uint32_t data, uintptr_t info)')(flags, 0, 0, 0, 0);
      }, { point, flags, file: nativeFile, allowedPid });
    }
    async function globalRect(selector) {
      const local = await target.locator(selector).boundingBox();
      const bounds = await fixture.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentBounds());
      return { x: bounds.x + local.x, y: bounds.y + local.y, width: local.width, height: local.height };
    }
    async function dragSelection() {
      await focusFixture();
      const rect = await globalRect('#text');
      const start = { x: rect.x + 13, y: rect.y + 30 };
      const end = { x: rect.x + rect.width - 15, y: start.y };
      await nativeMouse(start, 2);
      try {
        await delay(160);
        for (let step = 1; step <= 8; step++) { await nativeMouse({ x: start.x + (end.x - start.x) * step / 8, y: start.y }); await delay(40); }
      } finally {
        // Release only the test's own press, even if the user switches applications.
        await nativeMouse(end, 4);
      }
      return end;
    }
    const clipboardBefore = await application.evaluate(async ({ clipboard }, file) => ({ text: await clipboard.readText(), sequence: process.mainModule.require(file).createWindowsNative().sequence() }), nativeFile);
    const anchor = await dragSelection();
    await delay(2000);
    await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('selection-button.html')).isVisible()), { timeout: 15000 }).toBe(true);
    assert.equal(requests.length, 0, 'Selecting text must never send a model request');
    const selected = await target.locator('#text').evaluate(element => element.value.slice(element.selectionStart, element.selectionEnd));
    assert.ok(selected.includes('Hello'));
    await button.screenshot({ path: path.join(artifacts, 'selection-button.png') });
    const buttonBounds = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('selection-button.html')).getBounds());
    assert.ok(Math.abs(buttonBounds.y - anchor.y) < 100, 'Button appears near the selection');
    const click = { x: buttonBounds.x + 40, y: buttonBounds.y + 18 };
    await nativeMouse(click, 2, await application.evaluate(() => process.pid));
    try { await delay(90); } finally { await nativeMouse(click, 4); }
    await expect(page.locator('#result-status')).toHaveText('翻译完成');
    await expect(page.locator('body')).toHaveClass('compact');
    await expect(page.locator('#source')).toHaveValue(selected);
    assert.equal(requests.length, 1);
    assert.match(requests[0].messages[0].content, /表达态度：友好/);
    const clipboardAfter = await application.evaluate(async ({ clipboard }, file) => ({ text: await clipboard.readText(), sequence: process.mainModule.require(file).createWindowsNative().sequence() }), nativeFile);
    assert.deepEqual(clipboardAfter, clipboardBefore, 'Mouse selection must not borrow or change clipboard');
    await page.screenshot({ path: path.join(artifacts, 'selection-popover.png') });
    const layout = await page.evaluate(() => ({ overflow: document.querySelector('.workspace').scrollWidth > document.querySelector('.workspace').clientWidth, footer: document.querySelector('.footer').getBoundingClientRect().bottom, height: innerHeight }));
    assert.equal(layout.overflow, false); assert.ok(layout.footer <= layout.height + 1);

    // Screenshot a known independent test window; only the selected strip reaches the local model fixture.
    const ocrRect = await globalRect('#ocr-text');
    await page.locator('#capture-button').click();
    await expect.poll(() => application.windows().some(w => w.url().endsWith('capture.html'))).toBe(true);
    let overlay = application.windows().find(w => w.url().endsWith('capture.html'));
    await expect.poll(() => overlay.locator('#screen').evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
    const bounds = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('capture.html')).getBounds());
    await overlay.mouse.move(ocrRect.x - bounds.x + 1, ocrRect.y - bounds.y + 1);
    await overlay.mouse.down();
    await overlay.mouse.move(ocrRect.x - bounds.x + ocrRect.width - 1, ocrRect.y - bounds.y + ocrRect.height - 1, { steps: 10 });
    await overlay.mouse.up();
    await expect(page.locator('#source-image')).toBeVisible();
    await expect(page.locator('#result-status')).toHaveText('翻译完成');
    assert.equal(requests.length, 2, 'Completing a screenshot directly uploads the selected image and translates');
    const imageParts = requests[1].messages[1].content;
    assert.equal(imageParts[1].type, 'image_url');
    assert.match(imageParts[1].image_url.url, /^data:image\/png;base64,/);
    assert.match(requests[1].messages[0].content, /直接识别图片/);
    assert.equal(await page.locator('#source-screenshot').getAttribute('src'), imageParts[1].image_url.url);
    const png = Buffer.from(imageParts[1].image_url.url.slice(22), 'base64');
    assert.ok(png.readUInt32BE(20) < 200, 'Only the cropped text strip is sent, never the full screen');
    await page.screenshot({ path: path.join(artifacts, 'screenshot-translation.png') });
    const beforeCancel = await page.locator('#source-screenshot').getAttribute('src');
    await page.locator('#capture-button').click();
    await expect.poll(() => application.windows().some(w => w.url().endsWith('capture.html'))).toBe(true);
    overlay = application.windows().find(w => w.url().endsWith('capture.html'));
    await overlay.keyboard.press('Escape');
    await expect(page.locator('#capture-button')).toBeEnabled();
    assert.equal(await page.locator('#source-screenshot').getAttribute('src'), beforeCancel);
    assert.equal(requests.length, 2);

    await page.locator('#expand-button').click();
    await expect(page.locator('body')).not.toHaveClass('compact');
    await page.locator('#settings-button').click();
    await page.locator('#mouse-selection-enabled').uncheck();
    await expect(page.locator('#mouse-status')).toContainText('已关闭');
    assert.equal(JSON.parse(await fs.readFile(path.join(profile, 'preferences.json'), 'utf8')).mouseSelectionEnabled, false);
    await page.locator('#settings-close').click();
    await page.locator('#hide-button').click();
    await dragSelection(); await delay(700);
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('selection-button.html')).isVisible()), false);
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(artifacts, 'interaction-results.json'), JSON.stringify({ passed: true, fixtureRequests: requests.length, realModelTested: false, checks: ['native mouse drag', 'Windows UIA selection', 'nonactivating button', 'no clipboard changes', 'click-to-translate', 'nearby compact result', 'attitude inherited', 'real screen crop', 'cropped image upload', 'direct vision translation', 'capture cancellation', 'expand', 'persisted opt-out'] }, null, 2));
    console.log('Interaction smoke passed: native selection, button, compact translation, real screen crop, direct image upload, cancellation, persisted opt-out. No real model used.');
  } finally {
    if (fixture) await fixture.close();
    if (application) await application.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
