'use strict';

const { MAX_SOURCE_LENGTH } = require('./contracts.cjs');

function createGestureTracker(doubleClickMs = 500) {
  let press = null;
  let lastClick = null;
  return sample => {
    if (sample.down) {
      if (!press) press = sample;
      return null;
    }
    if (!press) return null;
    const start = press;
    press = null;
    if (sample.hwnd !== start.hwnd) { lastClick = null; return null; }
    const distance = Math.hypot(sample.point.x - start.point.x, sample.point.y - start.point.y);
    const doubleClick = lastClick && sample.time - lastClick.time < doubleClickMs && lastClick.hwnd === sample.hwnd && Math.hypot(sample.point.x - lastClick.point.x, sample.point.y - lastClick.point.y) < 5;
    lastClick = sample;
    return distance >= 4 || doubleClick ? { ...sample, textCursor: Boolean(start.textCursor || sample.textCursor) } : null;
  };
}

function createMouseSelectionMonitor({ native, getPoint, toPhysical, readSelection, cancelRead, onSelection, onDismiss, onError,
  isBlocked = () => false, isOwnPoint = () => false, processId = process.pid, now = Date.now,
}) {
  let timer;
  let generation = 0;
  let down = false;
  const doubleClickMs = native.doubleClickTime?.() || 500;
  let tracker = createGestureTracker(doubleClickMs);

  function dismiss() { generation++; cancelRead(); onDismiss(); }
  function reset() { down = false; tracker = createGestureTracker(doubleClickMs); }
  function tick() {
    const point = getPoint();
    const held = native.mouseDown();
    if (native.escapeDown()) { dismiss(); reset(); return; }
    if (isBlocked() || isOwnPoint(point)) { reset(); return; }
    const hwnd = native.foreground();
    if (native.windowProcess(hwnd) === processId) { reset(); return; }
    if (held && !down) dismiss();
    down = held;
    const gesture = tracker({ down: held, hwnd, point, time: now(), textCursor: Boolean(native.textCursor?.()) });
    if (!gesture || !hwnd) return;
    const version = ++generation;
    const physical = toPhysical(point);
    // Standard text-selection gestures can offer the action immediately. A browser
    // need not expose TextPattern (or finish accessibility startup) just to show a button.
    // The promise is consumed only by an explicit click; this monitor never copies/sends.
    const readResult = Promise.resolve().then(() => {
      if (version !== generation || isBlocked()) return null;
      return readSelection({ hwnd, x: physical.x, y: physical.y, ownProcess: processId });
    }).catch(error => {
      if (version === generation && !isBlocked()) onError(error);
      return null;
    });
    const selected = { point, hwnd, readResult, isCurrent: () => version === generation };
    const offered = Boolean(gesture.textCursor);
    if (offered) onSelection(selected);
    void readResult.then(result => {
      if (version !== generation || isBlocked() || native.mouseDown() || native.foreground() !== hwnd) return;
      if (result?.blocked || typeof result?.text === 'string' && result.text.length > MAX_SOURCE_LENGTH) {
        if (offered) dismiss();
        return;
      }
      if (!offered && typeof result?.text === 'string' && result.text.trim()) {
        onSelection({ ...selected, text: result.text });
      }
    }).catch(error => { if (version === generation) onError(error); });
  }
  return {
    start() { if (!timer) { reset(); timer = setInterval(() => {
      try { tick(); } catch (error) { clearInterval(timer); timer = null; dismiss(); reset(); onError(error); }
    }, 16); timer.unref?.(); } },
    stop() { clearInterval(timer); timer = null; dismiss(); reset(); },
    dismiss, tick,
  };
}

module.exports = { createGestureTracker, createMouseSelectionMonitor };
