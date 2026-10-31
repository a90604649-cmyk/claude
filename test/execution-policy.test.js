'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getSchoolScheduleBlock,
  identifyBlockingGame,
  sanitizeExecutionPolicySettings
} = require('../src/services/execution-policy');

test('blocks weekdays from 13:00 inclusive to 18:00 exclusive', () => {
  const settings = {
    schoolScheduleEnabled: true,
    schoolStartTime: '13:00',
    schoolEndTime: '18:00'
  };

  assert.equal(getSchoolScheduleBlock(new Date(2026, 9, 30, 12, 59), settings), null);
  assert.equal(getSchoolScheduleBlock(new Date(2026, 9, 30, 13, 0), settings).status, 'blocked_schedule');
  assert.equal(getSchoolScheduleBlock(new Date(2026, 9, 30, 17, 59), settings).status, 'blocked_schedule');
  assert.equal(getSchoolScheduleBlock(new Date(2026, 9, 30, 18, 0), settings), null);
});

test('does not apply the school schedule on Saturday or Sunday', () => {
  const settings = { schoolScheduleEnabled: true, schoolStartTime: '13:00', schoolEndTime: '18:00' };
  assert.equal(getSchoolScheduleBlock(new Date(2026, 9, 31, 15, 0), settings), null);
  assert.equal(getSchoolScheduleBlock(new Date(2026, 10, 1, 15, 0), settings), null);
});

test('detects CK Launcher, Minecraft and Roblox Player, but not Roblox Studio', () => {
  assert.equal(identifyBlockingGame([{ name: 'CKLauncher.exe' }]).id, 'ck-launcher');
  assert.equal(identifyBlockingGame([{ name: 'RobloxPlayerBeta.exe' }]).id, 'roblox-player');
  assert.equal(identifyBlockingGame([{ name: 'Minecraft.Windows.exe' }]).id, 'minecraft');
  assert.equal(identifyBlockingGame([{ name: 'javaw.exe', commandLine: 'javaw net.minecraft.client.main.Main' }]).id, 'minecraft-java');
  assert.equal(identifyBlockingGame([{ name: 'RobloxStudioBeta.exe' }]), null);
});

test('rejects invalid or reversed school hours', () => {
  assert.throws(() => sanitizeExecutionPolicySettings({
    schoolScheduleEnabled: true,
    schoolStartTime: '18:00',
    schoolEndTime: '13:00'
  }), /hora de inicio/i);
  assert.throws(() => sanitizeExecutionPolicySettings({
    schoolStartTime: '25:77',
    schoolEndTime: '18:00'
  }), /horario escolar/i);
});
