'use strict';

const $ = (id) => document.getElementById(id);

const elements = {
  version: $('version'),
  appStatus: $('app-status'),
  claudeIcon: $('claude-icon'),
  claudeStatus: $('claude-status'),
  claudeDetail: $('claude-detail'),
  mainWindowIcon: $('main-window-icon'),
  mainWindowStatus: $('main-window-status'),
  mainWindowDetail: $('main-window-detail'),
  mainWindowCheck: $('main-window-check'),
  activateMainWindow: $('activate-main-window'),
  conversationId: $('conversation-id'),
  saveConversation: $('save-conversation'),
  openSavedChat: $('open-saved-chat'),
  confirmConversation: $('confirm-conversation'),
  conversationStatus: $('conversation-status'),
  automationToggle: $('automation-toggle'),
  recoveryStatus: $('recovery-status'),
  recoveryDetail: $('recovery-detail'),
  fallbackWait: $('fallback-wait'),
  schoolScheduleToggle: $('school-schedule-toggle'),
  schoolStartTime: $('school-start-time'),
  schoolEndTime: $('school-end-time'),
  gameProtectionToggle: $('game-protection-toggle'),
  recoveryInterval: $('recovery-interval'),
  recoveryCheck: $('recovery-check'),
  limitCheckStatus: $('limit-check-status'),
  limitCheckDetail: $('limit-check-detail'),
  limitCheckError: $('limit-check-error'),
  limitCheckTime: $('limit-check-time'),
  lastCheck: $('last-check'),
  checkNow: $('check-now'),
  monitoringToggle: $('monitoring-toggle'),
  interval: $('interval'),
  startupToggle: $('startup-toggle'),
  startupHint: $('startup-hint'),
  logList: $('log-list'),
  platformNote: $('platform-note'),
  toast: $('toast')
};

let toastTimer = null;

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove('visible'), 2800);
}

function formatDate(value) {
  if (!value) return 'todavía no hay datos';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'sin datos';
  return new Intl.DateTimeFormat('es-SV', {
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: 'short'
  }).format(date);
}

function renderLogs(logs = []) {
  elements.logList.replaceChildren();

  if (!logs.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'Todavía no hay actividad registrada.';
    elements.logList.append(empty);
    return;
  }

  for (const entry of logs.slice(0, 25)) {
    const row = document.createElement('div');
    row.className = 'log-row';

    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = formatDate(entry.at);

    const message = document.createElement('span');
    message.className = 'log-message';
    message.textContent = entry.message || 'Actividad registrada.';

    row.append(time, message);
    elements.logList.append(row);
  }
}

function renderSnapshot(snapshot) {
  if (!snapshot) return;

  const settings = snapshot.settings || {};
  const monitor = snapshot.monitor || {};
  elements.version.textContent = `V${snapshot.appVersion || '1.0.0'} · Beta 4`;
  elements.monitoringToggle.checked = Boolean(settings.monitoringEnabled);
  elements.interval.value = String(settings.checkIntervalMinutes || 5);
  elements.startupToggle.checked = Boolean(
    snapshot.startup ? snapshot.startup.enabled : settings.startWithWindows
  );

  if (snapshot.platform === 'win32') {
    elements.platformNote.textContent = 'Preparado para Windows';
    elements.startupToggle.disabled = false;
    elements.startupHint.textContent = 'La app podrá arrancar en segundo plano al iniciar sesión.';
  } else {
    elements.platformNote.textContent = 'Inicio automático disponible en Windows';
    elements.startupToggle.disabled = true;
    elements.startupHint.textContent = 'Esta opción está disponible en Windows.';
  }

  if (settings.monitoringEnabled) {
    elements.appStatus.classList.add('online');
    elements.appStatus.innerHTML = '<i></i> Vigilancia activa';
  } else {
    elements.appStatus.classList.remove('online');
    elements.appStatus.innerHTML = '<i></i> Vigilancia pausada';
  }

  if (monitor.claudeRunning === true) {
    elements.claudeIcon.textContent = '✓';
    elements.claudeStatus.textContent = 'Claude está abierto';
    elements.claudeDetail.textContent = 'Se detectó el proceso de Claude Desktop en Windows.';
  } else if (monitor.claudeRunning === false) {
    elements.claudeIcon.textContent = '–';
    elements.claudeStatus.textContent = 'Claude está cerrado';
    elements.claudeDetail.textContent = 'No se detectó el proceso de Claude Desktop.';
  } else {
    elements.claudeIcon.textContent = '?';
    elements.claudeStatus.textContent = 'Sin comprobar';
    elements.claudeDetail.textContent = 'Aún no hay un resultado de comprobación.';
  }

  const mainStatus = monitor.claudeMainWindowStatus || 'unknown';
  if (mainStatus === 'focused') {
    elements.mainWindowIcon.textContent = '✓';
    elements.mainWindowStatus.textContent = 'Chat principal activo';
    elements.mainWindowDetail.textContent = monitor.quickEntryDetected
      ? 'Se activó la ventana grande. La ventanita «¿Qué necesitas?» fue ignorada.'
      : 'Se activó la ventana principal de Claude.';
  } else if (mainStatus === 'main_window_not_found') {
    elements.mainWindowIcon.textContent = '!';
    elements.mainWindowStatus.textContent = 'Chat principal no encontrado';
    elements.mainWindowDetail.textContent = monitor.quickEntryDetected
      ? 'Solo se identificó la ventana pequeña. No se escribirá allí.'
      : 'Claude está abierto, pero no se encontró una ventana grande de chat.';
  } else if (mainStatus === 'not_running') {
    elements.mainWindowIcon.textContent = '–';
    elements.mainWindowStatus.textContent = 'Claude está cerrado';
    elements.mainWindowDetail.textContent = 'Abre Claude Desktop y vuelve a probar.';
  } else if (mainStatus === 'focus_failed') {
    elements.mainWindowIcon.textContent = '!';
    elements.mainWindowStatus.textContent = 'No quedó en primer plano';
    elements.mainWindowDetail.textContent = 'Se encontró el chat principal, pero Windows no confirmó el enfoque.';
  } else if (mainStatus === 'error') {
    elements.mainWindowIcon.textContent = '!';
    elements.mainWindowStatus.textContent = 'Error de activación';
    elements.mainWindowDetail.textContent = 'Revisa el registro de actividad para ver el motivo.';
  } else {
    elements.mainWindowIcon.textContent = '↗';
    elements.mainWindowStatus.textContent = 'Sin comprobar';
    elements.mainWindowDetail.textContent = 'Busca y activa la ventana grande del chat, no la ventanita «¿Qué necesitas?».';
  }

  elements.mainWindowCheck.textContent = monitor.lastMainWindowCheckAt
    ? `Último intento: ${formatDate(monitor.lastMainWindowCheckAt)}`
    : 'Todavía no se ha activado';

  if (document.activeElement !== elements.conversationId) {
    elements.conversationId.value = settings.conversationId || '';
  }
  elements.confirmConversation.checked = Boolean(settings.conversationVerified);
  elements.confirmConversation.disabled = !settings.conversationId || !monitor.lastChatOpenedForVerificationAt;
  elements.automationToggle.checked = Boolean(settings.automationEnabled);
  elements.automationToggle.disabled = !settings.conversationId || !settings.conversationVerified;
  elements.fallbackWait.value = String(settings.fallbackWaitMinutes || 302);
  elements.recoveryInterval.value = String(settings.recoveryCheckIntervalMinutes || 1);
  elements.schoolScheduleToggle.checked = settings.schoolScheduleEnabled !== false;
  elements.schoolStartTime.value = settings.schoolStartTime || '13:00';
  elements.schoolEndTime.value = settings.schoolEndTime || '18:00';
  elements.gameProtectionToggle.checked = settings.gameProtectionEnabled !== false;

  if (!settings.conversationId) {
    elements.conversationStatus.textContent = 'Todavía no hay una conversación guardada.';
  } else if (settings.conversationVerified) {
    elements.conversationStatus.textContent = 'Conversación original guardada y confirmada.';
  } else if (monitor.lastChatOpenedForVerificationAt) {
    elements.conversationStatus.textContent = 'El chat se abrió. Comprueba que sea el correcto y marca la casilla de confirmación.';
  } else {
    elements.conversationStatus.textContent = 'ID guardado. Pulsa «Abrir y verificar» para comprobarlo.';
  }

  const recoveryLabels = {
    idle: 'Desactivado',
    needs_confirmation: 'Falta confirmar el chat',
    awaiting_confirmation: 'Esperando confirmación',
    needs_conversation: 'Falta guardar el chat',
    waiting_limit: 'Esperando que se restablezca',
    blocked_schedule: 'Pausado por horario de clases',
    blocked_by_game: 'Esperando que cierres el juego',
    opening_claude: 'Abriendo Claude',
    opening_original_chat: 'Abriendo chat original',
    inspection_unavailable: 'No se pudo comprobar',
    chat_not_ready: 'Chat todavía no preparado',
    sending: 'Enviando continuación',
    continued: 'Continuación enviada',
    manual_review: 'Revisión manual necesaria',
    error: 'Error de recuperación'
  };
  elements.recoveryStatus.textContent = recoveryLabels[monitor.recoveryStatus] || 'Sin estado';
  elements.recoveryDetail.textContent = monitor.recoveryMessage ||
    'Activa AutoContinue después de verificar la conversación original.';

  const limitLabels = {
    detected: 'LÍMITE DETECTADO',
    clear: 'SIN LÍMITE · LISTO PARA ESCRIBIR',
    claude_closed: 'CLAUDE ESTÁ CERRADO',
    unknown: 'NO SE PUDO CONFIRMAR'
  };
  elements.limitCheckStatus.textContent = limitLabels[monitor.limitStatus] || 'Sin comprobar';
  elements.limitCheckDetail.textContent = monitor.limitCheckMessage ||
    'Pulsa «Comprobar estado ahora» para revisar Claude.';
  elements.limitCheckError.textContent = monitor.limitCheckError
    ? `Detalle técnico: ${monitor.limitCheckError}`
    : '';
  elements.limitCheckTime.textContent = `Última comprobación: ${formatDate(monitor.lastLimitCheckAt)}`;

  elements.lastCheck.textContent = `Última revisión: ${formatDate(monitor.lastCheckAt)}`;
  renderLogs(snapshot.logs || []);
}

async function loadSnapshot() {
  try {
    const snapshot = await window.autoContinue.getSnapshot();
    renderSnapshot(snapshot);
  } catch (error) {
    showToast('No se pudo cargar la configuración.');
    console.error(error);
  }
}

elements.activateMainWindow.addEventListener('click', async () => {
  elements.activateMainWindow.disabled = true;
  elements.activateMainWindow.textContent = 'Buscando ventana...';

  try {
    const result = await window.autoContinue.activateClaudeMainWindow();
    renderSnapshot(result);
    showToast(result.mainWindowResult?.message || 'Comprobación terminada.');
  } catch (error) {
    showToast('No se pudo activar el chat principal.');
    console.error(error);
  } finally {
    elements.activateMainWindow.disabled = false;
    elements.activateMainWindow.textContent = 'Abrir chat principal';
  }
});

elements.saveConversation.addEventListener('click', async () => {
  elements.saveConversation.disabled = true;
  try {
    const snapshot = await window.autoContinue.saveConversation(elements.conversationId.value);
    renderSnapshot(snapshot);
    showToast('Conversación guardada. Ahora ábrela y verifícala.');
  } catch (error) {
    showToast(error.message || 'No se pudo guardar la conversación.');
  } finally {
    elements.saveConversation.disabled = false;
  }
});

elements.openSavedChat.addEventListener('click', async () => {
  elements.openSavedChat.disabled = true;
  try {
    const snapshot = await window.autoContinue.openSavedChat();
    renderSnapshot(snapshot);
    showToast('Se abrió el chat guardado. Comprueba que sea el original.');
  } catch (error) {
    showToast(error.message || 'No se pudo abrir el chat guardado.');
  } finally {
    elements.openSavedChat.disabled = false;
  }
});

elements.confirmConversation.addEventListener('change', async () => {
  elements.confirmConversation.disabled = true;
  try {
    const snapshot = await window.autoContinue.setConversationVerified(elements.confirmConversation.checked);
    renderSnapshot(snapshot);
    showToast(elements.confirmConversation.checked
      ? 'Conversación original confirmada.'
      : 'Confirmación retirada.');
  } catch (error) {
    elements.confirmConversation.checked = false;
    showToast(error.message || 'No se pudo confirmar el chat.');
  } finally {
    const snapshot = await window.autoContinue.getSnapshot();
    renderSnapshot(snapshot);
  }
});

elements.automationToggle.addEventListener('change', async () => {
  elements.automationToggle.disabled = true;
  try {
    const snapshot = await window.autoContinue.setAutomation(elements.automationToggle.checked);
    renderSnapshot(snapshot);
    showToast(elements.automationToggle.checked
      ? 'AutoContinue automático activado.'
      : 'AutoContinue automático pausado.');
  } catch (error) {
    elements.automationToggle.checked = false;
    showToast(error.message || 'No se pudo cambiar AutoContinue.');
    const snapshot = await window.autoContinue.getSnapshot();
    renderSnapshot(snapshot);
  }
});

elements.recoveryInterval.addEventListener('change', async () => {
  try {
    const snapshot = await window.autoContinue.setRecoveryInterval(Number(elements.recoveryInterval.value));
    renderSnapshot(snapshot);
    showToast('Frecuencia de detección actualizada.');
  } catch (error) {
    showToast(error.message || 'No se pudo cambiar la frecuencia.');
  }
});

async function saveExecutionPolicy() {
  const settings = {
    schoolScheduleEnabled: elements.schoolScheduleToggle.checked,
    schoolStartTime: elements.schoolStartTime.value,
    schoolEndTime: elements.schoolEndTime.value,
    gameProtectionEnabled: elements.gameProtectionToggle.checked
  };

  try {
    const snapshot = await window.autoContinue.setExecutionPolicy(settings);
    renderSnapshot(snapshot);
    showToast('Reglas inteligentes guardadas.');
  } catch (error) {
    showToast(error.message || 'No se pudieron guardar las reglas.');
    await loadSnapshot();
  }
}

elements.schoolScheduleToggle.addEventListener('change', saveExecutionPolicy);
elements.schoolStartTime.addEventListener('change', saveExecutionPolicy);
elements.schoolEndTime.addEventListener('change', saveExecutionPolicy);
elements.gameProtectionToggle.addEventListener('change', saveExecutionPolicy);

elements.fallbackWait.addEventListener('change', async () => {
  try {
    const snapshot = await window.autoContinue.setFallbackWait(Number(elements.fallbackWait.value));
    renderSnapshot(snapshot);
    showToast('Espera de respaldo actualizada.');
  } catch (error) {
    showToast(error.message || 'No se pudo cambiar la espera.');
  }
});

elements.recoveryCheck.addEventListener('click', async () => {
  elements.recoveryCheck.disabled = true;
  elements.recoveryCheck.textContent = 'Inspeccionando Claude...';
  elements.limitCheckStatus.textContent = 'COMPROBANDO AHORA';
  elements.limitCheckDetail.textContent = 'Leyendo el estado de la ventana principal de Claude. No se enviará ningún mensaje.';
  elements.limitCheckError.textContent = '';

  try {
    const snapshot = await window.autoContinue.inspectLimitNow();
    renderSnapshot(snapshot);
    showToast(snapshot.monitor?.limitCheckMessage || 'Comprobación completada.');
  } catch (error) {
    elements.limitCheckStatus.textContent = 'ERROR DE COMPROBACIÓN';
    elements.limitCheckDetail.textContent = 'No se pudo consultar el estado de Claude.';
    elements.limitCheckError.textContent = error.message || String(error);
    showToast('No se pudo comprobar el límite.');
  } finally {
    elements.recoveryCheck.disabled = false;
    elements.recoveryCheck.textContent = 'Comprobar estado ahora';
  }
});

elements.checkNow.addEventListener('click', async () => {
  elements.checkNow.disabled = true;
  elements.checkNow.textContent = 'Comprobando...';
  try {
    const result = await window.autoContinue.checkNow();
    renderSnapshot(result);
    showToast(result.processCheck?.message || 'Comprobación completada.');
  } catch (error) {
    showToast('Falló la comprobación.');
    console.error(error);
  } finally {
    elements.checkNow.disabled = false;
    elements.checkNow.textContent = 'Comprobar ahora';
  }
});

elements.monitoringToggle.addEventListener('change', async () => {
  elements.monitoringToggle.disabled = true;
  try {
    const snapshot = await window.autoContinue.setMonitoring(elements.monitoringToggle.checked);
    const logs = await window.autoContinue.getSnapshot();
    renderSnapshot({ ...snapshot, ...logs });
    showToast(elements.monitoringToggle.checked ? 'Vigilancia activada.' : 'Vigilancia pausada.');
  } catch (error) {
    showToast('No se pudo cambiar la vigilancia.');
    console.error(error);
  } finally {
    elements.monitoringToggle.disabled = false;
  }
});

elements.interval.addEventListener('change', async () => {
  try {
    const snapshot = await window.autoContinue.setIntervalMinutes(Number(elements.interval.value));
    renderSnapshot({ ...snapshot, logs: (await window.autoContinue.getSnapshot()).logs });
    showToast('Intervalo actualizado.');
  } catch (error) {
    showToast('No se pudo actualizar el intervalo.');
    console.error(error);
  }
});

elements.startupToggle.addEventListener('change', async () => {
  elements.startupToggle.disabled = true;
  try {
    const result = await window.autoContinue.setStartup(elements.startupToggle.checked);
    elements.startupToggle.checked = Boolean(result.startup?.enabled);
    if (result.startup?.error) {
      showToast('Windows no confirmó el cambio.');
    } else {
      showToast(elements.startupToggle.checked
        ? 'Inicio con Windows activado.'
        : 'Inicio con Windows desactivado.');
    }
  } catch (error) {
    elements.startupToggle.checked = !elements.startupToggle.checked;
    showToast('No se pudo cambiar el inicio automático.');
    console.error(error);
  } finally {
    elements.startupToggle.disabled = false;
  }
});

window.autoContinue.onUpdate((payload) => {
  window.autoContinue.getSnapshot()
    .then((fullSnapshot) => renderSnapshot({ ...payload, ...fullSnapshot }))
    .catch(() => renderSnapshot(payload));
});

loadSnapshot();
