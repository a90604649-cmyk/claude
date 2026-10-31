'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { RecoveryController } = require('../src/services/recovery-controller');

const CHAT_ID = '550e8400-e29b-41d4-a716-446655440000';

function createStore({ verified = true, taskPending = false, nextEligibleAt = null, schoolScheduleEnabled = false, gameProtectionEnabled = false } = {}) {
  const data = {
    settings: {
      automationEnabled: true,
      conversationId: CHAT_ID,
      conversationVerified: verified,
      checkIntervalMinutes: 5,
      fallbackWaitMinutes: 300,
      continuePrompt: 'Continúa esta tarea en el chat original.',
      schoolScheduleEnabled,
      schoolStartTime: '13:00',
      schoolEndTime: '18:00',
      gameProtectionEnabled
    },
    monitor: {
      taskPending,
      recoveryStatus: taskPending ? 'waiting_limit' : 'idle',
      recoveryMessage: '',
      limitDetectedAt: null,
      limitResetAt: null,
      nextEligibleAt,
      continuationSentForLimit: false
    }
  };

  return {
    data,
    snapshot() {
      return structuredClone(data);
    },
    async updateSettings(patch) {
      data.settings = { ...data.settings, ...patch };
      return this.snapshot();
    },
    async updateMonitor(patch) {
      data.monitor = { ...data.monitor, ...patch };
      return this.snapshot();
    },
    async persist() {},
    async log() {}
  };
}

test('refuses to enable automation until the original chat is verified', async () => {
  const store = createStore({ verified: false });
  const controller = new RecoveryController({ store });

  await assert.rejects(() => controller.configure(true), /confirma la conversación original/i);
  assert.equal(store.snapshot().settings.automationEnabled, true);
});

test('records a reached usage limit without sending a message', async () => {
  const store = createStore();
  let sent = false;

  const controller = new RecoveryController({
    store,
    inspectLimit: async () => ({
      processRunning: true,
      mainWindowFound: true,
      blocked: true,
      resetAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
    }),
    openConversation: async () => {
      throw new Error('No debe abrir un chat mientras el límite sigue activo.');
    },
    activateMainWindow: async () => null,
    sendMessage: async () => {
      sent = true;
      return { sent: true };
    }
  });

  await controller.tick('test');

  assert.equal(store.snapshot().monitor.taskPending, true);
  assert.equal(store.snapshot().monitor.recoveryStatus, 'waiting_limit');
  assert.equal(sent, false);
});

test('does not send when Claude is not confirmed ready for input', async () => {
  const store = createStore({
    taskPending: true,
    nextEligibleAt: new Date(Date.now() - 1000).toISOString()
  });
  let inspections = 0;
  let sent = false;

  const controller = new RecoveryController({
    store,
    delay: async () => {},
    inspectLimit: async () => {
      inspections += 1;
      return {
        processRunning: true,
        mainWindowFound: true,
        blocked: false,
        composerEnabled: inspections > 1 ? false : true
      };
    },
    openConversation: async () => ({ opened: true }),
    activateMainWindow: async () => ({ status: 'focused', windowHandle: '123' }),
    sendMessage: async () => {
      sent = true;
      return { sent: true };
    }
  });

  await controller.tick('test');

  assert.equal(sent, false);
  assert.equal(store.snapshot().monitor.recoveryStatus, 'chat_not_ready');
});

test('continues only the saved conversation after the limit is gone', async () => {
  const store = createStore({
    taskPending: true,
    nextEligibleAt: new Date(Date.now() - 1000).toISOString()
  });
  const opened = [];
  const sent = [];
  let inspectionCount = 0;

  const controller = new RecoveryController({
    store,
    delay: async () => {},
    inspectLimit: async () => {
      inspectionCount += 1;
      return {
        processRunning: true,
        mainWindowFound: true,
        blocked: false,
        composerEnabled: true
      };
    },
    openConversation: async (id) => {
      opened.push(id);
      return { opened: true };
    },
    activateMainWindow: async () => ({
      status: 'focused',
      windowHandle: '98765'
    }),
    sendMessage: async (handle, message) => {
      sent.push({ handle, message });
      return { sent: true };
    }
  });

  await controller.tick('test');

  assert.deepEqual(opened, [CHAT_ID]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].handle, '98765');
  assert.equal(store.snapshot().monitor.taskPending, false);
  assert.equal(store.snapshot().monitor.recoveryStatus, 'continued');
  assert.equal(inspectionCount, 2);
});

test('keeps Claude closed until the saved wait time has passed', async () => {
  const nextEligibleAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const store = createStore({ taskPending: true, nextEligibleAt });
  let opened = false;

  const controller = new RecoveryController({
    store,
    inspectLimit: async () => ({
      processRunning: false,
      mainWindowFound: false,
      blocked: null
    }),
    openConversation: async () => {
      opened = true;
    }
  });

  await controller.tick('test');

  assert.equal(opened, false);
  assert.equal(store.snapshot().monitor.recoveryStatus, 'waiting_limit');
});


test('does not inspect Claude during configured school hours when a task is pending', async () => {
  const store = createStore({
    taskPending: true,
    schoolScheduleEnabled: true,
    gameProtectionEnabled: true
  });
  let inspected = false;
  let gameScanned = false;
  const controller = new RecoveryController({
    store,
    clock: () => new Date(2026, 9, 30, 15, 0),
    inspectLimit: async () => {
      inspected = true;
      return { processRunning: false, blocked: null };
    },
    detectGame: async () => {
      gameScanned = true;
      return null;
    }
  });

  await controller.tick('test');

  assert.equal(inspected, false);
  assert.equal(gameScanned, false);
  assert.equal(store.snapshot().monitor.recoveryStatus, 'blocked_schedule');
  assert.equal(store.snapshot().monitor.taskPending, true);
});

test('does not inspect or open Claude while SKLauncher is running', async () => {
  const store = createStore({
    taskPending: true,
    gameProtectionEnabled: true
  });
  let inspected = false;
  let opened = false;
  const controller = new RecoveryController({
    store,
    clock: () => new Date(2026, 10, 1, 10, 0),
    inspectLimit: async () => {
      inspected = true;
      return { processRunning: false, blocked: null };
    },
    detectGame: async () => ({
      id: 'sklauncher',
      name: 'SKLauncher',
      processName: 'SKLauncher.exe'
    }),
    openConversation: async () => {
      opened = true;
    }
  });

  await controller.tick('test');

  assert.equal(inspected, false);
  assert.equal(opened, false);
  assert.equal(store.snapshot().monitor.recoveryStatus, 'blocked_by_game');
  assert.equal(store.snapshot().monitor.taskPending, true);
});
