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
const profile = path.join(artifacts, `profile-${Date.now()}`);
const requests = [];
let mode = 'normal';
const server = http.createServer(async (req, res) => {
  if (req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
  let body = '';
  for await (const chunk of req) body += chunk;
  const payload = JSON.parse(body);
  const data = JSON.parse(payload.messages[1].content);
  requests.push({ payload, data, authorization: req.headers.authorization });
  if (mode === 'error') { res.writeHead(401).end(); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const chunks = mode === 'slow' ? ['正在生成', '后续文本']
    : data.revisionInstruction ? ['团队各位好，', '请在周五下午三点前发送修改后的方案。谢谢！']
    : ['团队各位好：\n\n', '请在周五下午 3 点前发送修改后的方案。', '\n谢谢！'];
  const toneMatch = payload.messages[0].content.match(/表达态度：([^，]+)，/);
  if (toneMatch && toneMatch[1] !== '原味' && mode !== 'slow') {
    const strengthMatch = payload.messages[0].content.match(/态度力度：([^，]+)，/);
    chunks.push('\n[本机模拟态度：' + toneMatch[1] + ' · ' + strengthMatch[1] + ']');
  }
  let index = 0;
  function write() {
    if (index === chunks.length) { res.end('data: [DONE]\n\n'); return; }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[index++] } }] })}\n\n`);
  }
  write();
  const timer = setInterval(write, mode === 'slow' ? 4000 : 75);
  res.on('close', () => clearInterval(timer));
});

async function main() {
  await fs.mkdir(profile, { recursive: true });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const env = { ...process.env, HUANYI_TEST_USER_DATA: profile, HUANYI_TEST_WINDOW_SHORTCUT: 'CommandOrControl+Alt+F11', HUANYI_TEST_SELECTION_SHORTCUT: 'CommandOrControl+Alt+F10', HUANYI_TEST_CAPTURE_SHORTCUT: 'CommandOrControl+Alt+F9' };
  delete env.ELECTRON_RUN_AS_NODE;
  const launchOptions = process.env.HUANYI_SMOKE_EXECUTABLE
    ? { executablePath: process.env.HUANYI_SMOKE_EXECUTABLE, args: [] }
    : { args: [root] };
  let application;
  const pageErrors = [];
  try {
    application = await electron.launch({ ...launchOptions, env, timeout: 30000 });
    await application.evaluate(async ({ clipboard, ClipboardItem }) => {
      const original = await clipboard.read();
      globalThis.__huanyiOriginalClipboard = await Promise.all(original.map(async item => {
        const entries = await Promise.all(item.types.map(async type => [type, await item.getType(type)]));
        return new ClipboardItem(Object.fromEntries(entries));
      }));
    });
    let page = await application.firstWindow();
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') pageErrors.push(message.text()); });
    await expect(page.locator('#model-status-text')).toHaveText('尚未配置模型');
    await expect(page.locator('#translate-button')).toBeDisabled();
    await expect(page.locator('[data-tone="neutral"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#tone-strength')).toBeDisabled();
    await page.locator('[data-tone="flattering"]').click();
    await expect(page.locator('#tone-strength')).toBeEnabled();
    await page.locator('#tone-more').selectOption('sarcastic');
    await expect(page.locator('#tone-description')).toContainText('谨慎使用');
    assert.equal(requests.length, 0, 'Changing attitude before first translation must not send text');
    await expect(page.locator('#settings-dialog')).not.toBeVisible();
    await page.locator('[data-tone="neutral"]').click();
    const desktopState = await application.evaluate(({ globalShortcut, BrowserWindow, safeStorage }) => ({
      shortcut: globalShortcut.isRegistered('CommandOrControl+Alt+F11'),
      selectionShortcut: globalShortcut.isRegistered('CommandOrControl+Alt+F10'),
      secureStorage: safeStorage.isEncryptionAvailable(),
      sandbox: BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/renderer/index.html')).webContents.getLastWebPreferences().sandbox,
      contextIsolation: BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/renderer/index.html')).webContents.getLastWebPreferences().contextIsolation,
      nodeIntegration: BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/renderer/index.html')).webContents.getLastWebPreferences().nodeIntegration,
    }));
    assert.equal(desktopState.shortcut, true, 'Global shortcut must be registered');
    assert.equal(desktopState.selectionShortcut, true, 'Selection shortcut must be registered');
    assert.equal(desktopState.secureStorage, true);
    assert.equal(desktopState.sandbox, true);
    assert.equal(desktopState.contextIsolation, true);
    assert.equal(desktopState.nodeIntegration, false);
    await page.locator('#source').fill('Hi team,\n\nCould you send the revised proposal by 3 PM on Friday?\nThanks!');
    await page.screenshot({ path: path.join(artifacts, 'preview.png') });
    await page.locator('#translate-button').click();
    await expect(page.locator('#settings-dialog')).toBeVisible();
    assert.equal(requests.length, 0, 'Unconfigured app must not send requests');
    await page.locator('#api-url').fill(baseUrl);
    await page.locator('#model-name').fill('本地测试服务 · 非真实 AI');
    await page.locator('#api-key').fill('smoke-test-secret-123');
    await page.locator('#save-settings').click();
    await expect(page.locator('#settings-dialog')).not.toBeVisible();
    const persisted = await fs.readFile(path.join(profile, 'settings.json'), 'utf8');
    assert.equal(persisted.includes('smoke-test-secret-123'), false);
    assert.ok(JSON.parse(persisted).encryptedApiKey);
    await page.locator('#settings-button').click();
    await expect(page.locator('#api-key')).toHaveValue('');
    await page.locator('#settings-close').click();
    await page.locator('#translate-button').click();
    await expect(page.locator('#result-status')).toHaveText('翻译完成');
    await expect(page.locator('#result')).toContainText('周五下午 3 点');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].authorization, 'Bearer smoke-test-secret-123');
    assert.match(requests[0].payload.messages[0].content, /表达态度：原味/);
    await expect(page.locator('#result-tone')).toHaveText('原味');
    await page.screenshot({ path: path.join(artifacts, 'translated-test-fixture.png') });
    await page.locator('#copy-button').click();
    const copied = await application.evaluate(async ({ clipboard }) => clipboard.readText());
    assert.match(copied, /周五下午 3 点/);
    await page.getByRole('button', { name: '更自然', exact: true }).click();
    await expect(page.locator('#result-status')).toHaveText('已按要求修订');
    assert.equal(requests.length, 2);
    assert.match(requests[1].data.previousTranslation, /周五下午 3 点/);
    const previousOutput = await page.locator('#result').textContent();
    mode = 'error';
    await page.getByRole('button', { name: '更正式', exact: true }).click();
    await expect(page.locator('#notice')).toContainText('API Key 无效');
    await expect(page.locator('#result')).toHaveText(previousOutput);
    mode = 'normal';
    const originalSource = await page.locator('#source').inputValue();
    const switchCases = [
      ['friendly', '友好'], ['serious', '严肃'], ['assertive', '坚定'],
      ['tactful', '委婉'], ['affectionate', '撒娇'], ['cool', '高冷'],
      ['playful', '俏皮'], ['sarcastic', '阴阳怪气'], ['flattering', '讨好'],
    ];
    for (const [tone, label] of switchCases) {
      const before = requests.length;
      if (['friendly', 'serious', 'assertive', 'flattering'].includes(tone)) {
        await page.locator('button[data-tone="' + tone + '"]').click();
        await expect(page.locator('#tone-more')).toHaveValue('');
      } else {
        await page.locator('#tone-more').selectOption(tone);
        assert.equal(await page.locator('button[data-tone][aria-pressed="true"]').count(), 0);
      }
      await expect(page.locator('#result-status')).toHaveText('翻译完成');
      await expect(page.locator('#result-tone')).toHaveText(label + ' · 明显');
      await expect(page.locator('#result')).toContainText('本机模拟态度：' + label);
      assert.equal(requests.length, before + 1, 'One click should send one request');
      assert.equal(requests.at(-1).data.source, originalSource);
      assert.equal(requests.at(-1).data.previousTranslation, undefined, 'Attitude switches are grounded in original source, not recursive rewrites');
      assert.ok(requests.at(-1).payload.messages[0].content.includes('表达态度：' + label));
    }
    const sameToneRequests = requests.length;
    await page.locator('[data-tone="flattering"]').click();
    assert.equal(requests.length, sameToneRequests, 'Selecting the already-applied tone should be a no-op');
    await page.locator('#tone-strength').focus();
    await page.locator('#tone-strength').press('ArrowRight');
    await expect(page.locator('#result-tone')).toHaveText('讨好 · 拉满');
    assert.equal(requests.length, sameToneRequests + 1);
    assert.match(requests.at(-1).payload.messages[0].content, /态度力度：拉满/);
    await page.locator('#tone-strength').evaluate(input => {
      input.value = '1';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(page.locator('#tone-strength-label')).toHaveText('一点点');
    assert.equal(requests.length, sameToneRequests + 1, 'Dragging a slider must not send intermediate requests');
    await page.locator('#tone-strength').evaluate(input => input.dispatchEvent(new Event('change', { bubbles: true })));
    await expect(page.locator('#result-tone')).toHaveText('讨好 · 一点点');
    assert.equal(requests.length, sameToneRequests + 2);
    assert.match(requests.at(-1).payload.messages[0].content, /态度力度：一点点/);
    await page.getByRole('button', { name: '更自然', exact: true }).click();
    await expect(page.locator('#result-status')).toHaveText('已按要求修订');
    assert.match(requests.at(-1).payload.messages[0].content, /表达态度：讨好/);
    assert.match(requests.at(-1).payload.messages[0].content, /态度力度：一点点/);
    assert.ok(requests.at(-1).data.previousTranslation);
    const goodToneOutput = await page.locator('#result').textContent();
    await page.screenshot({ path: path.join(artifacts, 'attitude-test-fixture.png') });
    mode = 'error';
    await page.locator('[data-tone="serious"]').click();
    await expect(page.locator('#notice')).toContainText('API Key 无效');
    await expect(page.locator('#result')).toHaveText(goodToneOutput);
    await expect(page.locator('#result-tone')).toHaveText('讨好 · 一点点');
    await expect(page.locator('#result-status')).toContainText('请重新翻译');
    await expect(page.getByRole('button', { name: '更自然', exact: true })).toBeDisabled();
    mode = 'slow';
    await page.locator('#translate-button').click();
    await expect(page.locator('#result')).toContainText('正在生成');
    await expect(page.locator('[data-tone="flattering"]')).toBeDisabled();
    await expect(page.locator('#tone-more')).toBeDisabled();
    await expect(page.locator('#tone-strength')).toBeDisabled();
    await page.getByRole('button', { name: '停止翻译', exact: true }).click();
    await expect(page.locator('#notice')).toHaveText('已停止翻译。');
    await expect(page.locator('#result')).toHaveText(goodToneOutput);
    await expect(page.locator('#result-tone')).toHaveText('讨好 · 一点点');
    mode = 'normal';
    await page.locator('[data-tone="serious"]').click();
    await expect(page.locator('#result-tone')).toHaveText('严肃 · 一点点');
    await page.locator('[data-tone="neutral"]').click();
    await expect(page.locator('#result-tone')).toHaveText('原味');
    await expect(page.locator('#tone-strength')).toBeDisabled();
    assert.doesNotMatch(requests.at(-1).payload.messages[0].content, /态度力度：/);
    // Changes to source, target, or style require an explicit new translation.
    const currentRequests = requests.length;
    await page.locator('#target').selectOption('en');
    await page.locator('[data-tone="friendly"]').click();
    assert.equal(requests.length, currentRequests);
    await page.locator('#target').selectOption('auto');
    await page.locator('[data-style="formal"]').click();
    await page.locator('[data-tone="serious"]').click();
    assert.equal(requests.length, currentRequests);
    await page.locator('[data-style="natural"]').click();
    await page.locator('#source').fill('Changed source');
    await page.locator('[data-tone="flattering"]').click();
    assert.equal(requests.length, currentRequests);
    await expect(page.getByRole('button', { name: '更自然', exact: true })).toBeDisabled();
    mode = 'slow';
    await page.locator('#translate-button').click();
    await expect(page.locator('#result')).toContainText('正在生成');
    await page.getByRole('button', { name: '停止翻译', exact: true }).click();
    await expect(page.locator('#notice')).toHaveText('已停止翻译。');
    await expect(page.locator('#result-status')).toContainText('部分译文');
    await expect(page.getByRole('button', { name: '更自然', exact: true })).toBeDisabled();
    mode = 'normal';
    const priorRequests = requests.length;
    await application.evaluate(async ({ clipboard }) => clipboard.writeText('Clipboard text is not sent automatically.'));
    await page.locator('#paste-button').click();
    await expect(page.locator('#source')).toHaveValue('Clipboard text is not sent automatically.');
    assert.equal(requests.length, priorRequests);
    // Exercise the renderer's selection event without grabbing another app's text.
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/renderer/index.html')).webContents.send('selection:captured', { text: 'Selection attitude fixture' }));
    await expect(page.locator('#source')).toHaveValue('Selection attitude fixture');
    await expect(page.locator('#result-tone')).toHaveText('讨好 · 一点点');
    assert.equal(requests.at(-1).data.source, 'Selection attitude fixture');
    assert.match(requests.at(-1).payload.messages[0].content, /表达态度：讨好/);
    await page.locator('#paste-button').click();
    await expect(page.locator('#source')).toHaveValue('Clipboard text is not sent automatically.');
    await page.locator('#pin-button').click();
    await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/renderer/index.html')).isAlwaysOnTop())).toBe(true);
    await page.locator('#pin-button').click();
    await page.keyboard.press('Escape');
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/renderer/index.html')).isVisible()), false);
    await application.evaluate(({ app }) => app.emit('second-instance'));
    await expect(page.locator('#source')).toHaveValue('Clipboard text is not sent automatically.');
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/renderer/index.html')).isVisible()), true);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/renderer/index.html')).close());
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/renderer/index.html')).isVisible()), false);
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(w => w.webContents.getURL().endsWith('/renderer/index.html')).length), 1);
    await application.evaluate(({ app }) => app.emit('second-instance'));
    // Verify the actual native encrypted configuration survives a full restart.
    await application.evaluate(async ({ clipboard }) => clipboard.write(globalThis.__huanyiOriginalClipboard));
    await application.close();
    application = await electron.launch({ ...launchOptions, env, timeout: 30000 });
    await application.evaluate(async ({ clipboard, ClipboardItem }) => {
      const original = await clipboard.read();
      globalThis.__huanyiOriginalClipboard = await Promise.all(original.map(async item => {
        const entries = await Promise.all(item.types.map(async type => [type, await item.getType(type)]));
        return new ClipboardItem(Object.fromEntries(entries));
      }));
    });
    page = await application.firstWindow();
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') pageErrors.push(message.text()); });
    await expect(page.locator('#model-status-text')).toContainText('模型已配置');
    await page.locator('#source').fill('Test after restart');
    await page.locator('#translate-button').click();
    await expect(page.locator('#result-status')).toHaveText('翻译完成');
    assert.equal(requests.at(-1).authorization, 'Bearer smoke-test-secret-123');
    await expect(page.locator('[data-tone="neutral"]')).toHaveAttribute('aria-pressed', 'true');
    assert.match(requests.at(-1).payload.messages[0].content, /表达态度：原味/);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/renderer/index.html')).setSize(760, 560));
    await page.locator('#tone-more').selectOption('sarcastic');
    await expect(page.locator('#result-tone')).toHaveText('阴阳怪气 · 明显');
    await page.screenshot({ path: path.join(artifacts, 'compact-test-fixture.png') });
    const bounds = await page.evaluate(() => ({
      viewport: innerHeight,
      footer: document.querySelector('.footer').getBoundingClientRect().bottom,
      notice: document.getElementById('notice').getBoundingClientRect().bottom,
      workspace: document.querySelector('.workspace').getBoundingClientRect().bottom,
      revision: document.querySelector('.revision-form').getBoundingClientRect().bottom,
      tonePanel: document.querySelector('.tone-panel').getBoundingClientRect().toJSON(),
      strength: document.querySelector('.tone-strength').getBoundingClientRect().toJSON(),
      heading: document.querySelector('.result-panel h2').getBoundingClientRect().toJSON(),
      copy: document.getElementById('copy-button').getBoundingClientRect().toJSON(),
      source: document.getElementById('source').getBoundingClientRect().toJSON(),
      overflow: document.querySelector('.workspace').scrollWidth > document.querySelector('.workspace').clientWidth,
    }));
    assert.ok(bounds.footer <= bounds.viewport + 1);
    assert.ok(bounds.revision <= bounds.workspace, 'Compact mode must not overflow the footer');
    assert.equal(bounds.overflow, false, 'Compact mode must not overflow horizontally');
    assert.ok(bounds.strength.right <= bounds.tonePanel.right, 'Attitude controls must fit the panel');
    assert.ok(bounds.heading.right <= bounds.copy.left, 'Result attitude badge must not overlap copy');
    assert.ok(bounds.source.height >= 60, 'Original text retains usable space');
    await page.locator('#settings-button').click();
    await page.locator('#remove-key').click();
    await page.locator('#save-settings').click();
    await expect(page.locator('#model-status-text')).toHaveText('尚未配置模型');
    assert.equal(JSON.parse(await fs.readFile(path.join(profile, 'settings.json'), 'utf8')).encryptedApiKey, '');
    assert.deepEqual(pageErrors, [], 'No renderer errors');
    await fs.writeFile(path.join(artifacts, 'smoke-results.json'), JSON.stringify({
      passed: true, desktopState, fixtureRequests: requests.length, realModelTested: false,
      checks: ['tray lifecycle', 'global shortcut registration', 'native clipboard', 'encrypted settings', 'restart persistence', 'compact layout', 'streaming', 'revision', 'error recovery', 'cancellation', 'privacy boundary', 'renderer sandbox', 'all attitude presets', 'attitude strength and drag commit', 'attitude request isolation', 'attitude revision', 'attitude failure and cancellation recovery', 'original-tone restart default', 'selection event inherits attitude'],
    }, null, 2));
    console.log('Desktop smoke passed: native lifecycle, shortcut registration, encrypted settings, clipboard, streaming, revisions, cancellation, and privacy boundary.');
    console.log('Model responses used a local fixture, NOT a real AI service.');
  } finally {
    if (application) {
      await application.evaluate(async ({ clipboard }) => {
        if (globalThis.__huanyiOriginalClipboard) await clipboard.write(globalThis.__huanyiOriginalClipboard);
      }).catch(() => {});
      await application.close();
    }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
