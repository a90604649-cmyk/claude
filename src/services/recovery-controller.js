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
    scheduleWake = async () => ({ scheduled: false }),
    cancelWake = async () => ({ removed: false }),
    waitForGamesToClose = async () => ({ started: false }),
    onIdleWait = null,
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
    this.scheduleWake = scheduleWake;
    this.cancelWake = cancelWake;
    this.waitForGamesToClose = waitForGamesToClose;
    this.onIdleWait = onIdleWait;
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

  async start({ scheduledCheck = false } = {}) {
    const snapshot = this.store.snapshot();

    if (snapshot.monitor.recoveryStatus === 'sending') {
      await this.store.updateMonitor({
        recoveryStatus: 'manual_review',
        recoveryMessage: 'La aplicación se cerró durante un envío. Revisa Claude antes de reintentar para evitar duplicar el mensaje.'
      });
      await this.store.log('warning', 'Se requiere revisión manual para evitar duplicar una continuación.');
    }

    if (!snapshot.settings.automationEnabled) return;

    const initialDelayMs = scheduledCheck ? 0 : 60_000;
    await this.store.log('info', scheduledCheck
      ? 'Windows inició la comprobación programada.'
      : 'AutoContinue inició en segundo plano. Programará una evaluación dentro de 1 minuto.');
    await this.schedule({
      initialDelayMs,
      source: scheduledCheck ? 'comprobación programada de Windows' : 'inicio de Windows'
    });
  }

  async schedule({ initialDelayMs = 0, source = 'automático' } = {}) {
    this.stopTimers();
    const snapshot = this.store.snapshot();
    if (!snapshot.settings.automationEnabled) return;

    if (snapshot.monitor.taskPending === true) {
      await this.schedulePendingCheck({ minimumDelayMs: initialDelayMs, source });
      return;
    }

    try {
      await this.cancelWake();
    } catch (error) {
      await this.store.log('warning', 'No se pudo retirar una tarea de recuperación anterior.', { reason: error.message });
    }

    const beginPolling = () => {
      this.startupTimer = null;
      this.tick(source).catch(() => {});
      this.pollTimer = setInterval(() => {
        this.tick('detección de límite').catch(() => {});
      }, this.intervalMs());
      this.pollTimer.unref?.();
    };

    if (initialDelayMs > 0) {
      this.startupTimer = setTimeout(beginPolling, initialDelayMs);
      this.startupTimer.unref?.();
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

  async schedulePendingCheck({ minimumDelayMs = 0, source = 'hora programada' } = {}) {
    if (this.dueTimer) {
      clearTimeout(this.dueTimer);
      this.dueTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (!this.store.snapshot().settings.automationEnabled) return;

    const state = this.store.snapshot().monitor;
    if (state.taskPending !== true) {
      await this.schedule();
      return;
    }

    const dueAt = state.nextEligibleAt ? Date.parse(state.nextEligibleAt) : this.clock().getTime();
    const remaining = Number.isFinite(dueAt) ? Math.max(0, dueAt - this.clock().getTime()) : 0;
    const waitMs = Math.max(remaining, Math.max(0, minimumDelayMs));
    const actualDueAt = new Date(this.clock().getTime() + waitMs);

    // A Windows one-shot task allows Electron to exit entirely during long waits.
    if (waitMs > 1000) {
      try {
        const scheduled = await this.scheduleWake(actualDueAt);
        if (scheduled?.scheduled === true) {
          await this.store.log('info', 'Windows programó el siguiente intento. AutoContinue se cerrará para no ocupar memoria durante la espera.', {
            dueAt: actualDueAt.toISOString(),
            taskName: scheduled.taskName || null
          });
          this.emitUpdate();
          if (this.onIdleWait) await this.onIdleWait({ dueAt: actualDueAt, source });
          return;
        }
      } catch (error) {
        await this.store.log('warning', 'No se pudo crear la tarea de Windows; AutoContinue esperará con un temporizador local.', {
          reason: error.message,
          dueAt: actualDueAt.toISOString()
        });
      }
    }

    // Fallback only: no repeated polling, just one local timer if Task Scheduler is unavailable.
    this.dueTimer = setTimeout(() => {
      this.dueTimer = null;
      this.tick(source).catch(() => {});
    }, waitMs);
    this.dueTimer.unref?.();
  }

  async onSystemResume() {
    if (!this.store.snapshot().settings.automationEnabled) return;
    await this.store.log('info', 'Windows salió de suspensión. Se evaluarán las reglas dentro de 1 minuto.');
    await this.schedule({ initialDelayMs: 60_000, source: 'reactivación de Windows' });
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
      if (this.store.snapshot().monitor.taskPending === true) {
        await this.schedule();
      } else {
        await this.tick('activación');
        if (!this.store.snapshot().monitor.taskPending) await this.schedule();
      }
    } else {
      this.stopTimers();
      try {
        await this.cancelWake();
      } catch (error) {
        await this.store.log('warning', 'No se pudo cancelar la tarea programada de Windows.', { reason: error.message });
      }
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
    await this.schedulePendingCheck({
      source: status === 'blocked_by_game' ? 'revisión de juego' : 'fin del horario bloqueado'
    });
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
          await this.schedulePendingCheck({ source: 'hora de restablecimiento' });
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
            const message = `Claude ya está disponible, pero ${game.name} sigue abierto. AutoContinue esperará el cierre de ese juego y continuará inmediatamente después.`;
            await this.applyExecutionBlock({
              status: 'blocked_by_game',
              reason: 'game_active',
              processName: game.processName,
              message
            });

            const watcher = await this.waitForGamesToClose();
            if (watcher?.started === true) {
              await this.store.log('info', 'Windows está esperando el evento de cierre de SKLauncher, Minecraft o Roblox Player. No habrá revisiones periódicas.', {
                game: game.name,
                processName: game.processName
              });
              this.emitUpdate();
              if (this.onIdleWait) await this.onIdleWait({ reason: 'waiting_for_game_exit', game: game.name });
              return this.store.snapshot();
            }

            const fallbackMessage = 'No se pudo iniciar la vigilancia por evento de cierre del juego. Se intentará otra vez dentro de 1 minuto.';
            await this.deferPending('blocked_by_game', fallbackMessage, new Date(now.getTime() + 60_000), {
              reason: 'game_watcher_unavailable',
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
        const message = inspection.message || 'No se pudo inspeccionar Claude. No se enviará nada.';
        await this.setStatus('inspection_unavailable', message);
        if (state.monitor.taskPending) {
          await this.deferPending('inspection_unavailable', message, new Date(this.clock().getTime() + BLOCKED_RETRY_MS), {
            reason: 'inspection_unavailable'
          });
        }
        return this.store.snapshot();
      }

      if (state.monitor.taskPending !== true) {
        if (inspection.blocked === null && inspection.processRunning !== false) {
          await this.setStatus('inspection_unavailable', inspection.message || 'No se pudo comprobar el estado de Claude.');
        }
        return this.store.snapshot();
      }

      // The wait is over and local rules allow a single check. Open Claude only now.
      let openedByController = false;
      let conversationAlreadyOpened = false;
      if (inspection.processRunning === false || inspection.mainWindowFound !== true) {
        await this.setStatus('opening_claude', 'Terminó la espera. Abriendo Claude para comprobar el límite.');
        openedByController = inspection.processRunning === false;
        await this.openConversation(conversationId);
        conversationAlreadyOpened = true;
        inspection = await this.waitForClaudeWindow();
      }

      if (inspection.blocked === true) {
        if (openedByController) await this.closeMainWindow().catch(() => {});
        await this.recordLimit(inspection);
        return this.store.snapshot();
      }

      if (inspection.blocked !== false) {
        if (openedByController) await this.closeMainWindow().catch(() => {});
        const message = inspection.message || 'No se pudo confirmar si el límite desapareció. Se reintentará en 2 minutos.';
        await this.deferPending('inspection_unavailable', message, new Date(this.clock().getTime() + BLOCKED_RETRY_MS), {
          reason: 'inspection_unavailable'
        });
        return this.store.snapshot();
      }

      // Check again immediately before focusing Claude. If a game launched during
      // Claude's availability check, wait for its process-stop event, not a timer.
      if (state.settings.gameProtectionEnabled !== false) {
        const game = await this.detectGame();
        if (game) {
          if (openedByController) await this.closeMainWindow().catch(() => {});
          const message = `No se ejecutó: ${game.name} está abierto. AutoContinue esperará su cierre.`;
          await this.applyExecutionBlock({
            status: 'blocked_by_game',
            reason: 'game_active',
            processName: game.processName,
            message
          });
          const watcher = await this.waitForGamesToClose();
          if (watcher?.started === true) {
            await this.store.log('info', 'Windows está esperando el cierre del juego para continuar inmediatamente.', {
              game: game.name,
              processName: game.processName
            });
            this.emitUpdate();
            if (this.onIdleWait) await this.onIdleWait({ reason: 'waiting_for_game_exit', game: game.name });
            return this.store.snapshot();
          }
          await this.deferPending('blocked_by_game', 'No se pudo iniciar la vigilancia del juego. Se intentará otra vez dentro de 1 minuto.', new Date(this.clock().getTime() + 60_000), {
            reason: 'game_watcher_unavailable',
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
      await this.schedule();
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
      await this.store.log('warning', isRetry
        ? 'El límite continúa activo después de la comprobación programada.'
        : 'Claude alcanzó un límite. Se guardó la hora exacta y se programó una única comprobación futura.', {
        detectedAt,
        resetAt: inspection.resetAt || null,
        nextEligibleAt,
        waitMinutes: isRetry ? 2 : waitMinutes
      });
    }

    this.emitUpdate();
    await this.schedulePendingCheck();
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
