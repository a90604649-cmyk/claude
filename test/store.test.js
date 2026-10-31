'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { AppStore } = require('../src/services/store');

async function createTemporaryStore(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-autocontinue-'));
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  const store = new AppStore(directory);
  await store.load();
  return { store, directory };
}

test('loads safe defaults and saves settings across restarts', async (t) => {
  const { store, directory } = await createTemporaryStore(t);

  assert.equal(store.snapshot().settings.monitoringEnabled, true);
  assert.equal(store.snapshot().settings.checkIntervalMinutes, 5);

  await store.updateSettings({
    monitoringEnabled: false,
    checkIntervalMinutes: 10,
    continuePrompt: 'Continúa con la tarea que quedó pendiente en esta misma conversación. Revisa el contexto anterior, conserva los avances y sigue desde el último punto completado. No comiences un chat nuevo.'
  });

  const restartedStore = new AppStore(directory);
  const restored = await restartedStore.load();

  assert.equal(restored.settings.monitoringEnabled, false);
  assert.equal(restored.settings.checkIntervalMinutes, 10);
  assert.equal(restored.settings.startWithWindows, false);
  assert.equal(restored.settings.continuePrompt, 'Continúa.');
});

test('writes and reads recent event records', async (t) => {
  const { store } = await createTemporaryStore(t);

  await store.log('info', 'Prueba de registro local.');
  const entries = await store.readRecentLogs(10);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].level, 'info');
  assert.equal(entries[0].message, 'Prueba de registro local.');
  assert.ok(Number.isFinite(Date.parse(entries[0].at)));
});

test('returns isolated snapshots so callers cannot mutate stored settings', async (t) => {
  const { store } = await createTemporaryStore(t);
  const snapshot = store.snapshot();

  snapshot.settings.monitoringEnabled = false;

  assert.equal(store.snapshot().settings.monitoringEnabled, true);
});


test('keeps a custom continuation message instead of overwriting it during migration', async (t) => {
  const { store, directory } = await createTemporaryStore(t);
  await store.updateSettings({ continuePrompt: 'Sigue desde el último paso.' });

  const restartedStore = new AppStore(directory);
  const restored = await restartedStore.load();

  assert.equal(restored.settings.continuePrompt, 'Sigue desde el último paso.');
});
