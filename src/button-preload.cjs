'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('selectionButton', {
  translate: () => ipcRenderer.invoke('mouse:translate'),
  dismiss: () => ipcRenderer.invoke('mouse:dismiss'),
});
