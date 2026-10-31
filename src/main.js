'use strict';

const path = require('node:path');
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
  nativeImage,
  Tray
} = require('electron');

const { AppStore } = require('./services/store');
const { MonitorScheduler } = require('./services/scheduler');
const { activateClaudeMainWindow } = require('./services/claude-window');
const { RecoveryController } = require('./services/recovery-controller');
const { extractConversationId, buildConversationDeepLink } = require('./services/conversation');
const { inspectClaudeLimit } = require('./services/limit-detector');
const { sendContinuationMessage } = require('./services/claude-input');
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
let recoveryController = null;
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

async function getDashboardSnapshot(extra = {}) {
  return {
    ...store.snapshot(),
    logs: await store.readRecentLogs(25),
    appVersion: app.getVersion(),
    startup: getWindowsStartupStatus(app),
    platform: process.platform,
    limitDetectionImplemented: true,
    automaticContinueImplemented: true,
    ...extra
  };
}

async function openSavedConversation(conversationId) {
  const validId = extractConversationId(conversationId);
  if (!validId) throw new Error('La conversación guardada no tiene un ID válido.');

  const deepLink = buildConversationDeepLink(validId);
  await shell.openExternal(deepLink);
  return { opened: true, deepLink };
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

  const payload = await getDashboardSnapshot({
    mainWindowResult: result
  });

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
        recoveryController?.dispose();
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
    return getDashboardSnapshot();
  });

  ipcMain.handle('app:set-startup', async (_event, enabled) => {
    const result = setWindowsStartup(app, Boolean(enabled));
    await store.updateSettings({ startWithWindows: result.enabled });
    await store.log('info', result.enabled
      ? 'Inicio automático con Windows activado.'
      : 'Inicio automático con Windows desactivado.');

    return getDashboardSnapshot({ startup: result });
  });

  ipcMain.handle('app:set-monitoring', async (_event, enabled) => {
    await scheduler.setEnabled(Boolean(enabled));
    await store.log('info', enabled
      ? 'Vigilancia de Claude activada.'
      : 'Vigilancia de Claude pausada.');

    return getDashboardSnapshot();
  });

  ipcMain.handle('app:set-interval', async (_event, minutes) => {
    const value = await scheduler.setIntervalMinutes(minutes);
    await store.log('info', `Intervalo de comprobación ajustado a ${value.settings.checkIntervalMinutes} minutos.`);
    recoveryController?.schedule();
    return getDashboardSnapshot();
  });

  ipcMain.handle('app:set-fallback-wait', async (_event, minutes) => {
    const allowed = [300, 360, 480];
    const value = allowed.includes(Number(minutes)) ? Number(minutes) : 300;
    await store.updateSettings({ fallbackWaitMinutes: value });
    await store.log('info', `Espera de respaldo ajustada a ${value} minutos.`);
    return getDashboardSnapshot();
  });

  ipcMain.handle('app:check-now', async () => {
    const result = await scheduler.checkNow('manual');
    return getDashboardSnapshot({ processCheck: result.processCheck });
  });

  ipcMain.handle('app:activate-claude-main', async () => {
    return activateClaudeMainFromUi('panel');
  });

  ipcMain.handle('app:save-conversation', async (_event, rawValue) => {
    const conversationId = extractConversationId(rawValue);
    if (!conversationId) {
      throw new Error('Pega un ID UUID o un enlace de chat de Claude con formato /chat/ID.');
    }

    await store.updateSettings({
      conversationId,
      conversationVerified: false,
      automationEnabled: false
    });
    await store.updateMonitor({
      taskPending: false,
      recoveryStatus: 'needs_confirmation',
      recoveryMessage: 'Abre esta conversación y confirma visualmente que es la tarea original.',
      lastChatOpenedForVerificationAt: null,
      limitDetectedAt: null,
      limitResetAt: null,
      nextEligibleAt: null,
      continuationSentForLimit: false
    });
    await store.log('info', 'Se guardó un ID de conversación para verificarlo.');
    recoveryController?.schedule();
    return getDashboardSnapshot();
  });

  ipcMain.handle('app:open-saved-chat', async () => {
    const conversationId = store.snapshot().settings.conversationId;
    if (!conversationId) throw new Error('Primero guarda el ID de la conversación original.');

    await openSavedConversation(conversationId);
    await store.updateMonitor({
      lastChatOpenedForVerificationAt: new Date().toISOString(),
      recoveryStatus: 'awaiting_confirmation',
      recoveryMessage: 'Claude abrió el chat guardado. Comprueba que sea la conversación de tu tarea original.'
    });
    await store.log('info', 'Se abrió la conversación guardada para verificación.');
    return getDashboardSnapshot();
  });

  ipcMain.handle('app:set-conversation-verified', async (_event, verified) => {
    const settings = store.snapshot().settings;
    const openedAt = store.snapshot().monitor.lastChatOpenedForVerificationAt;

    if (verified && (!settings.conversationId || !openedAt ||
        Date.now() - Date.parse(openedAt) > 15 * 60 * 1000)) {
      throw new Error('Primero abre el chat guardado y comprueba que sea el correcto.');
    }

    await store.updateSettings({
      conversationVerified: Boolean(verified),
      automationEnabled: verified ? settings.automationEnabled : false
    });

    if (!verified) {
      await recoveryController?.configure(false);
    }

    await store.log('info', verified
      ? 'El usuario confirmó que el chat guardado es la conversación original.'
      : 'Se retiró la confirmación de la conversación.');
    return getDashboardSnapshot();
  });

  ipcMain.handle('app:set-automation', async (_event, enabled) => {
    await recoveryController.configure(Boolean(enabled));
    return getDashboardSnapshot();
  });

  ipcMain.handle('app:recovery-check', async () => {
    await recoveryController.tick('manual');
    return getDashboardSnapshot();
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

    recoveryController = new RecoveryController({
      store,
      inspectLimit: inspectClaudeLimit,
      openConversation: openSavedConversation,
      activateMainWindow: activateClaudeMainWindow,
      sendMessage: sendContinuationMessage,
      onUpdate: () => {
        getDashboardSnapshot()
          .then(sendMonitorUpdate)
          .catch(() => {});
      }
    });

    registerIpcHandlers();
    createTray();
    await scheduler.start();
    createMainWindow({ hidden: startedAtLogin });
    await recoveryController.start();

    app.on('activate', () => showMainWindow());
  }).catch((error) => {
    dialog.showErrorBox(APP_NAME, `No se pudo iniciar la aplicación.\n\n${error.message}`);
    app.quit();
  });
}

app.on('before-quit', () => {
  isQuitting = true;
  scheduler?.dispose();
  recoveryController?.dispose();
});

app.on('window-all-closed', () => {
  // La app permanece en segundo plano mediante el icono de la bandeja.
});
