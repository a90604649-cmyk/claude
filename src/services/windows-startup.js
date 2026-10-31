'use strict';

function setWindowsStartup(app, enabled) {
  if (process.platform !== 'win32') {
    return { supported: false, enabled: false };
  }

  try {
    const args = app.isPackaged
      ? ['--autostart']
      : [app.getAppPath(), '--autostart'];

    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      path: process.execPath,
      args
    });

    const actual = app.getLoginItemSettings();
    return {
      supported: true,
      enabled: Boolean(actual.openAtLogin)
    };
  } catch (error) {
    return {
      supported: true,
      enabled: false,
      error: error.message
    };
  }
}

function getWindowsStartupStatus(app) {
  if (process.platform !== 'win32') {
    return { supported: false, enabled: false };
  }

  try {
    const status = app.getLoginItemSettings();
    return {
      supported: true,
      enabled: Boolean(status.openAtLogin)
    };
  } catch (error) {
    return {
      supported: true,
      enabled: false,
      error: error.message
    };
  }
}

module.exports = { setWindowsStartup, getWindowsStartupStatus };
