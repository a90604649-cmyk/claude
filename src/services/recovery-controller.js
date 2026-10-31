'use strict';

const { DEFAULT_CONTINUE_PROMPT, extractConversationId } = require('./conversation');
const { detectBlockingGame, getSchoolScheduleBlock } = require('./execution-policy');

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class RecoveryController {
  constructor({
    store,
    inspectLimit,
    openConversation,
    activateMainWindow,
    sendMessage,
    onUpdate,
    delay = wait,
    detectGame = detectBlockingGame,
    clock = () => new Date()
  }) {
    this.store = store;
    this.inspectLimit = inspectLimit;
    this.openConversation = openConversation;
    this.activateMainWindow = activateMainWindow;
    this.sendMessage = sendMessage;
    this.onUpdate = onUpdate;
    this.delay = delay;
    this.detectGame = detectGame;
    this.clock = clock;
    this.timer = null;
    this.startupTimer = null;
    this.running = false;
  }

  intervalMs() {
    const minutes = Number(this.store.snapshot().settings.recoveryCheckIntervalMinutes) || 1;
    return Math.max(1, Math.min(minutes, 15)) * 60 * 1000;
  }

  async start() {
    const snapshot = this.store.snapshot();

    if (snapshot.monitor.recoveryStatus === 'sending') {
      await this.store.updateMonitor({
        recoveryStatus: 'manual_review',
        recoveryMessage: 'La aplicación se cerró durante un envío. Revisa Claude antes de reintentar para evitar duplicar el mensaje.'
      });
      await this.store.log('warning', 'Se requiere revisión manual para evitar duplicar una continuación.');
    }

    if (snapshot.settings.automationEnabled) {
      await this.store.log('info', 'AutoContinue inició en segundo plano. La primera evaluación se hará dentro de 1 minuto.');
      this.schedule({ initialDelayMs: 60_000, source: 'inicio de Windows' });
    }
  }

  schedule({ initialDelayMs = 0, source = 'automático' } = {}) {
    this.stopTimer();
    if (!this.store.snapshot().settings.automationEnabled) return;

    const begin = () => {
      this.startupTimer = null;
      this.tick(source).catch(() => {});
      this.timer = setInterval(() => {
        this.tick('automático').catch(() => {});
      }, this.intervalMs());
    };

    if (initialDelayMs > 0) {
      this.startupTimer = setTimeout(begin, initialDelayMs);
    } else {
      this.timer = setInterval(() => {
        this.tick('automático').catch(() => {});
      }, this.intervalMs());
    }
  }

  stopTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
  }

  async onSystemResume() {
    if (!this.store.snapshot().settings.automationEnabled) return;
    await this.store.log('info', 'Windows salió de suspensión. La comprobación se realizará dentro de 1 minuto.');
    this.schedule({ initialDelayMs: 60_000, source: 'reactivación de Windows' });
  }

  async configure(enabled) {
    const snapshot = this.store.snapshot();
    if (enabled && (!snapshot.settings.conversationId || !snapshot.settings.conversationVerified)) {
      throw new Error('Primero guarda y confirma la conversación original.');
    }

    await this.store.updateSettings({ automationEnabled: Boolean(enabled) });
    await this.store.log('info', enabled
      ? 'AutoContinue automático activado para la conversación guardada.'
      : 'AutoContinue automático pausado.');

    if (enabled) {
      this.schedule();
      await this.tick('activación');
    } else {
      this.stopTimer();
    }

    return this.store.snapshot();
  }

  async applyExecutionBlock(block) {
    const current = this.store.snapshot().monitor;
    if (current.recoveryStatus !== block.status || current.recoveryMessage !== block.message) {
      await this.setStatus(block.status, block.message);
      await this.store.log('info', block.message, {
        reason: block.reason,
        localTime: block.localTime || this.clock().toLocaleString(),
        processName: block.processName || null
      });
    }
  }

  async tick(source = 'manual') {
    if (this.running) return this.store.snapshot();

    const snapshot = this.store.snapshot();
    if (!snapshot.settings.automationEnabled) return snapshot;

    const conversationId = extractConversationId(snapshot.settings.conversationId);
    if (!conversationId || !snapshot.settings.conversationVerified) {
      await this.setStatus('needs_conversation', 'Guarda y confirma la conversación original antes de continuar.');
      return this.store.snapshot();
    }

    if (snapshot.monitor.recoveryStatus === 'manual_review') {
      return this.store.snapshot();
    }

    this.running = true;
    try {
      let state = this.store.snapshot();
      const inspection = await this.inspectLimit();

      // Always record an active limit as soon as it is visible, even during class hours or a game.
      if (inspection.processRunning === true && inspection.blocked === true) {
        await this.recordLimit(inspection);
        return this.store.snapshot();
      }

      if (inspection.processRunning === null) {
        await this.setStatus('inspection_unavailable', inspection.message || 'No se pudo inspeccionar Claude. No se enviará nada.');
        return this.store.snapshot();
      }

      if (state.monitor.taskPending !== true) {
        if (inspection.blocked === null && inspection.processRunning !== false) {
          await this.setStatus('inspection_unavailable', inspection.message || 'No se pudo comprobar el estado de Claude.');
        }
        return this.store.snapshot();
      }

      // School hours take priority over every other rule. No chat is opened during this block.
      const schoolBlock = getSchoolScheduleBlock(this.clock(), state.settings);
      if (schoolBlock) {
        await this.applyExecutionBlock(schoolBlock);
        return this.store.snapshot();
      }

      const now = this.clock().getTime();
      const eligibleAt = state.monitor.nextEligibleAt
        ? Date.parse(state.monitor.nextEligibleAt)
        : 0;

      // When Claude is closed, wait for the stored reset time without opening it early.
      if (inspection.processRunning === false && eligibleAt && now < eligibleAt) {
        await this.setStatus(
          'waiting_limit',
          `Claude está cerrado. Próxima evaluación después de ${new Date(eligibleAt).toLocaleString()}.`
        );
        return this.store.snapshot();
      }

      // Only inspect game processes when a continuation could actually be attempted.
      if (state.settings.gameProtectionEnabled !== false) {
        const game = await this.detectGame();
        if (game) {
          await this.applyExecutionBlock({
            status: 'blocked_by_game',
            reason: 'game_active',
            processName: game.processName,
            message: `No se ejecutó: ${game.name} está abierto. AutoContinue esperará a que cierres el juego.`
          });
          return this.store.snapshot();
        }
      }

      let readyInspection = inspection;
      if (inspection.processRunning === false || inspection.mainWindowFound !== true) {
        await this.setStatus('opening_claude', 'La hora de espera terminó. Se comprobará Claude para confirmar que el límite desapareció.');
        await this.openConversation(conversationId);
        readyInspection = await this.waitForClaudeWindow();
      } else if (inspection.blocked === null) {
        await this.setStatus('inspection_unavailable', inspection.message || 'No se pudo leer el estado de Claude. No se enviará nada.');
        return this.store.snapshot();
      }

      if (readyInspection.blocked === true) {
        await this.recordLimit(readyInspection);
        return this.store.snapshot();
      }

      if (readyInspection.blocked !== false) {
        await this.setStatus('inspection_unavailable', 'No se pudo confirmar que Claude esté disponible. No se enviará nada.');
        return this.store.snapshot();
      }

      // Re-check game protection immediately before taking focus from the user's desktop.
      if (state.settings.gameProtectionEnabled !== false) {
        const game = await this.detectGame();
        if (game) {
          await this.applyExecutionBlock({
            status: 'blocked_by_game',
            reason: 'game_active',
            processName: game.processName,
            message: `No se ejecutó: ${game.name} está abierto. AutoContinue esperará a que cierres el juego.`
          });
          return this.store.snapshot();
        }
      }

      state = this.store.snapshot();

      await this.setStatus('opening_original_chat', 'Claude está disponible. Abriendo la conversación original guardada.');
      await this.openConversation(conversationId);
      await this.delay(1400);

      const activation = await this.activateMainWindow();
      if (!activation || activation.status !== 'focused') {
        await this.setStatus('chat_not_ready', activation?.message || 'No se pudo activar el chat principal.');
        return this.store.snapshot();
      }

      const finalInspection = await this.inspectLimit();
      if (finalInspection.blocked === true) {
        await this.recordLimit(finalInspection);
        return this.store.snapshot();
      }

      if (finalInspection.blocked !== false || finalInspection.composerEnabled !== true) {
        await this.setStatus(
          'chat_not_ready',
          'No se pudo confirmar que el límite desapareció y que el cuadro de mensaje está habilitado. No se escribió nada.'
        );
        return this.store.snapshot();
      }

      await this.store.updateMonitor({
        recoveryStatus: 'sending',
        lastRecoveryAttemptAt: new Date().toISOString(),
        recoveryMessage: 'Preparando una única continuación en la conversación verificada.'
      });
      await this.store.persist();

      const prompt = String(state.settings.continuePrompt || DEFAULT_CONTINUE_PROMPT);
      const sent = await this.sendMessage(activation.windowHandle, prompt);

      if (!sent || sent.sent !== true) {
        await this.setStatus(
          'manual_review',
          sent?.message || 'No se pudo confirmar el envío. Revisa Claude antes de volver a intentarlo.'
        );
        await this.store.log('warning', 'El envío automático no fue confirmado; se pausó para evitar duplicados.', {
          source,
          status: sent?.status || 'unknown'
        });
        return this.store.snapshot();
      }

      await this.store.updateMonitor({
        recoveryStatus: 'continued',
        taskPending: false,
        limitDetectedAt: null,
        limitResetAt: null,
        lastContinuationAt: new Date().toISOString(),
        nextEligibleAt: null,
        recoveryMessage: 'La continuación fue enviada a la conversación original.',
        continuationSentForLimit: true
      });
      await this.store.log('info', 'Se envió una continuación a la conversación original.', { source });
      this.emitUpdate();
      return this.store.snapshot();
    } catch (error) {
      await this.setStatus('error', error.message);
      await this.store.log('error', 'Falló el ciclo de recuperación.', {
        source,
        reason: error.message
      });
      return this.store.snapshot();
    } finally {
      this.running = false;
    }
  }

  async waitForClaudeWindow() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await this.delay(1000);
      const result = await this.inspectLimit();
      if (result.processRunning === true && result.mainWindowFound) {
        return result;
      }
    }

    return {
      processRunning: false,
      blocked: null,
      composerEnabled: false,
      message: 'Claude no terminó de abrir dentro del tiempo de comprobación.'
    };
  }

  async recordLimit(inspection) {
    const current = this.store.snapshot().monitor;
    const detectedAt = current.limitDetectedAt || this.clock().toISOString();
    const fallbackMinutes = Number(this.store.snapshot().settings.fallbackWaitMinutes) || 300;
    const nextEligibleAt = inspection.resetAt
      || current.nextEligibleAt
      || new Date(Date.parse(detectedAt) + fallbackMinutes * 60 * 1000).toISOString();

    await this.store.updateMonitor({
      taskPending: true,
      recoveryStatus: 'waiting_limit',
      limitDetectedAt: detectedAt,
      limitResetAt: inspection.resetAt || current.limitResetAt || null,
      nextEligibleAt,
      continuationSentForLimit: false,
      recoveryMessage: inspection.resetAt
        ? `Claude indicó que el límite se restablece a ${new Date(inspection.resetAt).toLocaleString()}.`
        : `No se pudo leer la hora del aviso. Se usará una espera conservadora de ${fallbackMinutes} minutos y se volverá a comprobar el estado real.`
    });

    if (current.recoveryStatus !== 'waiting_limit') {
      await this.store.log('warning', 'Claude alcanzó un límite de uso. La tarea quedó guardada para reanudarse más tarde.', {
        resetAt: inspection.resetAt || null,
        nextEligibleAt
      });
    }
    this.emitUpdate();
  }

  async setStatus(status, message) {
    const current = this.store.snapshot().monitor;
    if (current.recoveryStatus === status && current.recoveryMessage === message) return;
    await this.store.updateMonitor({
      recoveryStatus: status,
      recoveryMessage: message
    });
    this.emitUpdate();
  }

  emitUpdate() {
    if (this.onUpdate) this.onUpdate(this.store.snapshot());
  }

  dispose() {
    this.stopTimer();
  }
}

module.exports = { RecoveryController };
