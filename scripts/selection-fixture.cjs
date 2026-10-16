'use strict';
require('./desktop-test-consent.cjs');
const { app, BrowserWindow } = require('electron');
app.setName('HuanyiSelectionFixture');
if (process.env.HUANYI_FIXTURE_PROFILE) app.setPath('userData', process.env.HUANYI_FIXTURE_PROFILE);
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 600, height: 310, title: '唤译选区测试 · 独立软件',
    skipTaskbar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>独立选区测试窗口</title><style>body{font:14px 'Microsoft YaHei';padding:20px;background:#f4f6ef}textarea{display:block;width:95%;height:130px;padding:10px}p{color:#647354}</style><p>用于验证其他软件中的原生选区复制，不调用真实 AI。</p><textarea id="text" aria-label="测试文字">Selected words from another application.</textarea></html>`)}`);
});
app.on('window-all-closed', () => app.quit());
