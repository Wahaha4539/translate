'use strict';
// Always headless: no Electron app, native hooks, real clipboard, screenshot API or OS input.
const { chromium, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, '.test-artifacts');
async function main() {
  await fs.mkdir(artifacts, { recursive: true });
  const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const launch = { headless: true, args: ['--disable-gpu', '--no-first-run', '--disable-background-networking'] };
  try { await fs.access(chrome); launch.executablePath = chrome; } catch { /* Fall back to installed Playwright Chromium. */ }
  const browser = await chromium.launch(launch);
  const context = await browser.newContext({ viewport: { width: 980, height: 710 } });
  const errors = [];
  await context.route(/^https?:/, route => route.abort());
  await context.addInitScript(() => {
    const events = {};
    const requests = [];
    let pending;
    const settings = { baseUrl: 'http://127.0.0.1/v1', model: 'headless-fixture', hasApiKey: !location.search.includes('unconfigured'), shortcutRegistered: true, selectionShortcutRegistered: true, captureShortcutRegistered: true, mouseSelectionEnabled: true };
    const ok = data => Promise.resolve({ ok: true, data });
    window.fixture = {
      requests, events, settings, mode: 'normal', captures: 0, hides: 0, captureRects: [], cancelled: 0,
      emit: async (name, data) => { if (events[name]) await events[name](data); },
    };
    const api = {
      getSettings: () => ok({ ...settings }),
      saveSettings: value => { Object.assign(settings, value); return ok({ ...settings }); },
      setMouseEnabled: value => { settings.mouseSelectionEnabled = value; return ok({ mouseSelectionEnabled: value }); },
      readClipboard: () => ok('Clipboard fixture — not your real clipboard'),
      writeClipboard: value => { window.fixture.copied = value; return ok(); },
      pin: value => ok(value),
      hide: () => { window.fixture.hides++; if (pending) { pending({ ok: false, error: '已停止翻译。' }); pending = null; } return ok(); },
      expand: () => { events.onCompact(false); return ok(); },
      startCapture: () => { window.fixture.captures++; return ok(); },
      stop: () => { if (pending) { pending({ ok: false, error: '已停止翻译。' }); pending = null; } return ok(); },
      translate: async request => {
        requests.push(request);
        if (window.fixture.mode === 'error') return { ok: false, error: '请确认当前模型支持图片输入。' };
        if (window.fixture.mode === 'slow') { events.onDelta({ id: request.id, text: '部分译文' }); return new Promise(resolve => { pending = resolve; }); }
        const text = request.image ? '截图中的文字已翻译。这是后台测试回包。' : '你好，这是后台测试译文。';
        events.onDelta({ id: request.id, text });
        return ok({ text });
      },
    };
    for (const name of ['onCompact', 'onCaptureBusy', 'onImage', 'onSettingsRequired', 'onPreferences', 'onClipboard', 'onSelection', 'onDelta', 'onNotice']) api[name] = callback => { events[name] = callback; };
    window.huanyi = api;
    window.selectionButton = { translate: async () => { window.fixture.buttonClicks = (window.fixture.buttonClicks || 0) + 1; }, dismiss: async () => { window.fixture.cancelled++; } };
    window.screenCapture = {
      image: async () => ({ image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWOQAAAAASUVORK5CYII=', model: 'headless-fixture' }),
      finish: async rect => { window.fixture.captureRects.push(rect); return { ok: true }; },
      cancel: async () => { window.fixture.cancelled++; },
    };
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(pathToFileURL(path.join(root, 'src/renderer/index.html')).href);
    await expect(page.locator('#model-status-text')).toContainText('headless-fixture');
    assert.equal(await page.evaluate(() => fixture.requests.length), 0);
    await page.locator('#source').fill('Hello');
    await page.locator('#translate-button').click();
    await expect(page.locator('#result-status')).toHaveText('翻译完成');
    await page.locator('#pin-button').click();
    await expect(page.locator('#pin-button')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#pin-button').click();
    await expect(page.locator('#pin-button')).toHaveAttribute('aria-pressed', 'false');
    await page.locator('[data-tone="friendly"]').click();
    await expect(page.locator('#result-tone')).toContainText('友好');
    await page.evaluate(() => fixture.emit('onSelection', { text: 'Selected by the user' }));
    await expect(page.locator('#source')).toHaveValue('Selected by the user');
    await expect(page.locator('#result-tone')).toContainText('友好');
    await page.setViewportSize({ width: 580, height: 550 });
    await page.evaluate(() => fixture.emit('onCompact', true));
    await expect(page.locator('#expand-button')).toBeVisible();
    await page.screenshot({ path: path.join(artifacts, 'headless-selection-popover.png') });
    const screenshot = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 900; canvas.height = 140;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 900, 140);
      ctx.fillStyle = '#253e34'; ctx.font = '32px Georgia'; ctx.fillText('Hello world. Translate this selected area.', 28, 76);
      return canvas.toDataURL('image/png');
    });
    const beforeImage = await page.evaluate(() => fixture.requests.length);
    await page.evaluate(image => fixture.emit('onImage', { image, width: 900, height: 140 }), screenshot);
    await expect(page.locator('#source-image')).toBeVisible();
    await expect(page.locator('#source')).toBeHidden();
    await expect(page.locator('#result-status')).toHaveText('翻译完成');
    const imageRequest = await page.evaluate(() => fixture.requests.at(-1));
    assert.equal(imageRequest.image, screenshot);
    assert.equal(imageRequest.text, '');
    assert.equal(imageRequest.tone, 'friendly');
    assert.equal(await page.evaluate(() => fixture.requests.length), beforeImage + 1, 'Screenshot completion sends exactly one request');
    await page.locator('[data-tone="assertive"]').click();
    assert.equal(await page.evaluate(() => fixture.requests.at(-1).image), screenshot, 'Attitude change resends the original image');
    await expect(page.locator('#result-tone')).toContainText('坚定');
    for (const [width, height] of [[580, 550], [440, 460]]) {
      await page.setViewportSize({ width, height });
      const layout = await page.evaluate(() => {
        const workspace = document.querySelector('.workspace');
        return { scroll: workspace.scrollWidth, width: workspace.clientWidth, footer: document.querySelector('.footer').getBoundingClientRect().bottom, height: innerHeight };
      });
      assert.ok(layout.scroll <= layout.width + 1, `No horizontal overflow at ${width}x${height}: ${JSON.stringify(layout)}`);
      assert.ok(layout.footer <= layout.height + 1, 'Footer stays inside compact window');
    }
    await page.setViewportSize({ width: 580, height: 550 });
    await page.screenshot({ path: path.join(artifacts, 'headless-screenshot-translation.png') });
    await page.evaluate(() => { fixture.mode = 'error'; });
    await page.locator('#translate-button').click();
    await expect(page.locator('#notice')).toContainText('支持图片输入');
    await expect(page.locator('#result')).toContainText('截图中的文字已翻译');
    await expect(page.locator('#source-image')).toBeVisible();
    await page.evaluate(() => { fixture.mode = 'slow'; });
    await page.locator('#translate-button').click();
    await expect(page.locator('#capture-button')).toBeDisabled();
    await expect(page.locator('#clear-button')).toBeDisabled();
    await page.locator('#translate-button').click();
    await expect(page.locator('#notice')).toHaveText('已停止翻译。');
    await expect(page.locator('#result')).toContainText('截图中的文字已翻译');
    await page.evaluate(() => { fixture.mode = 'normal'; });
    await page.evaluate(() => fixture.emit('onCaptureBusy', true));
    await expect(page.locator('#translate-button')).toBeDisabled();
    await expect(page.locator('#settings-button')).toBeDisabled();
    await page.evaluate(() => fixture.emit('onCaptureBusy', false));
    await expect(page.locator('#translate-button')).toBeEnabled();
    await page.locator('#paste-button').click();
    await expect(page.locator('#source-image')).toBeHidden();
    await expect(page.locator('#source')).toContainText('');
    await expect(page.locator('#source')).toHaveValue('Clipboard fixture — not your real clipboard');
    await page.locator('#clear-button').click();
    await expect(page.locator('#translate-button')).toBeDisabled();
    await page.locator('#expand-button').click();
    await page.setViewportSize({ width: 980, height: 710 });
    await expect(page.locator('body')).not.toHaveClass(/compact/);
    await page.locator('#settings-button').click();
    await page.locator('#mouse-selection-enabled').uncheck();
    await expect(page.locator('#mouse-status')).toContainText('已关闭');
    await page.screenshot({ path: path.join(artifacts, 'headless-settings.png') });
    await page.locator('#settings-close').click();
    await page.goto(pathToFileURL(path.join(root, 'src/renderer/index.html')).href + '?unconfigured');
    await expect(page.locator('#model-status-text')).toHaveText('尚未配置模型');
    await page.evaluate(() => fixture.emit('onSettingsRequired'));
    await expect(page.locator('#settings-dialog')).toBeVisible();
    assert.equal(await page.evaluate(() => fixture.requests.length), 0);

    const capture = await context.newPage();
    capture.on('pageerror', error => errors.push(error.message));
    await capture.goto(pathToFileURL(path.join(root, 'src/renderer/capture.html')).href);
    await expect(capture.locator('#screen')).toBeVisible();
    await expect(capture.locator('#capture-model')).toHaveText('发送到 headless-fixture');
    await expect(capture.locator('#message')).toHaveText('框选后直接上传并翻译');
    await capture.mouse.move(100, 200); await capture.mouse.down();
    await capture.mouse.move(103, 203); await capture.mouse.up();
    await expect(capture.locator('#message')).toContainText('选区太小');
    assert.equal(await capture.evaluate(() => fixture.captureRects.length), 0);
    await capture.mouse.move(450, 400); await capture.mouse.down();
    await capture.mouse.move(100, 200, { steps: 4 }); await capture.mouse.up();
    assert.deepEqual(await capture.evaluate(() => fixture.captureRects), [{ x: 100, y: 200, width: 350, height: 200 }]);
    await capture.keyboard.press('Escape');
    assert.equal(await capture.evaluate(() => fixture.cancelled), 1);
    const button = await context.newPage();
    await button.goto(pathToFileURL(path.join(root, 'src/renderer/selection-button.html')).href);
    await button.locator('#selection-translate').click();
    assert.equal(await button.evaluate(() => fixture.buttonClicks), 1);
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(artifacts, 'headless-results.json'), JSON.stringify({ passed: true, realDesktopTested: false, realModelTested: false, checks: ['text selection event', 'compact layout', 'image auto-submit', 'image attitude regeneration', 'image error and cancel recovery', 'clear and clipboard replacement', 'preferences', 'capture reverse drag', 'tiny selection rejection', 'capture cancellation', 'button click'] }, null, 2));
    console.log('Headless UI tests passed. No desktop windows, OS input, real screenshots, real clipboard or model calls.');
  } finally { await context.close(); await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
