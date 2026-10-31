'use strict';

const { checkClaudeProcess } = require('./claude-monitor');

class MonitorScheduler {
  constructor({ store, onUpdate }) {
    this.store = store;
    this.onUpdate = onUpdate;
    this.timer = null;
    this.runningCheck = false;
  }

  async start() {
    const snapshot = this.store.snapshot();
    if (snapshot.settings.monitoringEnabled) {
      await this.checkNow('inicio');
      this.schedule(snapshot.settings.checkIntervalMinutes);
    }
  }

  schedule(minutes) {
    this.stopTimer();
    const safeMinutes = Math.max(1, Math.min(Number(minutes) || 5, 60));
    this.timer = setInterval(() => {
      this.checkNow('automático').catch(() => {});
    }, safeMinutes * 60 * 1000);
  }

  stopTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async setEnabled(enabled) {
    await this.store.updateSettings({ monitoringEnabled: Boolean(enabled) });
    if (enabled) {
      await this.checkNow('activación');
      this.schedule(this.store.snapshot().settings.checkIntervalMinutes);
    } else {
      this.stopTimer();
    }
    return this.store.snapshot();
  }

  async setIntervalMinutes(minutes) {
    const value = Math.max(1, Math.min(Number(minutes) || 5, 60));
    await this.store.updateSettings({ checkIntervalMinutes: value });
    if (this.store.snapshot().settings.monitoringEnabled) {
      this.schedule(value);
    }
    return this.store.snapshot();
  }

  async checkNow(source = 'manual') {
    if (this.runningCheck) {
      return this.store.snapshot();
    }

    this.runningCheck = true;
    try {
      const result = await checkClaudeProcess();
      const previous = this.store.snapshot().monitor.claudeRunning;

      await this.store.updateMonitor({
        lastCheckAt: result.checkedAt,
        claudeRunning: result.running
      });

      if (previous !== result.running) {
        await this.store.log('info', result.message, { source, running: result.running });
      }

      const payload = {
        ...this.store.snapshot(),
        processCheck: result
      };

      if (this.onUpdate) this.onUpdate(payload);
      return payload;
    } finally {
      this.runningCheck = false;
    }
  }

  dispose() {
    this.stopTimer();
  }
}

module.exports = { MonitorScheduler };
