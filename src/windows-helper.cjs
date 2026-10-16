'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const { createInterface } = require('node:readline');

// Helpers are isolated from Electron: a blocked accessibility provider can be killed.
class WindowsHelper {
  constructor() { this.child = null; this.pending = null; this.sequence = 0; }

  run(input, { signal, timeout = 12000 } = {}) {
    if (process.platform !== 'win32') return Promise.reject(new Error('此功能仅支持 Windows。'));
    if (this.pending) return Promise.reject(new Error('无障碍取词正在进行，请稍候。'));
    if (signal?.aborted) return Promise.reject(new Error('已取消无障碍取词。'));
    if (!this.child) {
      const script = path.join(__dirname, 'native/windows-helper.ps1').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
      const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
      const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Mta', '-ExecutionPolicy', 'Bypass', '-File', script], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
      });
      this.child = child;
      const lines = createInterface({ input: child.stdout });
      lines.on('line', line => {
        if (this.child !== child) return;
        try {
          const packet = JSON.parse(line.replace(/^\uFEFF/, ''));
          if (this.pending?.id !== packet.id) return;
          this.pending.finish(packet.ok ? null : new Error(packet.error || '无障碍取词失败。'), packet.data);
        } catch { /* Ignore helper startup diagnostics, never interpret them as commands. */ }
      });
      const failed = () => {
        if (this.child !== child) return;
        this.child = null;
        this.pending?.finish(new Error('Windows 取词服务未能启动或意外退出，请重试。'));
        lines.close();
      };
      child.on('error', failed);
      child.on('exit', failed);
      child.stdin.on('error', failed);
    }
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const abort = () => this.stop('已取消无障碍取词。');
      const timer = setTimeout(() => this.stop('无障碍取词超时。该软件可能不支持无障碍取词，请使用快捷键或截图翻译。'), timeout);
      this.pending = { id, finish: (error, data) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.pending = null;
        if (error) reject(error); else resolve(data);
      } };
      signal?.addEventListener('abort', abort, { once: true });
      this.child.stdin.write(`${JSON.stringify({ ...input, id })}\n`);
    });
  }

  stop(message = '已取消无障碍取词。') {
    const child = this.child;
    this.child = null;
    this.pending?.finish(new Error(message));
    child?.kill();
  }
}

module.exports = { WindowsHelper };
