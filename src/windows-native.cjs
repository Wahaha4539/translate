'use strict';

// Only the main process loads user32; the renderer never gets an input-injection API.
function createWindowsNative() {
  if (process.platform !== 'win32') throw new Error('选中文字快捷翻译目前仅支持 Windows。');
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const foreground = user32.func('uintptr_t __stdcall GetForegroundWindow()');
  const sequence = user32.func('uint32_t __stdcall GetClipboardSequenceNumber()');
  const owner = user32.func('uintptr_t __stdcall GetClipboardOwner()');
  const processForWindow = user32.func('uint32_t __stdcall GetWindowThreadProcessId(uintptr_t hwnd, _Out_ uint32_t *pid)');
  const keyState = user32.func('int16_t __stdcall GetAsyncKeyState(int key)');
  const cursorInfo = user32.func('int __stdcall GetCursorInfo(void *info)');
  const loadCursor = user32.func('uintptr_t __stdcall LoadCursorW(uintptr_t instance, uintptr_t name)');
  const doubleClickTime = user32.func('uint32_t __stdcall GetDoubleClickTime()');
  const textCursor = loadCursor(0, 32513); // IDC_IBEAM, shared system cursor; never changes the cursor.
  const cursorInfoSize = process.arch === 'ia32' ? 20 : 24;
  function isTextCursor() {
    const info = Buffer.alloc(cursorInfoSize);
    info.writeUInt32LE(cursorInfoSize, 0);
    if (!cursorInfo(info) || !(info.readUInt32LE(4) & 1)) return false;
    const current = process.arch === 'ia32' ? info.readUInt32LE(8) : Number(info.readBigUInt64LE(8));
    return Boolean(textCursor) && current === textCursor;
  }
  const sendInput = user32.func('uint32_t __stdcall SendInput(uint32_t count, const void *inputs, int size)');
  const keyInputSize = process.arch === 'ia32' ? 28 : 40;
  const unionOffset = process.arch === 'ia32' ? 4 : 8;
  const inputKeys = [0x10, 0x11, 0x12, 0x5b, 0x5c, 0x44]; // Shift, Ctrl, Alt, Win, D

  function windowProcess(hwnd) {
    const pid = [0];
    if (hwnd) processForWindow(hwnd, pid);
    return pid[0];
  }

  function sendKeys(events) {
    const buffer = Buffer.alloc(events.length * keyInputSize);
    events.forEach(({ key, up = false }, index) => {
      const offset = index * keyInputSize;
      buffer.writeUInt32LE(1, offset); // INPUT_KEYBOARD
      buffer.writeUInt16LE(key, offset + unionOffset);
      buffer.writeUInt32LE(up ? 2 : 0, offset + unionOffset + 4); // KEYEVENTF_KEYUP
    });
    const sent = sendInput(events.length, buffer, keyInputSize);
    if (sent !== events.length) {
      // Don't leave an injected modifier down if Windows rejects part of the batch.
      const releases = events.filter(event => !event.up).map(event => ({ key: event.key, up: true }));
      const cleanup = Buffer.alloc(releases.length * keyInputSize);
      releases.forEach((event, index) => {
        cleanup.writeUInt32LE(1, index * keyInputSize);
        cleanup.writeUInt16LE(event.key, index * keyInputSize + unionOffset);
        cleanup.writeUInt32LE(2, index * keyInputSize + unionOffset + 4);
      });
      sendInput(releases.length, cleanup, keyInputSize);
      throw new Error('无法向当前软件发送复制快捷键。管理员权限窗口可能需要手动复制。');
    }
  }

  return {
    foreground,
    textCursor: isTextCursor,
    doubleClickTime,
    mouseDown: () => (keyState(0x01) & 0x8000) !== 0,
    escapeDown: () => (keyState(0x1b) & 0x8000) !== 0,
    sequence,
    windowProcess,
    clipboardOwnerProcess: () => windowProcess(owner()),
    shortcutHeld: () => inputKeys.some(key => (keyState(key) & 0x8000) !== 0),
    copy: () => sendKeys([{ key: 0x11 }, { key: 0x43 }, { key: 0x43, up: true }, { key: 0x11, up: true }]),
    sendKeys,
  };
}

module.exports = { createWindowsNative };
