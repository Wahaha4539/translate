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
const profile = path.join(artifacts, `selection-profile-${Date.now()}`);
const requests = [];
let slow = false;
const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const payload = JSON.parse(body);
  requests.push(JSON.parse(payload.messages[1].content));
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '选区翻译测试回包（非真实 AI）' } }] })}\n\n`);
  if (slow) { res.on('close', () => {}); return; }
  res.end('data: [DONE]\n\n');
});

async function main() {
  await fs.mkdir(profile, { recursive: true });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const env = { ...process.env, HUANYI_TEST_USER_DATA: profile, HUANYI_TEST_WINDOW_SHORTCUT: 'CommandOrControl+Alt+F11' };
  delete env.ELECTRON_RUN_AS_NODE;
  const launchOptions = process.env.HUANYI_SMOKE_EXECUTABLE
    ? { executablePath: process.env.HUANYI_SMOKE_EXECUTABLE, args: [] }
    : { args: [root] };
  let translator;
  let fixture;
  const errors = [];
  try {
    translator = await electron.launch({ ...launchOptions, env });
    const page = await translator.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await translator.evaluate(async ({ clipboard, ClipboardItem }) => {
      const original = await clipboard.read();
      globalThis.__originalClipboard = await Promise.all(original.map(async item => {
        const entries = await Promise.all(item.types.map(async type => [type, await item.getType(type)]));
        return new ClipboardItem(Object.fromEntries(entries));
      }));
    });
    assert.equal(await translator.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('CommandOrControl+Alt+D')), true);
    const fixtureEnv = { ...env, HUANYI_FIXTURE_PROFILE: path.join(profile, 'fixture') };
    delete fixtureEnv.HUANYI_TEST_USER_DATA;
    fixture = await electron.launch({ args: [path.join(root, 'scripts/selection-fixture.cjs')], env: fixtureEnv });
    const fixturePage = await fixture.firstWindow();
    const text = fixturePage.locator('#text');
    const nativeFile = path.join(root, 'src/windows-native.cjs');
    const selectedText = 'Selected words from another application.';

    async function focusSelection(content, hasSelection = true) {
      await text.fill(content);
      await text.evaluate((element, select) => {
        element.focus();
        element.setSelectionRange(0, select ? element.value.length : 0);
      }, hasSelection);
      await expect.poll(() => fixture.evaluate(({ BrowserWindow, app }, file) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.show();
        window.setAlwaysOnTop(true);
        window.focus();
        app.focus({ steal: true });
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
        const native = process.mainModule.require(file).createWindowsNative();
        return native.windowProcess(native.foreground()) === process.pid;
      }, nativeFile), { timeout: 10000, message: 'The independent fixture must own OS foreground before any injected keystrokes' }).toBe(true);
    }
    async function pressSelectionShortcut() {
      await fixture.evaluate((_electron, file) => {
        const native = process.mainModule.require(file).createWindowsNative();
        assertForeground(native);
        native.sendKeys([{ key: 0x11 }, { key: 0x12 }, { key: 0x44 }, { key: 0x44, up: true }, { key: 0x12, up: true }, { key: 0x11, up: true }]);
        function assertForeground(driver) {
          if (driver.windowProcess(driver.foreground()) !== process.pid) throw new Error('Test window lost focus before hotkey injection');
        }
      }, nativeFile);
    }
    async function setOriginalClipboard(value) {
      await translator.evaluate(async ({ clipboard, ClipboardItem }, data) => {
        await clipboard.write([new ClipboardItem({ 'text/plain': data, 'text/html': `<b>${data}</b>` })]);
      }, value);
    }
    async function assertRestored(value) {
      const restored = await translator.evaluate(async ({ clipboard }) => {
        const items = await clipboard.read();
        const item = items.find(entry => entry.types.includes('text/html'));
        return { text: await clipboard.readText(), html: item ? await (await item.getType('text/html')).text() : '' };
      });
      assert.deepEqual(restored, { text: value, html: `<b>${value}</b>` });
    }


    async function captureAndSubmit(content, clipboardValue, expectedRequests) {
      // A user can legitimately switch windows on this shared desktop. Retry only that
      // explicit cancellation, never protocol, stale-clipboard, or injection failures.
      for (let attempt = 0; attempt < 3; attempt++) {
        await page.locator('#hide-button').click();
        await setOriginalClipboard(clipboardValue);
        await page.locator('#notice').evaluate(element => { element.textContent = ''; });
        await focusSelection(content);
        await pressSelectionShortcut();
        let outcome;
        await expect.poll(async () => {
          if (requests.length === expectedRequests) return (outcome = 'submitted');
          const message = await page.locator('#notice').textContent();
          if (/当前窗口已切换/.test(message)) return (outcome = 'focus-changed');
          return 'waiting';
        }).not.toBe('waiting');
        if (outcome === 'submitted') return;
        await assertRestored(clipboardValue);
        console.log('Foreground changed during test capture; retrying the fixture selection.');
      }
      assert.fail('Shared desktop repeatedly changed focus during native selection capture');
    }

    // Missing configuration opens settings instead of making a network request.
    await page.locator('#hide-button').click();
    await setOriginalClipboard('original clipboard');
    await focusSelection(selectedText);
    await pressSelectionShortcut();
    await expect(page.locator('#source')).toHaveValue(selectedText);
    await expect(page.locator('#settings-dialog')).toBeVisible();
    assert.equal(requests.length, 0);
    await assertRestored('original clipboard');
    await page.locator('#api-url').fill(`http://127.0.0.1:${server.address().port}/v1`);
    await page.locator('#model-name').fill('本地选区测试 · 非真实 AI');
    await page.locator('#api-key').fill('selection-test-key');
    await page.locator('#save-settings').click();
    await expect(page.locator('#settings-dialog')).not.toBeVisible();

    // A real native hotkey captures exactly the selection and starts translating.
    await captureAndSubmit(selectedText, 'keep my clipboard', 1);
    await expect(page.locator('#result-status')).toHaveText('翻译完成');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].source, selectedText);
    await assertRestored('keep my clipboard');
    await page.screenshot({ path: path.join(artifacts, 'selection-translated-fixture.png') });

    // Even selection identical to the old clipboard must work.
    await captureAndSubmit(selectedText, selectedText, 2);
    await expect.poll(() => requests.length).toBe(2);
    await expect(page.locator('#result-status')).toHaveText('翻译完成');
    await assertRestored(selectedText);

    // Empty selection must not translate unrelated clipboard data or the previous source.
    await page.locator('#hide-button').click();
    await setOriginalClipboard('must never be submitted');
    await focusSelection('Nothing is selected here.', false);
    await pressSelectionShortcut();
    // On a shared desktop another app can take focus during the no-selection timeout.
    // Both outcomes must fail closed: no request and unchanged original clipboard.
    await expect(page.locator('#notice')).toHaveText(/未获取到选中文字|当前窗口已切换/);
    assert.equal(requests.length, 2);
    await assertRestored('must never be submitted');

    // Overly long selections do not start requests.
    await page.locator('#hide-button').click();
    await focusSelection('a'.repeat(24001));
    await pressSelectionShortcut();
    await expect(page.locator('#notice')).toContainText('超过 24,000');
    assert.equal(requests.length, 2);
    await assertRestored('must never be submitted');

    // Repeated hotkeys while translating must not replace or resubmit the current request.
    slow = true;
    await captureAndSubmit('First active selection', 'must never be submitted', 3);
    await expect(page.locator('#translate-button')).toHaveText('停止翻译');
    await expect.poll(() => requests.length).toBe(3);
    await focusSelection('Second selection should not interrupt');
    await pressSelectionShortcut();
    await expect(page.locator('#notice')).toContainText('正在翻译');
    assert.equal(requests.length, 3);
    await translator.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/renderer/index.html')).focus());
    await page.locator('#translate-button').click();
    await expect(page.locator('#notice')).toHaveText('已停止翻译。');
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(artifacts, 'selection-results.json'), JSON.stringify({ passed: true, realModelTested: false,
      checks: ['real Windows hotkey', 'external application selection', 'automatic translation', 'clipboard plain text and HTML restoration', 'same-as-clipboard selection', 'no selection', 'length limit', 'unconfigured model', 'in-flight duplicate prevention'],
    }, null, 2));
    console.log('Native selection smoke passed: actual Ctrl+Alt+D, cross-process selection, automatic translation, clipboard restoration, no-selection protection and repeated-hotkey guard.');
    console.log('Responses came from a local fixture, NOT a real AI model.');
  } finally {
    await fixture?.close();
    if (translator) {
      await translator.evaluate(async ({ clipboard }) => { if (globalThis.__originalClipboard) await clipboard.write(globalThis.__originalClipboard); }).catch(() => {});
      await translator.close();
    }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
