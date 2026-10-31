'use strict';

const path = require('node:path');
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Tray
} = require('electron');

const { AppStore } = require('./services/store');
const { MonitorScheduler } = require('./services/scheduler');
const { activateClaudeMainWindow } = require('./services/claude-window');
const {
  setWindowsStartup,
  getWindowsStartupStatus
} = require('./services/windows-startup');

const APP_NAME = 'Claude AutoContinue';
const isWindows = process.platform === 'win32';
const startedAtLogin = process.argv.includes('--autostart');

let mainWindow = null;
let tray = null;
let store = null;
let scheduler = null;
let isQuitting = false;

const hasSingleInstance = app.requestSingleInstanceLock();
if (!hasSingleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });
}

function sendMonitorUpdate(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('monitor:update', payload);
  }
  updateTrayMenu();
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function activateClaudeMainFromUi(source = 'panel') {
  const result = await activateClaudeMainWindow();
  const checkedAt = new Date().toISOString();

  await store.updateMonitor({
    claudeMainWindowStatus: result.status,
    claudeMainWindowTitle: result.window?.title || null,
    lastMainWindowCheckAt: checkedAt,
    quickEntryDetected: Boolean(result.quickEntryDetected)
  });

  const level = result.status === 'focused'
    ? 'info'
    : result.status === 'error'
      ? 'error'
      : 'warning';

  await store.log(level, result.message, {
    source,
    status: result.status,
    window: result.window || null
  });

  const payload = {
    ...store.snapshot(),
    mainWindowResult: result,
    logs: await store.readRecentLogs(25)
  };

  sendMonitorUpdate(payload);
  return payload;
}

function createMainWindow({ hidden = false } = {}) {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 820,
    minHeight: 620,
    show: !hidden,
    backgroundColor: '#0b1020',
    title: APP_NAME,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function updateTrayMenu() {
  if (!tray) return;

  const snapshot = store ? store.snapshot() : null;
  const monitoring = snapshot?.settings.monitoringEnabled ? 'Activo' : 'Pausado';
  const claudeStatus = snapshot?.monitor.claudeRunning === true
    ? 'Claude abierto'
    : snapshot?.monitor.claudeRunning === false
      ? 'Claude cerrado'
      : 'Sin comprobar';

  const menu = Menu.buildFromTemplate([
    { label: APP_NAME, enabled: false },
    { label: `Vigilancia: ${monitoring}`, enabled: false },
    { label: claudeStatus, enabled: false },
    { type: 'separator' },
    {
      label: 'Abrir panel',
      click: () => showMainWindow()
    },
    {
      label: 'Comprobar Claude ahora',
      click: () => scheduler?.checkNow('menú de bandeja')
    },
    {
      label: 'Activar chat principal de Claude',
      click: () => {
        activateClaudeMainFromUi('menú de bandeja').catch((error) => {
          store?.log('error', 'No se pudo activar el chat principal de Claude.', {
            reason: error.message
          });
        });
      }
    },
    { type: 'separator' },
    {
      label: 'Salir',
      click: () => {
        isQuitting = true;
        scheduler?.dispose();
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(menu);
}

function createTray() {
  if (tray) return;

  const iconData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA1UlEQVR4nOVXwRGDMAxzOb5lvjIAHaodoJ2vDACv9GjiBMsQmx56kmAJWQ5AdHZcSou34TPtRfR+diwXe3FP4jUhjSU5V78pLVqISBywxleA1dPHfO4OtNobX49rcq2/j/UFcMTxGiIEakGJXLMPEoAURfarM0D0azUqMEDkgCRwXN8lolRjmAuZZgrcz4H/FJDrrSaIIgGSgGlPxk1jqB29JcQtQBMu3Q9lQFoUEQu3IBR3extuIeNwnHMg991eC4HvOA4Q2bmw5EkcqC0iru/+b+iOGZrYVESEnD4LAAAAAElFTkSuQmCC';
  const icon = nativeImage.createFromDataURL(iconData);
  tray = new Tray(icon);
  tray.setToolTip(APP_NAME);
  tray.on('double-click', showMainWindow);
  tray.on('click', showMainWindow);
  updateTrayMenu();
}

async function askAboutWindowsStartup() {
  if (!isWindows) return;

  const settings = store.snapshot().settings;
  if (settings.startupPromptShown) {
    if (settings.startWithWindows) setWindowsStartup(app, true);
    return;
  }

  const answer = await dialog.showMessageBox({
    type: 'question',
    title: APP_NAME,
    message: '¿Quieres que Claude AutoContinue se inicie automáticamente cuando enciendas Windows?',
    detail: 'Si eliges Sí, la aplicación podrá iniciar en segundo plano al entrar a Windows. Puedes cambiar esta opción después desde el panel.',
    buttons: ['Sí, activar', 'No, gracias'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  });

  const enabled = answer.response === 0;
  const result = setWindowsStartup(app, enabled);

  await store.updateSettings({
    startupPromptShown: true,
    startWithWindows: result.enabled
  });

  await store.log('info', enabled
    ? 'Se solicitó iniciar con Windows.'
    : 'El inicio automático con Windows quedó desactivado.');

  if (result.error) {
    await store.log('warning', 'Windows no confirmó el ajuste de inicio automático.', {
      reason: result.error
    });
  }
}

function registerIpcHandlers() {
  ipcMain.handle('app:get-snapshot', async () => {
    return {
      ...store.snapshot(),
      logs: await store.readRecentLogs(25),
      appVersion: app.getVersion(),
      startup: getWindowsStartupStatus(app),
      platform: process.platform,
      limitDetectionImplemented: false,
      automaticContinueImplemented: false
    };
  });

  ipcMain.handle('app:set-startup', async (_event, enabled) => {
    const result = setWindowsStartup(app, Boolean(enabled));
    await store.updateSettings({ startWithWindows: result.enabled });
    await store.log('info', result.enabled
      ? 'Inicio automático con Windows activado.'
      : 'Inicio automático con Windows desactivado.');

    return {
      ...store.snapshot(),
      startup: result
    };
  });

  ipcMain.handle('app:set-monitoring', async (_event, enabled) => {
    await scheduler.setEnabled(Boolean(enabled));
    await store.log('info', enabled
      ? 'Vigilancia de Claude activada.'
      : 'Vigilancia de Claude pausada.');

    return {
      ...store.snapshot(),
      logs: await store.readRecentLogs(25)
    };
  });

  ipcMain.handle('app:set-interval', async (_event, minutes) => {
    const value = await scheduler.setIntervalMinutes(minutes);
    await store.log('info', `Intervalo de comprobación ajustado a ${value.settings.checkIntervalMinutes} minutos.`);
    return value;
  });

  ipcMain.handle('app:check-now', async () => {
    const result = await scheduler.checkNow('manual');
    return {
      ...result,
      logs: await store.readRecentLogs(25)
    };
  });

  ipcMain.handle('app:activate-claude-main', async () => {
    return activateClaudeMainFromUi('panel');
  });
}

if (hasSingleInstance) {
  app.whenReady().then(async () => {
    app.setAppUserModelId('local.claudeautocontinue.app');

    store = new AppStore(app.getPath('userData'));
    await store.load();
    await askAboutWindowsStartup();

    scheduler = new MonitorScheduler({
      store,
      onUpdate: sendMonitorUpdate
    });

    registerIpcHandlers();
    createTray();
    await scheduler.start();
    createMainWindow({ hidden: startedAtLogin });

    app.on('activate', () => showMainWindow());
  }).catch((error) => {
    dialog.showErrorBox(APP_NAME, `No se pudo iniciar la aplicación.\n\n${error.message}`);
    app.quit();
  });
}

app.on('before-quit', () => {
  isQuitting = true;
  scheduler?.dispose();
});

app.on('window-all-closed', () => {
  // La app permanece en segundo plano mediante el icono de la bandeja.
});
