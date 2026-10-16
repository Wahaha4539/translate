'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('screenCapture', {
  image: () => ipcRenderer.invoke('capture:image'),
  finish: rectangle => ipcRenderer.invoke('capture:finish', rectangle),
  cancel: () => ipcRenderer.invoke('capture:cancel'),
});
