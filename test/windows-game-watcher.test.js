'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildGameExitWatcherScript } = require('../src/services/windows-game-watcher');

test('watches only protected game process stop events, then relaunches AutoContinue', () => {
  const script = buildGameExitWatcherScript({
    executablePath: 'C:\\Program Files\\Claude AutoContinue.exe',
    argumentsText: '--scheduled-check',
    workingDirectory: 'C:\\Program Files'
  });

  assert.match(script, /Win32_ProcessStopTrace/);
  assert.match(script, /SKLauncher\.exe/);
  assert.match(script, /RobloxPlayerBeta\.exe/);
  assert.match(script, /Minecraft\.Windows\.exe/);
  assert.match(script, /java\.exe/);
  assert.match(script, /javaw\.exe/);
  assert.match(script, /WaitForNextEvent/);
  assert.match(script, /Test-BlockingGame/);
  assert.match(script, /Start-Process -FilePath \$exe/);
  assert.doesNotMatch(script, /RobloxStudioBeta\.exe/);
});

test('subscribes to process-stop events before the first running-game check', () => {
  const script = buildGameExitWatcherScript({
    executablePath: 'AutoContinue.exe',
    workingDirectory: 'C:\\Temp'
  });

  assert.ok(script.indexOf('$watcher.Start()') < script.indexOf('if (-not (Test-BlockingGame))'));
});

test('quotes apostrophes and rejects missing executable configuration', () => {
  const script = buildGameExitWatcherScript({
    executablePath: "C:\\Users\\O'Neil\\AutoContinue.exe",
    workingDirectory: "C:\\Users\\O'Neil"
  });
  assert.match(script, /O''Neil/);
  assert.throws(() => buildGameExitWatcherScript({
    executablePath: '',
    workingDirectory: 'C:\\Temp'
  }), /ruta de AutoContinue/i);
});
