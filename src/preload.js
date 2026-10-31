'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('autoContinue', {
  getSnapshot: () => ipcRenderer.invoke('app:get-snapshot'),
  setStartup: (enabled) => ipcRenderer.invoke('app:set-startup', enabled),
  setMonitoring: (enabled) => ipcRenderer.invoke('app:set-monitoring', enabled),
  setIntervalMinutes: (minutes) => ipcRenderer.invoke('app:set-interval', minutes),
  checkNow: () => ipcRenderer.invoke('app:check-now'),
  onUpdate: (callback) => {
    if (typeof callback !== 'function') return () => {};

    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('monitor:update', listener);

    return () => ipcRenderer.removeListener('monitor:update', listener);
  }
});
