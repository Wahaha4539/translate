'use strict';
const { BrowserWindow, desktopCapturer, screen, ipcMain } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { cropRectangle } = require('./geometry.cjs');
const { MAX_IMAGE_BYTES } = require('./contracts.cjs');

function createScreenCapture({ beforeCapture, onCaptured, onCancel, onError, getModel }) {
  let current = null;
  const file = path.join(__dirname, 'renderer/capture.html');
  const url = pathToFileURL(file).href;
  const trusted = event => current?.overlay && event.sender === current.overlay.webContents && event.senderFrame?.url === url;
  function closeOverlay(capture) {
    const overlay = capture.overlay;
    capture.overlay = null;
    if (overlay && !overlay.isDestroyed()) overlay.destroy();
    capture.image = null;
  }
  function cancel(restore = true) {
    if (!current) return;
    const capture = current;
    current = null;
    closeOverlay(capture);
    if (restore) onCancel(capture.wasVisible);
  }
  ipcMain.handle('capture:image', event => trusted(event) && current.image ? {
    image: current.image.toDataURL(), model: getModel(), width: current.display.bounds.width, height: current.display.bounds.height,
  } : null);
  ipcMain.handle('capture:cancel', event => { if (trusted(event)) cancel(); });
  ipcMain.handle('capture:finish', async (event, rect) => {
    if (!trusted(event) || current.finishing) return { ok: false };
    const capture = current;
    try {
      const crop = cropRectangle(rect, capture.display.bounds, capture.image.getSize());
      let image = capture.image.crop(crop);
      const size = image.getSize();
      if (Math.max(size.width, size.height) > 4096) {
        image = image.resize({ width: Math.max(1, Math.round(size.width * 4096 / Math.max(size.width, size.height))), height: Math.max(1, Math.round(size.height * 4096 / Math.max(size.width, size.height))), quality: 'best' });
      }
      const png = image.toPNG();
      if (png.length > MAX_IMAGE_BYTES) throw new Error('截图超过 8 MB，请缩小框选范围。');
      capture.finishing = true;
      const point = { x: capture.display.bounds.x + rect.x + rect.width, y: capture.display.bounds.y + rect.y + rect.height };
      const captured = { image: `data:image/png;base64,${png.toString('base64')}`, ...image.getSize() };
      closeOverlay(capture);
      current = null;
      await onCaptured(captured, point);
      return { ok: true };
    } catch (error) {
      if (current === capture || capture.finishing) {
        // Invalid small drags can be retried without leaving the capture screen.
        if (!capture.finishing) return { ok: false, error: error.message };
        current = null;
        closeOverlay(capture);
        onError(error);
      }
      return { ok: false, error: error.message };
    }
  });
  screen.on('display-metrics-changed', () => cancel());
  screen.on('display-removed', () => cancel());

  return {
    get busy() { return Boolean(current); },
    cancel,
    async start() {
      if (current) throw new Error('正在截图，请先完成或按 Esc 取消。');
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const capture = { display, image: null, overlay: null, finishing: false };
      current = capture;
      try {
        capture.wasVisible = beforeCapture();
        await new Promise(resolve => setTimeout(resolve, 180));
        if (current !== capture) return;
        const displays = screen.getAllDisplays();
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: {
          width: Math.min(8192, Math.ceil(Math.max(...displays.map(item => item.size.width * item.scaleFactor)))),
          height: Math.min(8192, Math.ceil(Math.max(...displays.map(item => item.size.height * item.scaleFactor)))),
        } });
        if (current !== capture) return;
        capture.image = sources.find(source => source.display_id === String(display.id))?.thumbnail;
        if (!capture.image || capture.image.isEmpty()) throw new Error('无法截取当前屏幕，请确认屏幕未被系统或软件保护。');
        const overlay = new BrowserWindow({
          ...display.bounds, frame: false, show: false, resizable: false, movable: false, skipTaskbar: true,
          alwaysOnTop: true, backgroundColor: '#15251d', enableLargerThanScreen: true,
          webPreferences: { preload: path.join(__dirname, 'capture-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
        });
        capture.overlay = overlay;
        overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        overlay.webContents.on('will-navigate', event => event.preventDefault());
        overlay.on('closed', () => { if (current === capture && capture.overlay) cancel(); });
        overlay.on('blur', () => { if (current === capture && !capture.finishing) cancel(); });
        await overlay.loadFile(file);
        if (current !== capture) return;
        overlay.setBounds(display.bounds);
        overlay.setAlwaysOnTop(true, 'screen-saver');
        overlay.show();
        overlay.focus();
      } catch (error) {
        if (current !== capture) return;
        cancel();
        throw error;
      }
    },
  };
}
module.exports = { createScreenCapture };
