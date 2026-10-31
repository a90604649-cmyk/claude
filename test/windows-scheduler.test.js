'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TASK_NAME,
  buildRemoveTaskScript,
  buildScheduleTaskScript
} = require('../src/services/windows-scheduler');

test('creates a one-shot Windows task that wakes the PC and starts AutoContinue hidden', () => {
  const script = buildScheduleTaskScript({
    executablePath: 'C:\\Program Files\\Claude AutoContinue.exe',
    argumentsText: '--scheduled-check',
    workingDirectory: 'C:\\Program Files',
    dueAt: '2026-10-31T10:02:00.000Z'
  });

  assert.match(script, /New-ScheduledTaskTrigger -Once/);
  assert.match(script, /-WakeToRun/);
  assert.match(script, /-StartWhenAvailable/);
  assert.match(script, /--scheduled-check/);
  assert.match(script, new RegExp(TASK_NAME));
  assert.match(script, /Register-ScheduledTask/);
});

test('quotes apostrophes in paths for PowerShell safely', () => {
  const script = buildScheduleTaskScript({
    executablePath: "C:\\Users\\O'Neil\\AutoContinue.exe",
    workingDirectory: "C:\\Users\\O'Neil",
    dueAt: '2026-10-31T10:02:00.000Z'
  });

  assert.match(script, /O''Neil/);
});

test('rejects an invalid task time or missing executable paths', () => {
  assert.throws(() => buildScheduleTaskScript({
    executablePath: '',
    workingDirectory: 'C:\\Temp',
    dueAt: new Date()
  }), /ruta de AutoContinue/i);

  assert.throws(() => buildScheduleTaskScript({
    executablePath: 'AutoContinue.exe',
    workingDirectory: 'C:\\Temp',
    dueAt: 'not-a-date'
  }), /fecha/i);
});

test('builds a script to remove the one-shot task', () => {
  const script = buildRemoveTaskScript();
  assert.match(script, new RegExp(TASK_NAME));
  assert.match(script, /Unregister-ScheduledTask/);
});
