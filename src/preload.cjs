'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, data) => callback(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('huanyi', {
  startCapture: () => ipcRenderer.invoke('capture:start'),
  setMouseEnabled: enabled => ipcRenderer.invoke('preferences:save', enabled),
  expand: () => ipcRenderer.invoke('window:expand'),
  onCompact: callback => subscribe('window:compact', callback),
  onCaptureBusy: callback => subscribe('capture:busy', callback),
  onImage: callback => subscribe('image:captured', callback),
  onSettingsRequired: callback => subscribe('settings:required', callback),
  onPreferences: callback => subscribe('preferences:changed', callback),
  getSettings: () => ipcRenderer.invoke('settings:read'),
  saveSettings: input => ipcRenderer.invoke('settings:save', input),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  writeClipboard: text => ipcRenderer.invoke('clipboard:write', text),
  hide: () => ipcRenderer.invoke('window:hide'),
  pin: value => ipcRenderer.invoke('window:pin', value),
  translate: input => ipcRenderer.invoke('translate:start', input),
  stop: () => ipcRenderer.invoke('translate:stop'),
  onClipboard: callback => subscribe('clipboard:captured', callback),
  onSelection: callback => subscribe('selection:captured', callback),
  onDelta: callback => subscribe('translate:delta', callback),
  onNotice: callback => subscribe('app:notice', callback),
});
