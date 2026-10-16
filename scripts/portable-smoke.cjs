'use strict';
require('./desktop-test-consent.cjs');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const root = path.resolve(__dirname, '..');

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function main() {
  const port = await freePort();
  const profile = path.join(root, '.test-artifacts', `portable-profile-${Date.now()}`);
  await fs.mkdir(profile, { recursive: true });
  const env = { ...process.env, HUANYI_TEST_USER_DATA: profile, HUANYI_TEST_WINDOW_SHORTCUT: 'CommandOrControl+Alt+F11', HUANYI_TEST_SELECTION_SHORTCUT: 'CommandOrControl+Alt+F10', HUANYI_TEST_CAPTURE_SHORTCUT: 'CommandOrControl+Alt+F9' };
  delete env.ELECTRON_RUN_AS_NODE;
  const executable = path.join(root, 'dist', `Huanyi-${require('../package.json').version}-x64.exe`);
  const child = spawn(executable, [`--inspect=127.0.0.1:${port}`], { env, windowsHide: true, stdio: 'ignore' });
  let exited = false;
  child.on('exit', () => { exited = true; });
  let socket;
  let sequence = 0;
  const pending = new Map();
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function evaluate(expression) {
    const id = ++sequence;
    const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
    const result = await promise;
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  }
  try {
    let debuggerUrl;
    const deadline = Date.now() + 90000;
    while (!debuggerUrl && Date.now() < deadline && !exited) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
        debuggerUrl = (await response.json())[0]?.webSocketDebuggerUrl;
      } catch { /* The portable launcher is still extracting the application. */ }
      if (!debuggerUrl) await delay(400);
    }
    assert.ok(debuggerUrl, 'Portable binary must launch a live Electron process');
    socket = new WebSocket(debuggerUrl);
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    });
    await once(socket, 'open');
    const prefix = "process.mainModule.require('electron')";
    let state;
    while (Date.now() < deadline) {
      state = await evaluate(`(() => { const e = ${prefix}; const w = e.BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/renderer/index.html')); return { ready: e.app.isReady(), version: e.app.getVersion(), visible: w?.isVisible(), title: w?.getTitle(), url: w?.webContents.getURL(), shortcut: e.globalShortcut.isRegistered('CommandOrControl+Alt+F11'), selectionShortcut: e.globalShortcut.isRegistered('CommandOrControl+Alt+F10') }; })()`);
      if (state.visible && state.shortcut && state.url?.endsWith('/renderer/index.html')) break;
      await delay(250);
    }
    assert.equal(state.visible, true);
    assert.equal(state.version, require('../package.json').version);
    assert.equal(state.shortcut, true);
    assert.equal(state.selectionShortcut, true);
    assert.match(state.title, /唤译/);
    assert.match(state.url, /app\.asar/);
    const preferences = await evaluate(`(() => { const p = ${prefix}.BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/renderer/index.html')).webContents.getLastWebPreferences(); return { nodeIntegration: p.nodeIntegration, sandbox: p.sandbox, contextIsolation: p.contextIsolation }; })()`);
    assert.deepEqual(preferences, { nodeIntegration: false, sandbox: true, contextIsolation: true });
    await fs.writeFile(path.join(root, '.test-artifacts', 'portable-results.json'), JSON.stringify({ passed: true, state, realModelTested: false }, null, 2));
    console.log('Portable self-extraction and startup passed; visible window, packaged renderer, shortcut, and sandboxed renderer verified.');
  } finally {
    if (socket?.readyState === WebSocket.OPEN) {
      // Send quit without waiting for a reply: the inspector exits with the app.
      socket.send(JSON.stringify({ id: ++sequence, method: 'Runtime.evaluate', params: { expression: "process.mainModule.require('electron').app.quit()" } }));
      socket.close();
    }
    const deadline = Date.now() + 10000;
    while (!exited && Date.now() < deadline) await delay(200);
    if (!exited) execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
