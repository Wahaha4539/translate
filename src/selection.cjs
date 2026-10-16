'use strict';

const { randomUUID } = require('node:crypto');
const { MAX_SOURCE_LENGTH } = require('./contracts.cjs');
const { createWindowsNative } = require('./windows-native.cjs');

function createSelectionReader({ clipboard, ClipboardItem, native = createWindowsNative(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now,
  makeMarker = () => `huanyi-selection-${randomUUID()}`, processId = process.pid,
  releaseTimeoutMs = 1500, copyTimeoutMs = 1200,
}) {
  let busy = false;

  async function capture({ signal, expectedWindow } = {}) {
    if (busy) throw new Error('正在获取选中文字，请稍候。');
    busy = true;
    let snapshot;
    let ownedSequence;
    let restoreWarning = '';
    let text;
    let target;
    let targetProcess;
    const check = () => {
      if (signal?.aborted) throw new Error('已取消获取选中文字。');
      if (native.foreground() !== target) throw new Error('当前窗口已切换，请重新选择文字并按快捷键。');
    };
    try {
      target = native.foreground();
      if (expectedWindow !== undefined && target !== expectedWindow) throw new Error('选区所在窗口已切换，请重新划词。');
      targetProcess = native.windowProcess(target);
      if (!target || !targetProcess || targetProcess === processId) {
        throw new Error('请先在其他软件中选中文字，再按 Ctrl + Alt + D。');
      }
      // Wait for the user's hotkey modifiers to be physically released before Ctrl+C.
      const releaseDeadline = now() + releaseTimeoutMs;
      while (native.shortcutHeld()) {
        check();
        if (now() >= releaseDeadline) throw new Error('请松开快捷键后重试。');
        await sleep(25);
      }
      check();
      const beforeSnapshot = native.sequence();
      const original = await clipboard.read();
      snapshot = await Promise.all(original.map(async item => {
        const entries = await Promise.all(item.types.map(async type => [type, await item.getType(type)]));
        return new ClipboardItem(Object.fromEntries(entries));
      }));
      check();
      if (native.sequence() !== beforeSnapshot) throw new Error('剪贴板正在被其他软件修改，请稍后重试。');
      // A marker is required: copying a selection equal to the old clipboard must work,
      // and an app that doesn't support copying must never translate old clipboard data.
      const marker = makeMarker();
      await clipboard.writeText(marker);
      ownedSequence = native.sequence();
      check();
      native.copy();
      const deadline = now() + copyTimeoutMs;
      while (native.sequence() === ownedSequence) {
        check();
        if (now() >= deadline) throw new Error('未获取到选中文字。请选中文字后重试，或使用 Ctrl + C、Ctrl + Alt + T。');
        await sleep(25);
      }
      const copiedSequence = native.sequence();
      if (native.clipboardOwnerProcess() !== targetProcess) {
        throw new Error('剪贴板被其他软件修改，本次未翻译。请重新选择文字。');
      }
      ownedSequence = copiedSequence;
      check();
      // Allow delayed clipboard rendering to settle, then read only this copy operation.
      await sleep(40);
      check();
      text = await clipboard.readText();
      check();
      if (native.sequence() !== copiedSequence) throw new Error('剪贴板内容再次变化，本次未翻译。');
      if (!text.trim() || text === marker) throw new Error('选中内容不包含可翻译的文字。');
      if (text.length > MAX_SOURCE_LENGTH) throw new Error('选中文字超过 24,000 字符，请分段翻译。');
    } finally {
      // Do not overwrite a new copy made by the user or another app in the meantime.
      try {
        if (snapshot && ownedSequence !== undefined && native.sequence() === ownedSequence) {
          await clipboard.write(snapshot);
        }
      } catch {
        restoreWarning = '已获取选中文字，但原剪贴板未能恢复。';
      }
      busy = false;
    }
    return { text, warning: restoreWarning };
  }

  return { capture };
}

module.exports = { createSelectionReader };
