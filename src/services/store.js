'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_DATA = Object.freeze({
  settings: {
    startWithWindows: false,
    startupPromptShown: false,
    monitoringEnabled: true,
    checkIntervalMinutes: 5,
    recoveryCheckIntervalMinutes: 1,
    fallbackWaitMinutes: 302,
    schoolScheduleEnabled: true,
    schoolStartTime: '13:00',
    schoolEndTime: '18:00',
    gameProtectionEnabled: true,
    automationEnabled: false,
    conversationId: null,
    conversationVerified: false,
    continuePrompt: 'Continúa con la tarea que quedó pendiente en esta misma conversación. Revisa el contexto anterior, conserva los avances y sigue desde el último punto completado. No comiences un chat nuevo.'
  },
  monitor: {
    lastCheckAt: null,
    claudeRunning: null,
    limitStatus: 'unknown',
    lastLimitCheckAt: null,
    limitCheckMessage: 'Todavía no se ha comprobado el límite.',
    limitCheckError: null,
    limitCheckConfidence: 'unknown',
    claudeMainWindowStatus: 'unknown',
    claudeMainWindowTitle: null,
    lastMainWindowCheckAt: null,
    quickEntryDetected: false,
    taskPending: false,
    recoveryStatus: 'idle',
    recoveryMessage: 'Configura la conversación original para activar la recuperación.',
    limitDetectedAt: null,
    limitResetAt: null,
    nextEligibleAt: null,
    lastRecoveryAttemptAt: null,
    lastContinuationAt: null,
    lastChatOpenedForVerificationAt: null,
    continuationSentForLimit: false
  }
});

class AppStore {
  constructor(userDataPath) {
    this.filePath = path.join(userDataPath, 'autocontinue.json');
    this.logPath = path.join(userDataPath, 'events.ndjson');
    this.data = structuredClone(DEFAULT_DATA);
    this.writeQueue = Promise.resolve();
  }

  async load() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = {
        settings: { ...DEFAULT_DATA.settings, ...(parsed.settings || {}) },
        monitor: { ...DEFAULT_DATA.monitor, ...(parsed.monitor || {}) }
      };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        await this.log('warning', 'No se pudo leer la configuración; se usarán valores seguros.', {
          reason: error.message
        });
      }
      await this.persist();
    }

    return this.snapshot();
  }

  snapshot() {
    return structuredClone(this.data);
  }

  async updateSettings(patch) {
    this.data.settings = { ...this.data.settings, ...patch };
    await this.persist();
    return this.snapshot();
  }

  async updateMonitor(patch) {
    this.data.monitor = { ...this.data.monitor, ...patch };
    await this.persist();
    return this.snapshot();
  }

  async persist() {
    const content = JSON.stringify(this.data, null, 2);
    const temporaryPath = `${this.filePath}.tmp`;

    this.writeQueue = this.writeQueue.then(async () => {
      await fs.writeFile(temporaryPath, content, 'utf8');
      await fs.rename(temporaryPath, this.filePath);
    });

    return this.writeQueue;
  }

  async log(level, message, details = {}) {
    const entry = {
      at: new Date().toISOString(),
      level,
      message,
      details
    };

    await fs.mkdir(path.dirname(this.logPath), { recursive: true });
    await fs.appendFile(this.logPath, `${JSON.stringify(entry)}\n`, 'utf8');
    return entry;
  }

  async readRecentLogs(limit = 30) {
    try {
      const raw = await fs.readFile(this.logPath, 'utf8');
      return raw
        .split('\n')
        .filter(Boolean)
        .slice(-Math.max(1, Math.min(limit, 100)))
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .reverse();
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }
}

module.exports = { AppStore };
