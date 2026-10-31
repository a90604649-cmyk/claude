'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('autoContinue', {
  getSnapshot: () => ipcRenderer.invoke('app:get-snapshot'),
  setStartup: (enabled) => ipcRenderer.invoke('app:set-startup', enabled),
  setMonitoring: (enabled) => ipcRenderer.invoke('app:set-monitoring', enabled),
  setIntervalMinutes: (minutes) => ipcRenderer.invoke('app:set-interval', minutes),
  setFallbackWait: (minutes) => ipcRenderer.invoke('app:set-fallback-wait', minutes),
  setRecoveryInterval: (minutes) => ipcRenderer.invoke('app:set-recovery-interval', minutes),
  setExecutionPolicy: (settings) => ipcRenderer.invoke('app:set-execution-policy', settings),
  saveConversation: (value) => ipcRenderer.invoke('app:save-conversation', value),
  openSavedChat: () => ipcRenderer.invoke('app:open-saved-chat'),
  setConversationVerified: (verified) => ipcRenderer.invoke('app:set-conversation-verified', verified),
  setAutomation: (enabled) => ipcRenderer.invoke('app:set-automation', enabled),
  recoveryCheck: () => ipcRenderer.invoke('app:recovery-check'),
  inspectLimitNow: () => ipcRenderer.invoke('app:inspect-limit-now'),
  checkNow: () => ipcRenderer.invoke('app:check-now'),
  activateClaudeMainWindow: () => ipcRenderer.invoke('app:activate-claude-main'),
  onUpdate: (callback) => {
    if (typeof callback !== 'function') return () => {};

    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('monitor:update', listener);

    return () => ipcRenderer.removeListener('monitor:update', listener);
  }
});
