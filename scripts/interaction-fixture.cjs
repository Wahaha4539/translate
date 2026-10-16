'use strict';
require('./desktop-test-consent.cjs');
const { app, BrowserWindow } = require('electron');
app.setName('HuanyiInteractionFixture');
if (process.env.HUANYI_FIXTURE_PROFILE) app.setPath('userData', process.env.HUANYI_FIXTURE_PROFILE);
app.commandLine.appendSwitch('force-renderer-accessibility');
app.whenReady().then(async () => {
  app.setAccessibilitySupportEnabled(true);
  const window = new BrowserWindow({ x: 70, y: 70, width: 760, height: 430, title: '唤译交互测试 · 独立软件', skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><meta charset="utf-8"><style>body{margin:24px;font:16px 'Segoe UI',sans-serif;background:white;color:#111}textarea{display:block;box-sizing:border-box;width:100%;height:85px;padding:12px;font:24px/36px 'Segoe UI',sans-serif}#ocr-text{font:32px/1.5 Arial,sans-serif;padding:18px 10px;user-select:none;background:#fff;margin:20px 0}#blank{height:55px;background:white}input{width:200px}</style><p>Independent mouse selection / local OCR fixture</p><textarea id="text">Hello world. Translate this text.</textarea><p id="ocr-text">HELLO LOCAL OCR</p><div id="blank"></div><input id="password" type="password" value="never-read-password">`)}`);
});
app.on('window-all-closed', () => app.quit());
