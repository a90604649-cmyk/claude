'use strict';

const { DEFAULT_CONTINUE_PROMPT, extractConversationId } = require('./conversation');
const { detectBlockingGame, getSchoolScheduleBlock } = require('./execution-policy');

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const GAME_RETRY_MS = 5 * 60 * 1000;
const BLOCKED_RETRY_MS = 2 * 60 * 1000;

class RecoveryController {
  constructor({
    store,
    inspectLimit,
    openConversation,
    activateMainWindow,
    sendMessage,
    closeMainWindow = async () => ({ closed: false }),
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
    this.closeMainWindow = closeMainWindow;
    this.onUpdate = onUpdate;
    this.delay = delay;
    this.detectGame = detectGame;
    this.clock = clock;
    this.pollTimer = null;
    this.dueTimer = null;
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

    if (!snapshot.settings.automationEnabled) return;

    await this.store.log('info', 'AutoContinue inició en segundo plano. Esperará 1 minuto antes de su primera evaluación.');
    this.schedule({ initialDelayMs: 60_000, source: 'inicio de Windows' });
  }

  schedule({ initialDelayMs = 0, source = 'automático' } = {}) {
    this.stopTimers();
    const snapshot = this.store.snapshot();
    if (!snapshot.settings.automationEnabled) return;

    if (snapshot.monitor.taskPending === true) {
      this.schedulePendingCheck({ minimumDelayMs: initialDelayMs, source });
      return;
    }

    const beginPolling = () => {
      this.startupTimer = null;
      this.tick(source).catch(() => {});
      this.pollTimer = setInterval(() => {
        this.tick('detección de límite').catch(() => {});
      }, this.intervalMs());
    };

    if (initialDelayMs > 0) {
      this.startupTimer = setTimeout(beginPolling, initialDelayMs);
    } else {
      beginPolling();
    }
  }

  stopTimers() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.dueTimer) {
      clearTimeout(this.dueTimer);
      this.dueTimer = null;
    }
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
  }

  schedulePendingCheck({ minimumDelayMs = 0, source = 'hora programada' } = {}) {
    if (this.dueTimer) {
      clearTimeout(this.dueTimer);
      this.dueTimer = null;
    }
    if (!this.store.snapshot().settings.automationEnabled) return;

    const state = this.store.snapshot().monitor;
    if (state.taskPending !== true) {
      this.schedule();
      return;
    }

    const dueAt = state.nextEligibleAt ? Date.parse(state.nextEligibleAt) : this.clock().getTime();
    const remaining = Number.isFinite(dueAt) ? Math.max(0, dueAt - this.clock().getTime()) : 0;
    const waitMs = Math.max(remaining, Math.max(0, minimumDelayMs));

    this.dueTimer = setTimeout(() => {
      this.dueTimer = null;
      this.tick(source).catch(() => {});
    }, waitMs);
  }

  async onSystemResume() {
    if (!this.store.snapshot().settings.automationEnabled) return;
    await this.store.log('info', 'Windows salió de suspensión. Se evaluarán las reglas dentro de 1 minuto.');
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
      this.stopTimers();
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

  nextSchoolAllowedTime(now, settings) {
    const next = new Date(now);
    const end = String(settings.schoolEndTime || '18:00').split(':').map(Number);
    next.setHours(end[0], end[1], 0, 0);
    return next;
  }

  async deferPending(status, message, dueAt, details = {}) {
    await this.store.updateMonitor({
      nextEligibleAt: dueAt.toISOString(),
      recoveryStatus: status,
      recoveryMessage: message
    });
    await this.store.log('info', message, {
      ...details,
      nextCheckAt: dueAt.toISOString()
    });
    this.emitUpdate();
    this.schedulePendingCheck({ source: status === 'blocked_by_game' ? 'revisión de juego' : 'fin del horario bloqueado' });
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

      // While a limit is pending, do not inspect Claude until the saved five-hour timer expires.
      if (state.monitor.taskPending === true) {
        const nextCheck = state.monitor.nextEligibleAt ? Date.parse(state.monitor.nextEligibleAt) : 0;
        const now = this.clock();
        if (nextCheck && now.getTime() < nextCheck) {
          await this.setStatus(
            'waiting_limit',
            `Claude permanece cerrado. Próxima comprobación programada para ${new Date(nextCheck).toLocaleString()}.`
          );
          this.schedulePendingCheck({ source: 'hora de restablecimiento' });
          return this.store.snapshot();
        }

        const schoolBlock = getSchoolScheduleBlock(now, state.settings);
        if (schoolBlock) {
          await this.applyExecutionBlock(schoolBlock);
          await this.deferPending(
            schoolBlock.status,
            schoolBlock.message,
            this.nextSchoolAllowedTime(now, state.settings),
            { reason: schoolBlock.reason }
          );
          return this.store.snapshot();
        }

        if (state.settings.gameProtectionEnabled !== false) {
          const game = await this.detectGame();
          if (game) {
            const message = `No se ejecutó: ${game.name} está abierto. Se volverá a comprobar en 5 minutos.`;
            await this.applyExecutionBlock({
              status: 'blocked_by_game',
              reason: 'game_active',
              processName: game.processName,
              message
            });
            await this.deferPending('blocked_by_game', message, new Date(now.getTime() + GAME_RETRY_MS), {
              reason: 'game_active',
              processName: game.processName
            });
            return this.store.snapshot();
          }
        }
      }

      let inspection = await this.inspectLimit();

      if (inspection.processRunning === true && inspection.blocked === true) {
        await this.recordLimit(inspection);
        return this.store.snapshot();
      }

      if (inspection.processRunning === null) {
        await this.setStatus('inspection_unavailable', inspection.message || 'No se pudo inspeccionar Claude. No se enviará nada.');
        if (state.monitor.taskPending) {
          await this.deferPending('inspection_unavailable', inspection.message || 'No se pudo inspeccionar Claude. Se reintentará en 2 minutos.', new Date(this.clock().getTime() + BLOCKED_RETRY_MS), { reason: 'inspection_unavailable' });
        }
        return this.store.snapshot();
      }

      if (state.monitor.taskPending !== true) {
        if (inspection.blocked === null && inspection.processRunning !== false) {
          await this.setStatus('inspection_unavailable', inspection.message || 'No se pudo comprobar el estado de Claude.');
        }
        return this.store.snapshot();
      }

      // The five-hour wait has expired and local rules allow a check. Open Claude only now.
      let openedByController = false;
      let conversationAlreadyOpened = false;
      if (inspection.processRunning === false || inspection.mainWindowFound !== true) {
        await this.setStatus('opening_claude', 'Terminó la espera. Abriendo Claude para comprobar el límite una sola vez.');
        openedByController = inspection.processRunning === false;
        await this.openConversation(conversationId);
        conversationAlreadyOpened = true;
        inspection = await this.waitForClaudeWindow();
      }

      if (inspection.blocked === true) {
        if (openedByController) {
          await this.closeMainWindow().catch(() => {});
        }
        await this.recordLimit(inspection);
        return this.store.snapshot();
      }

      if (inspection.blocked !== false) {
        if (openedByController) {
          await this.closeMainWindow().catch(() => {});
        }
        const message = inspection.message || 'No se pudo confirmar si el límite desapareció. No se enviará nada; se reintentará en 2 minutos.';
        await this.deferPending('inspection_unavailable', message, new Date(this.clock().getTime() + BLOCKED_RETRY_MS), {
          reason: 'inspection_unavailable'
        });
        return this.store.snapshot();
      }

      // Re-check the protected applications immediately before opening/focusing the saved chat.
      if (state.settings.gameProtectionEnabled !== false) {
        const game = await this.detectGame();
        if (game) {
          if (openedByController) await this.closeMainWindow().catch(() => {});
          const message = `No se ejecutó: ${game.name} está abierto. Se volverá a comprobar en 5 minutos.`;
          await this.deferPending('blocked_by_game', message, new Date(this.clock().getTime() + GAME_RETRY_MS), {
            reason: 'game_active',
            processName: game.processName
          });
          return this.store.snapshot();
        }
      }

      state = this.store.snapshot();

      if (!conversationAlreadyOpened) {
        await this.setStatus('opening_original_chat', 'Claude está disponible. Abriendo la conversación original guardada.');
        await this.openConversation(conversationId);
      }
      await this.delay(1400);

      const activation = await this.activateMainWindow();
      if (!activation || activation.status !== 'focused') {
        const message = activation?.message || 'No se pudo activar el chat principal.';
        await this.deferPending('chat_not_ready', message, new Date(this.clock().getTime() + BLOCKED_RETRY_MS), {
          reason: 'chat_not_ready'
        });
        return this.store.snapshot();
      }

      const finalInspection = await this.inspectLimit();
      if (finalInspection.blocked === true) {
        await this.recordLimit(finalInspection);
        return this.store.snapshot();
      }

      if (finalInspection.blocked !== false || finalInspection.composerEnabled !== true) {
        const message = 'No se pudo confirmar que el límite desapareció y que el cuadro de mensaje está habilitado. No se escribió nada; se reintentará en 2 minutos.';
        await this.deferPending('chat_not_ready', message, new Date(this.clock().getTime() + BLOCKED_RETRY_MS), {
          reason: 'composer_not_confirmed'
        });
        return this.store.snapshot();
      }

      await this.store.updateMonitor({
        recoveryStatus: 'sending',
        lastRecoveryAttemptAt: this.clock().toISOString(),
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
        lastContinuationAt: this.clock().toISOString(),
        nextEligibleAt: null,
        recoveryMessage: 'La continuación fue enviada a la conversación original.',
        continuationSentForLimit: true
      });
      await this.store.log('info', 'Se envió una continuación a la conversación original.', { source });
      this.emitUpdate();
      this.schedule();
      return this.store.snapshot();
    } catch (error) {
      await this.setStatus('error', error.message);
      await this.store.log('error', 'Falló el ciclo de recuperación.', {
        source,
        reason: error.message
      });
      const current = this.store.snapshot().monitor;
      if (current.taskPending) {
        await this.deferPending('error', error.message, new Date(this.clock().getTime() + BLOCKED_RETRY_MS), {
          reason: 'recovery_error'
        });
      }
      return this.store.snapshot();
    } finally {
      this.running = false;
    }
  }

  async waitForClaudeWindow() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await this.delay(1000);
      const result = await this.inspectLimit();
      if (result.processRunning === true && result.mainWindowFound) return result;
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
    const now = this.clock();
    const detectedAt = current.taskPending && current.limitDetectedAt
      ? current.limitDetectedAt
      : now.toISOString();
    const waitMinutes = Number(this.store.snapshot().settings.fallbackWaitMinutes) || 302;
    const isRetry = current.taskPending === true;
    const nextEligibleAt = new Date(now.getTime() + (isRetry ? 2 : waitMinutes) * 60 * 1000).toISOString();

    await this.store.updateMonitor({
      taskPending: true,
      recoveryStatus: 'waiting_limit',
      limitDetectedAt: detectedAt,
      limitResetAt: inspection.resetAt || current.limitResetAt || null,
      nextEligibleAt,
      continuationSentForLimit: false,
      recoveryMessage: isRetry
        ? `Claude todavía muestra el límite. Se volverá a comprobar en 2 minutos, a las ${new Date(nextEligibleAt).toLocaleTimeString()}.`
        : `Límite detectado a las ${now.toLocaleTimeString()}. Próxima comprobación programada dentro de ${waitMinutes} minutos, a las ${new Date(nextEligibleAt).toLocaleTimeString()}.`
    });

    if (!isRetry || current.recoveryStatus !== 'waiting_limit') {
      await this.store.log(isRetry ? 'warning' : 'warning', isRetry
        ? 'El límite continúa activo después de la comprobación programada.'
        : 'Claude alcanzó un límite. Se guardó la hora exacta y se programó una única comprobación futura.', {
        detectedAt,
        resetAt: inspection.resetAt || null,
        nextEligibleAt,
        waitMinutes: isRetry ? 2 : waitMinutes
      });
    }

    this.emitUpdate();
    this.schedulePendingCheck();
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
    this.stopTimers();
  }
}

module.exports = { RecoveryController };
