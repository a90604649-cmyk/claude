'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isQuickEntryWindow,
  selectMainClaudeWindow
} = require('../src/services/claude-window');

test('identifies the small Claude quick-entry window', () => {
  assert.equal(isQuickEntryWindow({
    title: 'What do you need?',
    width: 440,
    height: 180
  }), true);

  assert.equal(isQuickEntryWindow({
    title: 'Claude',
    width: 430,
    height: 260
  }), true);
});

test('does not select the quick-entry window as the chat destination', () => {
  const selected = selectMainClaudeWindow([
    {
      handle: '101',
      title: 'What do you need?',
      width: 460,
      height: 220,
      visible: true,
      minimized: false,
      toolWindow: false,
      owned: false
    }
  ]);

  assert.equal(selected, null);
});

test('selects the largest visible regular Claude window', () => {
  const quickEntry = {
    handle: '101',
    title: 'What do you need?',
    width: 460,
    height: 220,
    visible: true,
    minimized: false,
    toolWindow: false,
    owned: false
  };
  const mainWindow = {
    handle: '202',
    title: 'Claude',
    width: 1280,
    height: 800,
    visible: true,
    minimized: false,
    toolWindow: false,
    owned: false
  };

  assert.equal(selectMainClaudeWindow([quickEntry, mainWindow]), mainWindow);
});

test('ignores tool windows, owned windows, and hidden windows', () => {
  const selected = selectMainClaudeWindow([
    {
      handle: '1',
      title: 'Claude',
      width: 1200,
      height: 800,
      visible: false,
      toolWindow: false,
      owned: false
    },
    {
      handle: '2',
      title: 'Claude',
      width: 1200,
      height: 800,
      visible: true,
      toolWindow: true,
      owned: false
    },
    {
      handle: '3',
      title: 'Claude',
      width: 1200,
      height: 800,
      visible: true,
      toolWindow: false,
      owned: true
    }
  ]);

  assert.equal(selected, null);
});
